#!/usr/bin/env bash
# Applies generated system settings inside the target root filesystem (live chroot or container build).
set -euo pipefail

die() {
  printf '[linxgen] ERROR: %s\n' "$*" >&2
  exit 1
}

env_file=${1:?usage: configure.sh BUILD_ENV}
get() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$1="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$env_file"
  die "$1 missing from $env_file"
}

host=$(get HOSTNAME)
tz=$(get TIMEZONE)
loc=$(get LOCALE)
family=$(get DISTRO_FAMILY)

[[ $host =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "invalid hostname"
[[ $tz =~ ^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$ ]] || die "invalid timezone"
[[ $loc =~ ^[a-z]{2,3}_[A-Z]{2}\.UTF-8$ ]] || die "invalid locale"

[[ -f /usr/share/zoneinfo/$tz ]] || die "timezone $tz does not exist in tzdata"
ln -sf "/usr/share/zoneinfo/$tz" /etc/localtime
printf '%s\n' "$tz" >/etc/timezone

grep -qx "$loc UTF-8" /usr/share/i18n/SUPPORTED || die "locale $loc is not supported by this distribution"
printf '%s UTF-8\n' "$loc" >/etc/locale.gen
if [[ $family == ubuntu ]]; then
  locale-gen "$loc"
else
  locale-gen
fi
printf 'LANG=%s\n' "$loc" >/etc/default/locale

printf '%s\n' "$host" >/etc/hostname
printf '127.0.0.1\tlocalhost\n127.0.1.1\t%s\n::1\tlocalhost ip6-localhost ip6-loopback\n' "$host" >/etc/hosts

printf '[linxgen] configured hostname=%s timezone=%s locale=%s\n' "$host" "$tz" "$loc"
