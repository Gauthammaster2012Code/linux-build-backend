#!/usr/bin/env bash
# Smoke test executed inside the built container with networking disabled.
set -euo pipefail
fail() {
  printf 'LINXGEN-SMOKE-FAIL %s\n' "$*"
  exit 1
}

get() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line == "$1="* ]] && { printf '%s' "${line#*=}"; return 0; }
  done </etc/linxgen/build.env
  fail "missing $1"
}

tz=$(get TIMEZONE)
loc=$(get LOCALE)

missing=0
while IFS= read -r pkg || [[ -n $pkg ]]; do
  [[ -z $pkg ]] && continue
  status=$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null || true)
  if [[ $status != "install ok installed" ]]; then
    printf 'missing package: %s\n' "$pkg"
    missing=$((missing + 1))
  fi
done </etc/linxgen/requested.list
((missing == 0)) || fail "$missing requested packages are not installed"

# Zone names such as UTC are aliases (UTC -> Etc/UTC), so compare canonical paths on both sides.
[[ -e /usr/share/zoneinfo/$tz ]] || fail "timezone $tz is not installed"
[[ $(readlink -f /etc/localtime) == "$(readlink -f "/usr/share/zoneinfo/$tz")" ]] || fail "timezone is not $tz"
locale -a | grep -qiF "${loc%.UTF-8}.utf8" || fail "locale $loc is not generated"
[[ ${LANG:-} == "$loc" ]] || fail "LANG is '${LANG:-}', expected $loc"
[[ -z ${LC_ALL:-} ]] || fail "LC_ALL overrides the requested locale"
# locale prints warnings on stderr when the environment names a locale the C library cannot load.
locale_warnings=$(locale 2>&1 >/dev/null || true)
[[ -z $locale_warnings ]] || fail "locale $loc cannot be loaded: $locale_warnings"
command -v apt-get >/dev/null || fail "apt-get missing"
dpkg --audit >/dev/null || fail "dpkg reports broken packages"

printf 'LINXGEN-SMOKE-OK packages=%s\n' "$(wc -l </usr/share/linxgen/packages.tsv)"
