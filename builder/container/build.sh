#!/usr/bin/env bash
# Builds the container image from the fixed Dockerfile template and saves it as a gzip archive.
# Usage: container/build.sh WORKDIR
# Produces WORKDIR/out/container.tar.gz, container-packages.tsv, container-image.txt.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
builder=$(dirname "$here")
# shellcheck source=../lib/common.sh
source "$builder/lib/common.sh"

work=$(realpath "${1:?usage: build.sh WORKDIR}")
env_file=$work/build.env
family=$(read_env_value DISTRO_FAMILY "$env_file")
base=$(read_env_value BASE_IMAGE "$env_file")
build_id=$(read_env_value BUILD_ID "$env_file")
attempt=$(read_env_value ATTEMPT_ID "$env_file")
host=$(read_env_value HOSTNAME "$env_file")
loc=$(read_env_value LOCALE "$env_file")
[[ $base =~ ^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$ ]] || die "base image must be pinned by digest"
[[ $attempt =~ ^[A-Za-z0-9]{1,64}$ ]] || die "invalid attempt id"
[[ $build_id =~ ^[A-Za-z0-9]{1,64}$ ]] || die "invalid build id"
[[ $host =~ $HOSTNAME_RE ]] || die "invalid hostname"
[[ $loc =~ $LOCALE_RE ]] || die "invalid locale"
validate_package_list "$work/packages.container.list"
validate_package_list "$work/packages.requested.list"
require_cmd docker

ctx=$work/container-context
rm -rf "$ctx"
mkdir -p "$ctx/context" "$work/out"
cp "$here/Dockerfile" "$ctx/Dockerfile"
cp "$here/install.sh" "$here/smoke.sh" "$builder/rootfs/configure.sh" "$ctx/context/"
cp "$builder/sources/$family.sources" "$ctx/context/system.sources"
cp "$env_file" "$ctx/context/build.env"
cp "$work/packages.container.list" "$ctx/context/packages.list"
cp "$work/packages.requested.list" "$ctx/context/requested.list"

tag="linxgen/$host:$(printf '%s' "$attempt" | tr '[:upper:]' '[:lower:]' | cut -c1-32)"
log "building container image $tag from $base"
# Only x86_64 is supported. Pinning the platform keeps a multi-arch base digest or a non-amd64 Docker host from
# producing an image for another architecture.
docker build \
  --pull \
  --no-cache \
  --platform linux/amd64 \
  --build-arg "BASE_IMAGE=$base" \
  --build-arg "LINXGEN_BUILD_ID=$build_id" \
  --build-arg "LINXGEN_HOSTNAME=$host" \
  --build-arg "LINXGEN_LOCALE=$loc" \
  -t "$tag" \
  "$ctx"
arch=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$tag")
[[ $arch == linux/amd64 ]] || die "built image is $arch, expected linux/amd64"

cid=$(docker create "$tag")
docker cp "$cid:/usr/share/linxgen/packages.tsv" "$work/out/container-packages.tsv"
docker rm "$cid" >/dev/null

log "saving image archive"
docker save "$tag" | gzip -n -6 >"$work/out/container.tar.gz"
printf '%s\n' "$tag" >"$work/out/container-image.txt"
# Remove the local image so the smoke test proves the archive itself loads.
docker image rm "$tag" >/dev/null
rm -rf "$ctx"
log "container archive: $(du -h "$work/out/container.tar.gz" | cut -f1)"
