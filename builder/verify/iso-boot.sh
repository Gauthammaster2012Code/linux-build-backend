#!/usr/bin/env bash
# Boots an ISO in QEMU and waits for the LinxGen boot marker on the serial console.
# Usage: verify/iso-boot.sh ISO bios|uefi minimal|xfce TIMEOUT_SECONDS SERIAL_LOG
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/common.sh
source "$here/../lib/common.sh"

iso=$(realpath "${1:?usage: iso-boot.sh ISO MODE PROFILE TIMEOUT SERIAL_LOG}")
mode=${2:?}
profile=${3:?}
timeout_s=${4:?}
serial_log=${5:?}
[[ $mode == bios || $mode == uefi ]] || die "mode must be bios or uefi"
[[ $profile == minimal || $profile == xfce ]] || die "invalid profile"
[[ $timeout_s =~ ^[0-9]{2,5}$ ]] || die "invalid timeout"
[[ -s $iso ]] || die "ISO not found"
require_cmd qemu-system-x86_64
require_cmd python3

tmp=$(mktemp -d)
monitor=$tmp/monitor.sock
qemu_pid=
cleanup() {
  if [[ -n $qemu_pid ]] && kill -0 "$qemu_pid" 2>/dev/null; then
    kill "$qemu_pid" 2>/dev/null || true
    wait "$qemu_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

# shellcheck disable=SC2054 # QEMU option values contain commas
args=(-machine q35 -m 3072 -smp 2 -display none -vga std -no-reboot
  -drive "file=$iso,media=cdrom,readonly=on"
  -boot order=d
  -nic user,model=virtio-net-pci
  -serial "file:$serial_log"
  -monitor "unix:$monitor,server,nowait")
if [[ -w /dev/kvm ]]; then
  args+=(-accel kvm -cpu host)
else
  args+=(-accel tcg -cpu max)
  timeout_s=$((timeout_s * 3))
  warn "using software emulation; timeout extended to ${timeout_s}s"
fi

if [[ $mode == uefi ]]; then
  code=
  for candidate in /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd; do
    [[ -f $candidate ]] && { code=$candidate; break; }
  done
  [[ -n $code ]] || die "OVMF firmware not installed"
  vars_src=${code/CODE/VARS}
  cp "$vars_src" "$tmp/vars.fd"
  args+=(-drive "if=pflash,format=raw,unit=0,readonly=on,file=$code"
    -drive "if=pflash,format=raw,unit=1,file=$tmp/vars.fd")
fi

: >"$serial_log"
log "booting $(basename "$iso") ($mode, profile $profile, timeout ${timeout_s}s)"
qemu-system-x86_64 "${args[@]}" &
qemu_pid=$!

send_enter() {
  python3 - "$monitor" <<'PY' 2>/dev/null || true
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.settimeout(2)
s.connect(sys.argv[1])
s.sendall(b"sendkey ret\n")
s.close()
PY
}

start=$SECONDS
next_key=5
while true; do
  elapsed=$((SECONDS - start))
  if marker=$(grep -a -m1 -o 'LINXGEN-BOOT-OK profile=[a-z]* dm=[a-z-]*' "$serial_log"); then
    log "marker: $marker"
    [[ $marker == *"profile=$profile "* ]] || die "booted image reports the wrong profile"
    if [[ $profile == xfce && $marker != *"dm=active" ]]; then
      die "display manager did not start"
    fi
    log "$mode boot test passed in ${elapsed}s"
    exit 0
  fi
  if ! kill -0 "$qemu_pid" 2>/dev/null; then
    tail -n 50 "$serial_log" || true
    die "QEMU exited before the boot marker appeared"
  fi
  if ((elapsed >= timeout_s)); then
    tail -n 50 "$serial_log" || true
    die "$mode boot test timed out after ${timeout_s}s"
  fi
  # Accept the default boot menu entry in case the bootloader menu waits for input.
  if ((elapsed < 120 && elapsed >= next_key)); then
    send_enter
    next_key=$((elapsed + 10))
  fi
  sleep 1
done
