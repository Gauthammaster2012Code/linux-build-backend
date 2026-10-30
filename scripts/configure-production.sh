#!/usr/bin/env bash
# Saves the LinxGen production settings that only the project owner has as environment variables on
# the Convex production deployment.
#
# With no arguments, it asks only for required settings that are still missing. Settings that are
# already set and optional features are skipped. To change a setting or turn on an optional feature,
# name its section (Enter at any question then keeps the current value):
#
#   site            web app address (SITE_URL)
#   github          GitHub App that starts builds
#   storage         Backblaze B2 temporary storage
#   owner           owner email, and a new one-time invite code for the owner
#   github-storage  optional: LinxGen Storage app, so members can save builds to their own GitHub
#   ai              optional: platform Ollama Cloud key, used by members who have no AI key of their own
#   all             every section above
#
# Values are passed to the Convex CLI on stdin, so they never show up in shell history, in the
# process list, on screen, or in any file.
#
# Usage: scripts/configure-production.sh [section...]
#   scripts/configure-production.sh                  fill in whatever is missing
#   scripts/configure-production.sh github-storage   set up saving to GitHub
set -euo pipefail

DEPLOYMENT="${LINXGEN_CONVEX_DEPLOYMENT:-gautham-r-krishna:linxgen:production}"
CONVEX_SITE_URL="${LINXGEN_CONVEX_SITE_URL:-https://robust-ox-784.convex.site}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECTIONS="site github storage owner github-storage ai"

SITE_VARS=(SITE_URL)
GITHUB_VARS=(GITHUB_APP_ID GITHUB_APP_INSTALLATION_ID GITHUB_APP_PRIVATE_KEY)
STORAGE_VARS=(STORAGE_S3_ENDPOINT STORAGE_BUCKET STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY)
OWNER_VARS=(OWNER_EMAIL)
STORAGE_APP_VARS=(STORAGE_GITHUB_APP_ID STORAGE_GITHUB_APP_SLUG STORAGE_GITHUB_APP_CLIENT_ID STORAGE_GITHUB_APP_CLIENT_SECRET STORAGE_GITHUB_APP_PRIVATE_KEY)
AI_VARS=(PLATFORM_OLLAMA_API_KEY)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  %s\033[0m\n' "$*"; }
die() {
  printf '\033[31mError: %s\033[0m\n' "$*" >&2
  exit 1
}
usage() { sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }

CHOSEN=""
for arg in "$@"; do
  case "$arg" in
    -h | --help)
      usage
      exit 0
      ;;
    all) CHOSEN="$SECTIONS" ;;
    site | github | storage | owner | github-storage | ai) CHOSEN+=" $arg" ;;
    *) die "unknown section '$arg'. Sections: $SECTIONS, all. See --help." ;;
  esac
done

[[ -t 0 ]] || die "run this script in an interactive terminal."
cd "$REPO_ROOT/packages/backend"
[[ -x node_modules/.bin/convex ]] || die "Convex CLI not found. Run 'pnpm install' in $REPO_ROOT first."

convex() { node_modules/.bin/convex "$@" --deployment "$DEPLOYMENT"; }

EXISTING="$(convex env list --names-only 2>/dev/null)" ||
  die "cannot reach the Convex deployment $DEPLOYMENT. Log in with 'npx convex login' and try again."

FAILURES=()
SECTION=""
ANSWER=""

is_set() { grep -qx "$1" <<<"$EXISTING"; }
any_missing() {
  local name
  for name in "$@"; do is_set "$name" || return 0; done
  return 1
}
any_set() {
  local name
  for name in "$@"; do is_set "$name" && return 0; done
  return 1
}
missing_names() {
  local name out=()
  for name in "$@"; do is_set "$name" || out+=("$name"); done
  printf '%s' "${out[*]}"
}
chosen() { [[ " $CHOSEN " == *" $1 "* ]]; }

# A section runs when it was named, or, with no sections named, when one of its variables is missing.
# It then becomes the current section for field and key_field.
needed() { # section var...
  SECTION="$1"
  shift
  chosen "$SECTION" && return 0
  [[ -z "$CHOSEN" ]] && any_missing "$@"
}

status_of() {
  if is_set "$1"; then printf '(currently set, Enter keeps it)'; else printf '(not set)'; fi
}

