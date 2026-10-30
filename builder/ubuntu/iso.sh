#!/usr/bin/env bash
# Runs inside the pinned ubuntu:24.04 toolchain container. Builds a Casper live ISO:
# debootstrap rootfs -> SquashFS -> GRUB (BIOS + UEFI) -> xorriso via grub-mkrescue.
set -euo pipefail
# shellcheck source=../lib/common.sh
source /builder/lib/common.sh

work=${1:?usage: iso.sh WORKDIR}
env_file=$work/build.env
host=$(read_env_value HOSTNAME "$env_file")
profile=$(read_env_value PROFILE "$env_file")
recommends=$(read_env_value APT_RECOMMENDS "$env_file")
mirror=$(read_env_value MIRROR "$env_file")
name=$(read_env_value IMAGE_LABEL "$env_file")
[[ $host =~ $HOSTNAME_RE ]] || die "invalid hostname"
[[ $profile == minimal || $profile == xfce ]] || die "invalid profile"
[[ $recommends == true || $recommends == false ]] || die "invalid APT_RECOMMENDS"
[[ $name =~ ^[A-Za-z0-9][A-Za-z0-9\ ._()+-]{0,63}$ ]] || die "invalid image label"
validate_package_list "$work/packages.iso.list"

log "installing rootfs toolchain"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  debootstrap squashfs-tools xorriso grub-pc-bin grub-efi-amd64-bin grub-common \
  mtools dosfstools ca-certificates ubuntu-keyring >/dev/null
dpkg-query -W -f='${Package}\t${Version}\n' debootstrap squashfs-tools xorriso grub-common >"$work/out/iso-toolchain.tsv"

root=$work/ubuntu
chroot_dir=$root/chroot
iso_dir=$root/iso
rm -rf "$root"
mkdir -p "$chroot_dir" "$iso_dir/casper" "$iso_dir/boot/grub" "$iso_dir/.disk"

mounted=()
cleanup() {
  local i
  for ((i = ${#mounted[@]} - 1; i >= 0; i--)); do
    umount -l "${mounted[i]}" 2>/dev/null || true
  done
}
trap cleanup EXIT
bind() {
  mount --bind "$1" "$2"
  mounted+=("$2")
}
in_chroot() { chroot "$chroot_dir" env DEBIAN_FRONTEND=noninteractive LC_ALL=C "$@"; }

log "bootstrapping Ubuntu 24.04 rootfs"
debootstrap --arch=amd64 --variant=minbase --components=main,universe noble "$chroot_dir" "$mirror"

mount -t proc proc "$chroot_dir/proc" && mounted+=("$chroot_dir/proc")
mount -t sysfs sysfs "$chroot_dir/sys" && mounted+=("$chroot_dir/sys")
bind /dev "$chroot_dir/dev"
bind /dev/pts "$chroot_dir/dev/pts"

rm -f "$chroot_dir/etc/apt/sources.list"
install -D -m 0644 /builder/sources/ubuntu.sources "$chroot_dir/etc/apt/sources.list.d/ubuntu.sources"
# Services must not start inside the build chroot.
printf '#!/bin/sh\nexit 101\n' >"$chroot_dir/usr/sbin/policy-rc.d"
chmod 0755 "$chroot_dir/usr/sbin/policy-rc.d"

# Casper reads the live hostname and user from casper.conf inside the initramfs, so write it before packages install.
install -D -m 0644 /dev/stdin "$chroot_dir/etc/casper.conf" <<CONF
export USERNAME="user"
export USERFULLNAME="Live session user"
export HOST="$host"
export BUILD_SYSTEM="Ubuntu"
export FLAVOUR="LinxGen"
CONF

# casper.conf above is already in place when casper installs. Without these options dpkg asks whether to keep it,
# finds no answer on stdin and fails the install; keeping the existing file is the intended answer.
apt_flags=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
[[ $recommends == true ]] || apt_flags+=(--no-install-recommends)
in_chroot apt-get update -q
log "installing $(wc -l <"$work/packages.iso.list") packages"
xargs -a "$work/packages.iso.list" -r chroot "$chroot_dir" env DEBIAN_FRONTEND=noninteractive LC_ALL=C \
  apt-get install "${apt_flags[@]}" --

install -D -m 0755 /builder/rootfs/boot-marker.sh "$chroot_dir/usr/local/lib/linxgen/boot-marker.sh"
install -D -m 0755 /builder/rootfs/configure.sh "$chroot_dir/usr/local/lib/linxgen/configure.sh"
install -D -m 0644 /builder/rootfs/linxgen-boot-ok.service "$chroot_dir/etc/systemd/system/linxgen-boot-ok.service"
install -D -m 0644 "$env_file" "$chroot_dir/etc/linxgen/build.env"
printf '%s\n' "$profile" >"$chroot_dir/etc/linxgen/profile"
in_chroot /usr/local/lib/linxgen/configure.sh /etc/linxgen/build.env
in_chroot systemctl enable linxgen-boot-ok.service
if [[ $profile == xfce ]]; then
  in_chroot systemctl set-default graphical.target
else
  in_chroot systemctl set-default multi-user.target
fi
in_chroot update-initramfs -u -k all

# shellcheck disable=SC2016 # dpkg-query format string, not shell
in_chroot dpkg-query -W -f='${Package}\t${Version}\n' >"$work/out/iso-packages.tsv"
in_chroot apt-get clean
rm -rf "$chroot_dir/var/lib/apt/lists/"* "$chroot_dir/usr/sbin/policy-rc.d" "$chroot_dir/tmp/"*
cleanup
mounted=()

kernel=$(readlink -f "$chroot_dir/boot/vmlinuz")
initrd=$(readlink -f "$chroot_dir/boot/initrd.img")
[[ -f $kernel && -f $initrd ]] || die "kernel or initrd missing from rootfs"
cp "$kernel" "$iso_dir/casper/vmlinuz"
cp "$initrd" "$iso_dir/casper/initrd"
cp "$work/out/iso-packages.tsv" "$iso_dir/casper/filesystem.manifest"

log "creating SquashFS"
mksquashfs "$chroot_dir" "$iso_dir/casper/filesystem.squashfs" -comp xz -noappend -no-progress -e boot/efi
du -sx --block-size=1 "$chroot_dir" | cut -f1 >"$iso_dir/casper/filesystem.size"
printf 'LinxGen %s - Ubuntu 24.04 LTS amd64\n' "$name" >"$iso_dir/.disk/info"

cat >"$iso_dir/boot/grub/grub.cfg" <<'GRUB'
serial --unit=0 --speed=115200
terminal_input console serial
terminal_output console serial
set timeout=3
set default=0
menuentry "LinxGen live session" {
  linux /casper/vmlinuz boot=casper console=tty0 console=ttyS0,115200n8 ---
  initrd /casper/initrd
}
GRUB

log "creating hybrid ISO"
grub-mkrescue -o "$work/out/linxgen.iso" "$iso_dir" -- -volid LINXGEN
rm -rf "$root"
