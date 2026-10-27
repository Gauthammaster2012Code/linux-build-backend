#!/usr/bin/env bash
# Prepares the GitHub-hosted runner: verification tools on the host and KVM access for QEMU.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $EUID -eq 0 ]] || die "host-setup.sh must run as root"
export DEBIAN_FRONTEND=noninteractive

log "installing host verification tools"
apt-get update -q
apt-get install -y -q --no-install-recommends qemu-system-x86 qemu-utils ovmf python3 >/dev/null

if [[ -e /dev/kvm ]]; then
  printf 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"\n' >/etc/udev/rules.d/99-linxgen-kvm.rules
  udevadm control --reload-rules
  udevadm trigger --name-match=kvm
  log "KVM acceleration available"
else
  warn "KVM is not available; boot tests fall back to slower software emulation"
fi

require_cmd docker
docker version --format 'docker server {{.Server.Version}}'
qemu-system-x86_64 --version | head -n1
