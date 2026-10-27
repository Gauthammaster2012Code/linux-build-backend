#!/usr/bin/env bash
# Loads the saved archive into Docker and runs the smoke test with networking disabled.
# Usage: verify/container-smoke.sh WORKDIR
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$here/../lib/common.sh"

work=$(realpath "${1:?usage: container-smoke.sh WORKDIR}")
archive=$work/out/container.tar.gz
tag=$(<"$work/out/container-image.txt")
host=$(read_env_value HOSTNAME "$work/build.env")
[[ $tag =~ ^linxgen/[a-z0-9-]+:[a-z0-9]+$ ]] || die "unexpected image tag"
[[ $host =~ $HOSTNAME_RE ]] || die "invalid hostname"
[[ -s $archive ]] || die "container archive missing"
require_cmd docker

log "loading $archive"
gzip -t "$archive"
docker load -i "$archive"
output=$(docker run --rm --network none --hostname "$host" --entrypoint /usr/local/lib/linxgen/smoke.sh "$tag" 2>&1) || {
  printf '%s\n' "$output"
  docker image rm "$tag" >/dev/null 2>&1 || true
  die "container smoke test failed"
}
printf '%s\n' "$output"
docker image rm "$tag" >/dev/null 2>&1 || true
grep -q '^LINXGEN-SMOKE-OK' <<<"$output" || die "smoke test did not report success"
log "container smoke test passed"
