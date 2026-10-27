#!/usr/bin/env bash
# Resolves the current digests of the base images and rewrites builder/toolchain.lock.json.
# Run manually, review the diff, and qualify a full build of every distro/profile/output before merging.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
source "$here/lib/common.sh"
require_cmd docker
require_cmd node

resolve() {
  local ref=$1 digest
  digest=$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).digest));')
  [[ $digest =~ ^sha256:[a-f0-9]{64}$ ]] || die "could not resolve $ref"
  printf 'docker.io/library/%s@%s' "$ref" "$digest"
}

debian=$(resolve debian:trixie)
ubuntu=$(resolve ubuntu:24.04)
log "debian-13    -> $debian"
log "ubuntu-24.04 -> $ubuntu"

LOCK="$here/toolchain.lock.json" DEBIAN_IMAGE="$debian" UBUNTU_IMAGE="$ubuntu" node -e '
  const fs = require("fs");
  const lock = JSON.parse(fs.readFileSync(process.env.LOCK, "utf8"));
  lock.images["debian-13"] = process.env.DEBIAN_IMAGE;
  lock.images["ubuntu-24.04"] = process.env.UBUNTU_IMAGE;
  fs.writeFileSync(process.env.LOCK, JSON.stringify(lock, null, 2) + "\n");'
log "updated toolchain.lock.json"
