#!/usr/bin/env bash
# Shared helpers for LinxGen builder scripts. Sourced, not executed.

log() { printf '[linxgen] %s\n' "$*"; }
warn() { printf '[linxgen] WARNING: %s\n' "$*" >&2; }
die() {
  printf '[linxgen] ERROR: %s\n' "$*" >&2
  exit 1
}

# shellcheck disable=SC2034 # used by scripts that source this file
PACKAGE_RE='^[a-z0-9][a-z0-9+.-]{1,99}$'
# shellcheck disable=SC2034
HOSTNAME_RE='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
# shellcheck disable=SC2034
TIMEZONE_RE='^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$'
# shellcheck disable=SC2034
LOCALE_RE='^[a-z]{2,3}_[A-Z]{2}\.UTF-8$'

# Defense in depth: the runner already validated the spec, but scripts re-check anything they consume.
validate_package_list() {
  local file=$1 name
  [[ -f $file ]] || die "package list $file is missing"
  while IFS= read -r name || [[ -n $name ]]; do
    [[ $name =~ $PACKAGE_RE ]] || die "invalid package name in $file"
  done <"$file"
}

# Reads KEY=value lines without evaluating them as shell code.
read_env_value() {
  local key=$1 file=$2 line
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$key="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$file"
  die "$key is missing from $file"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command $1 is not installed"
}
