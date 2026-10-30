#!/usr/bin/env bash
# Runs inside the pinned debian:trixie toolchain container. Builds a hybrid BIOS/UEFI live ISO with live-build.
set -euo pipefail
# shellcheck source=../lib/common.sh
source /builder/lib/common.sh

work=${1:?usage: iso.sh WORKDIR}
env_file=$work/build.env
host=$(read_env_value HOSTNAME "$env_file")
tz=$(read_env_value TIMEZONE "$env_file")
loc=$(read_env_value LOCALE "$env_file")
profile=$(read_env_value PROFILE "$env_file")
recommends=$(read_env_value APT_RECOMMENDS "$env_file")
mirror=$(read_env_value MIRROR "$env_file")
security_mirror=$(read_env_value SECURITY_MIRROR "$env_file")
[[ $host =~ $HOSTNAME_RE ]] || die "invalid hostname"
[[ $tz =~ $TIMEZONE_RE ]] || die "invalid timezone"
[[ $loc =~ $LOCALE_RE ]] || die "invalid locale"
[[ $profile == minimal || $profile == xfce ]] || die "invalid profile"
[[ $recommends == true || $recommends == false ]] || die "invalid APT_RECOMMENDS"
validate_package_list "$work/packages.iso.list"

log "installing live-build toolchain"
apt-get update -q
apt-get install -y -q --no-install-recommends \
  live-build debootstrap squashfs-tools xorriso grub-pc-bin grub-efi-amd64-bin grub-common \
  mtools dosfstools cpio ca-certificates debian-archive-keyring >/dev/null
dpkg-query -W -f='${Package}\t${Version}\n' live-build debootstrap squashfs-tools xorriso grub-common >"$work/out/iso-toolchain.tsv"

lb_dir=$work/lb
rm -rf "$lb_dir"
mkdir -p "$lb_dir"
cd "$lb_dir"

boot_params="boot=live components console=tty0 console=ttyS0,115200n8 hostname=$host username=user locales=$loc timezone=$tz"

lb config \
  --mode debian \
  --distribution trixie \
  --architecture amd64 \
  --archive-areas main \
  --binary-images iso-hybrid \
  --bootloaders grub-pc,grub-efi \
  --uefi-secure-boot disable \
  --debian-installer none \
  --memtest none \
  --firmware-binary false \
  --firmware-chroot false \
  --security true \
  --updates true \
  --apt-recommends "$recommends" \
  --cache false \
  --linux-flavours amd64 \
  --mirror-bootstrap "$mirror" \
  --mirror-chroot "$mirror" \
  --mirror-binary "$mirror" \
  --mirror-chroot-security "$security_mirror" \
  --mirror-binary-security "$security_mirror" \
  --iso-application LinxGen \
  --iso-volume LINXGEN \
  --image-name linxgen \
  --bootappend-live "$boot_params"

cp "$work/packages.iso.list" config/package-lists/linxgen.list.chroot

inc=config/includes.chroot
install -D -m 0755 /builder/rootfs/boot-marker.sh "$inc/usr/local/lib/linxgen/boot-marker.sh"
install -D -m 0755 /builder/rootfs/configure.sh "$inc/usr/local/lib/linxgen/configure.sh"
install -D -m 0644 /builder/rootfs/linxgen-boot-ok.service "$inc/etc/systemd/system/linxgen-boot-ok.service"
install -D -m 0644 "$env_file" "$inc/etc/linxgen/build.env"
printf '%s\n' "$profile" >"$inc/etc/linxgen/profile"

install -D -m 0755 /dev/stdin config/hooks/normal/9000-linxgen.hook.chroot <<'HOOK'
#!/bin/sh
set -e
/usr/local/lib/linxgen/configure.sh /etc/linxgen/build.env
systemctl enable linxgen-boot-ok.service
if [ "$(cat /etc/linxgen/profile)" = xfce ]; then
  systemctl set-default graphical.target
else
  systemctl set-default multi-user.target
fi
HOOK

log "running live-build"
lb build 2>&1

iso=$(find "$lb_dir" -maxdepth 1 -name 'linxgen-*.iso' -print -quit)
[[ -n $iso ]] || die "live-build did not produce an ISO"
mv "$iso" "$work/out/linxgen.iso"
# shellcheck disable=SC2016 # dpkg-query format string, not shell
chroot "$lb_dir/chroot" dpkg-query -W -f='${Package}\t${Version}\n' >"$work/out/iso-packages.tsv"
rm -rf "$lb_dir"
