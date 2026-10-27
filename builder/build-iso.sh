#!/usr/bin/env bash
# Builds the live ISO inside the pinned toolchain container for the requested distribution.
# Usage: build-iso.sh WORKDIR
# Produces WORKDIR/out/linxgen.iso, WORKDIR/out/iso-packages.tsv and WORKDIR/out/iso-toolchain.tsv.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$here/lib/common.sh"

work=$(realpath "${1:?usage: build-iso.sh WORKDIR}")
env_file=$work/build.env
[[ -f $env_file ]] || die "missing $env_file"
family=$(read_env_value DISTRO_FAMILY "$env_file")
image=$(read_env_value TOOLCHAIN_IMAGE "$env_file")
[[ $image =~ ^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$ ]] || die "toolchain image must be pinned by digest"
case $family in
  debian | ubuntu) ;;
  *) die "unsupported distribution family $family" ;;
esac
validate_package_list "$work/packages.iso.list"
mkdir -p "$work/out"

require_cmd docker
log "building $family ISO in $image"
# Privileged is required for debootstrap/live-build mounts and loop devices inside the chroot builder.
docker run --rm --privileged \
  --name "linxgen-iso-$(read_env_value ATTEMPT_ID "$env_file")" \
  -e DEBIAN_FRONTEND=noninteractive \
  -v "$here:/builder:ro" \
  -v "$work:/work" \
  "$image" \
  bash "/builder/$family/iso.sh" /work

[[ -s $work/out/linxgen.iso ]] || die "ISO was not produced"
[[ -s $work/out/iso-packages.tsv ]] || die "ISO package manifest was not produced"
log "ISO built: $(du -h "$work/out/linxgen.iso" | cut -f1)"
