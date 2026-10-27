#!/usr/bin/env bash
# Runs during docker build inside the pinned base image.
set -euo pipefail
ctx=/tmp/linxgen
export DEBIAN_FRONTEND=noninteractive

get() {
  local line
  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == "$1="* ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <"$ctx/build.env"
  printf 'missing %s\n' "$1" >&2
  exit 1
}

recommends=$(get APT_RECOMMENDS)
loc=$(get LOCALE)
while IFS= read -r name || [[ -n $name ]]; do
  [[ $name =~ ^[a-z0-9][a-z0-9+.-]{1,99}$ ]] || { echo "invalid package name" >&2; exit 1; }
done <"$ctx/packages.list"

rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*
install -m 0644 "$ctx/system.sources" /etc/apt/sources.list.d/system.sources

flags=(-y -q)
[[ $recommends == true ]] || flags+=(--no-install-recommends)
apt-get update -q
xargs -a "$ctx/packages.list" -r apt-get install "${flags[@]}" --

bash "$ctx/configure.sh" "$ctx/build.env"
install -D -m 0755 "$ctx/smoke.sh" /usr/local/lib/linxgen/smoke.sh
install -D -m 0644 "$ctx/requested.list" /etc/linxgen/requested.list
install -D -m 0644 "$ctx/build.env" /etc/linxgen/build.env
mkdir -p /usr/share/linxgen
dpkg-query -W -f='${Package}\t${Version}\n' >/usr/share/linxgen/packages.tsv
printf 'LANG=%s\n' "$loc" >/etc/default/locale

apt-get clean
rm -rf /var/lib/apt/lists/* "$ctx"