save() { # name value
  if printf '%s' "$2" | convex env set "$1" >/dev/null 2>&1; then
    info "Saved $1."
    EXISTING+=$'\n'"$1"
  else
    warn "Could not save $1. Check your Convex login and try again."
    FAILURES+=("$1")
  fi
}

# ask NAME "question" validator "hint shown when invalid" [secret]
# Leaves a saved non-secret value in ANSWER.
ask() {
  local name="$1" question="$2" validator="$3" hint="$4" secret="${5:-}" value
  ANSWER=""
  while true; do
    if [[ -n "$secret" ]]; then
      read -r -s -p "  $question $(status_of "$name"): " value
      echo
    else
      read -r -p "  $question $(status_of "$name"): " value
    fi
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    [[ -z "$value" ]] && return 0
    if "$validator" "$value"; then
      save "$name" "$value"
      if [[ -z "$secret" ]]; then ANSWER="$value"; fi
      return 0
    fi
    warn "$hint"
  done
}

valid_site_url() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; }
valid_email() { [[ "$1" =~ ^[^[:space:]@\"\\]+@[^[:space:]@\"\\]+\.[^[:space:]@\"\\]+$ ]]; }
valid_digits() { [[ "$1" =~ ^[0-9]{1,20}$ ]]; }
valid_b2_endpoint() { [[ "$1" =~ ^https://s3\.[a-z0-9-]+\.backblazeb2\.com$ ]]; }
valid_bucket() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]{4,48}[A-Za-z0-9]$ ]]; }
valid_access_key() { [[ "$1" =~ ^[A-Za-z0-9]{16,128}$ ]]; }
valid_secret_key() { [[ ${#1} -ge 20 && ! "$1" =~ [[:space:]] ]]; }
valid_slug() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,99}$ ]]; }
valid_client_id() { [[ "$1" =~ ^Iv[A-Za-z0-9.]{8,40}$ ]]; }
valid_repo_name() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,100}$ && "$1" != "." && "$1" != ".." ]]; }
valid_api_key() { [[ ${#1} -ge 16 && ! "$1" =~ [[:space:]] ]]; }
valid_model() { [[ "$1" =~ ^[A-Za-z0-9._:/-]{1,100}$ ]]; }
valid_pem() { [[ "$1" == *"-----BEGIN"*"PRIVATE KEY-----"* && "$1" == *"-----END"*"PRIVATE KEY-----"* ]]; }

ask_private_key() { # NAME "label"
  local name="$1" label="$2" path pem="" line
  echo
  info "$label private key $(status_of "$name")"
  info "Type the path to the .pem file, type 'paste' to paste it, or press Enter to skip."
  while true; do
    read -r -e -p "  Path or 'paste': " path
    [[ -z "$path" ]] && return 0
    if [[ "$path" == "paste" ]]; then
      info "Paste the key, including the BEGIN and END lines. It will not be shown."
      pem=""
      while IFS= read -r -s line; do
        pem+="$line"$'\n'
        [[ "$line" == *"-----END"*"PRIVATE KEY-----"* ]] && break
      done
      echo
    else
      path="${path/#\~/$HOME}"
      if [[ ! -r "$path" ]]; then
        warn "Cannot read $path."
        continue
      fi
      pem="$(cat -- "$path")"
    fi
    if ! valid_pem "$pem"; then
      warn "That does not look like a private key. It should start with '-----BEGIN RSA PRIVATE KEY-----'."
      continue
    fi
    save "$name" "$pem"
    if [[ "$path" != "paste" && -f "$path" ]]; then
      local answer
      read -r -p "  Delete $path from this machine now? Keep a copy in your password manager first. [y/N]: " answer
      if [[ "$answer" =~ ^[Yy]$ ]]; then
        if command -v shred >/dev/null; then shred -u -- "$path"; else rm -f -- "$path"; fi
        info "Deleted $path."
      fi
    fi
    return 0
  done
}

# In a section named on the command line every variable is asked; otherwise only the missing ones.
field() {
  if chosen "$SECTION" || ! is_set "$1"; then ask "$@"; fi
}
key_field() {
  if chosen "$SECTION" || ! is_set "$1"; then ask_private_key "$@"; fi
}

show() { # label var...
  local label="$1"
  shift
  if ! any_missing "$@"; then
    printf '  \033[32m%-9s\033[0m %s\n' "set" "$label"
  elif any_set "$@"; then
    printf '  \033[33m%-9s\033[0m %s (missing %s)\n' "partly" "$label" "$(missing_names "$@")"
  else
    printf '  \033[31m%-9s\033[0m %s\n' "missing" "$label"
  fi
}
show_optional() { # label section var...
  local label="$1" section="$2"
  shift 2
  if any_set "$@"; then
    show "$label (optional)" "$@"
  else
    printf '  %-9s %s (optional; to set it up: scripts/configure-production.sh %s)\n' "off" "$label" "$section"
  fi
}

offer_invite() { # owner email saved just now, or empty
  local email="$1" answer
  if [[ -n "$email" ]]; then
    read -r -p "  Create a one-time invite code for $email now? [Y/n]: " answer
    if [[ "$answer" =~ ^[Nn] ]]; then return 0; fi
  else
    info "A new invite code replaces any unused one for that email."
    read -r -p "  Owner email for a new invite code (Enter to skip): " email
    if [[ -z "$email" ]]; then return 0; fi
    if ! valid_email "$email"; then
      warn "That is not a valid email address. Skipped."
      return 0
    fi
  fi
  if convex run admin:bootstrapAdmin "{\"email\":\"$email\"}"; then
    info "Save the code above now. It is shown only once. Use it on the web app's 'Create account' form"
    info "with $email."
  else
    warn "Could not create the invitation. Deploy the backend first, then run this script again."
    FAILURES+=("owner invite code")
  fi
}

bold "LinxGen production setup ($DEPLOYMENT)"
show "Web app address" "${SITE_VARS[@]}"
show "GitHub App" "${GITHUB_VARS[@]}"
show "Backblaze B2 storage" "${STORAGE_VARS[@]}"
show "Owner" "${OWNER_VARS[@]}"
show_optional "Saving to GitHub" github-storage "${STORAGE_APP_VARS[@]}"
show_optional "Platform AI key" ai "${AI_VARS[@]}"

STORAGE_APP_PARTLY=""
if any_set "${STORAGE_APP_VARS[@]}" && any_missing "${STORAGE_APP_VARS[@]}"; then STORAGE_APP_PARTLY=1; fi

if [[ -z "$CHOSEN" ]] && ! any_missing "${SITE_VARS[@]}" "${GITHUB_VARS[@]}" "${STORAGE_VARS[@]}" "${OWNER_VARS[@]}" && [[ -z "$STORAGE_APP_PARTLY" ]]; then
  echo
  info "Everything required is set. To change something, name its section, for example:"
  info "  scripts/configure-production.sh storage"
fi

if needed site "${SITE_VARS[@]}"; then
  echo
  bold "Web app address"
  info "The public HTTPS address of the web app, for example https://linxgen.vercel.app (no trailing slash)."
  info "Skip this if the web app is not deployed yet, and run this script again afterwards."
  field SITE_URL "Web app URL" valid_site_url "Use https://host with no path or trailing slash."
fi

if needed github "${GITHUB_VARS[@]}"; then
  echo
  bold "GitHub App (starts and cancels builds)"
  info "App ID: on the app's settings page (github.com/settings/apps/<app-name>)."
  info "Installation ID: the number at the end of github.com/settings/installations/<ID>."
  field GITHUB_APP_ID "App ID" valid_digits "The App ID is a number."
  field GITHUB_APP_INSTALLATION_ID "Installation ID" valid_digits "The installation ID is a number."
  key_field GITHUB_APP_PRIVATE_KEY "GitHub App"
fi

if needed storage "${STORAGE_VARS[@]}"; then
  echo
  bold "Backblaze B2 (keeps build files for 24 hours)"
  info "Bucket: B2 > Buckets > Create a Bucket, Files in Bucket: Private, Default Encryption: Enable."
  info "  LinxGen deletes files itself after 24 hours. As a backstop, set Lifecycle Settings > custom rules to"
  info "  daysFromUploadingToHiding 2, daysFromHidingToDeleting 1, daysFromStartingToCancelingUnfinishedLargeFiles 1"
  info "  (raise daysFromUploadingToHiding if you raise the retention in the admin page; see docs/setup.md)."
  info "Endpoint: the bucket's 'Endpoint' value with https:// in front, for example https://s3.us-west-004.backblazeb2.com."
  info "Key: Application Keys > Add a New Application Key, allow access to this bucket only, Read and Write."
  info "  keyID is the access key ID and applicationKey is the secret; the secret is shown only once."
  field STORAGE_S3_ENDPOINT "S3 endpoint" valid_b2_endpoint "Use https://s3.<region>.backblazeb2.com with no path."
  field STORAGE_BUCKET "Bucket name" valid_bucket "Bucket names are 6-50 letters, digits and hyphens."
  field STORAGE_ACCESS_KEY_ID "keyID" valid_access_key "The keyID is letters and digits only."
  field STORAGE_SECRET_ACCESS_KEY "applicationKey (hidden)" valid_secret_key "The applicationKey is at least 20 characters with no spaces." secret
fi

if needed owner "${OWNER_VARS[@]}"; then
  echo
  bold "Owner"
  info "The owner is the only account that can create invite codes, under Settings > Invitations in the web app."
  ANSWER=""
  field OWNER_EMAIL "Owner email" valid_email "Enter an email address such as you@example.com."
  offer_invite "$ANSWER"
fi

# Optional: only when named, or when it is partly set up, which setup:verify reports as an error.
SECTION=github-storage
if chosen github-storage || [[ -z "$CHOSEN" && -n "$STORAGE_APP_PARTLY" ]]; then
  echo
  bold "LinxGen Storage GitHub App (optional: members save builds to their own GitHub)"
  chosen github-storage || warn "Saving to GitHub is partly set up. Fill in the rest, or remove the STORAGE_GITHUB_APP_* variables."
  info "See docs/setup.md, step 3b, for how to create the app."
  info "App ID, client ID and the URL name (slug) are on github.com/settings/apps/<app-name>."
  info "Client secret: same page > Client secrets > Generate a new client secret."
  field STORAGE_GITHUB_APP_ID "Storage app ID" valid_digits "The App ID is a number."
  field STORAGE_GITHUB_APP_SLUG "Storage app URL name (slug)" valid_slug "Use the app's URL name, lowercase letters, digits and hyphens."
  field STORAGE_GITHUB_APP_CLIENT_ID "Storage app client ID" valid_client_id "Client IDs start with Iv, for example Iv23li..."
  field STORAGE_GITHUB_APP_CLIENT_SECRET "Storage app client secret (hidden)" valid_api_key "The client secret is at least 16 characters with no spaces." secret
  key_field STORAGE_GITHUB_APP_PRIVATE_KEY "LinxGen Storage GitHub App"
  if chosen github-storage; then
    ask STORAGE_REPO_NAME "Repository name created in each member's account (default storage)" valid_repo_name "Use letters, digits, '.', '_' and '-'."
  fi
fi

if chosen ai; then
  echo
  bold "Platform AI key (optional)"
  info "An Ollama Cloud key used by members who have not added their own AI key in Settings."
  ask PLATFORM_OLLAMA_API_KEY "Ollama Cloud API key (hidden)" valid_api_key "The key is at least 16 characters with no spaces." secret
  ask PLATFORM_OLLAMA_MODEL "Model (default gpt-oss:120b)" valid_model "Use a model name such as gpt-oss:120b."
fi

echo
bold "Checking the configuration"
if REPORT="$(convex run setup:verify 2>/dev/null)"; then
  # Show only the checks that need attention; fall back to the raw report if it cannot be parsed.
  node -e '
    const report = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const failing = report.checks.filter((c) => !c.ok);
    if (failing.length === 0) console.log("  All checks passed.");
    for (const c of failing) console.log("  \x1b[33mneeds attention\x1b[0m " + c.name + ": " + c.detail);
  ' <<<"$REPORT" 2>/dev/null || printf '%s\n' "$REPORT"
else
  warn "The check could not run. Deploy the backend first, then run this script again."
fi
info "Not checked here: the backend repository needs the GitHub Actions variable"
info "  LINXGEN_API_URL = $CONVEX_SITE_URL (Settings > Secrets and variables > Actions > Variables)."

if ((${#FAILURES[@]})); then
  echo
  warn "Not saved: ${FAILURES[*]}"
  exit 1
fi
