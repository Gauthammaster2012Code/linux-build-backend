#!/bin/sh
# Writes a boot verification marker to the first serial port. QEMU boot tests wait for this line.
profile=$(cat /etc/linxgen/profile 2>/dev/null || echo unknown)
dm=none
if [ "$profile" = xfce ]; then
  i=0
  while [ "$i" -lt 180 ]; do
    if systemctl is-active --quiet display-manager.service; then
      break
    fi
    i=$((i + 1))
    sleep 1
  done
  dm=$(systemctl is-active display-manager.service || true)
fi
if [ -w /dev/ttyS0 ]; then
  printf 'LINXGEN-BOOT-OK profile=%s dm=%s\n' "$profile" "$dm" >/dev/ttyS0
fi
