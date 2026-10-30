#!/usr/bin/env bash
# Asks for the LinxGen production settings that only the project owner has and saves them as
# environment variables on the Convex production deployment.
#
# Values are passed to the Convex CLI on stdin, so they never show up in shell history, in the
# process list, on screen, or in any file. Press Enter at any question to keep the current value,
# so you can re-run this script to change one setting.
#
# Usage: scripts/configure-production.sh
set -euo pipefail

DEPLOYMENT="${LINXGEN_CONVEX_DEPLOYMENT:-gautham-r-krishna:linxgen:production}"
CONVEX_CLOUD_URL="${LINXGEN_CONVEX_CLOUD_URL:-https://robust-ox-784.convex.cloud}"
CONVEX_SITE_URL="${LINXGEN_CONVEX_SITE_URL:-https://robust-ox-784.convex.site}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  %s\033[0m\n' "$*"; }
die() {
  printf '\033[31mError: %s\033[0m\n' "$*" >&2
  exit 1
}

[[ -t 0 ]] || die "run this script in an interactive terminal."
cd "$REPO_ROOT/packages/backend"
[[ -x node_modules/.bin/convex ]] || die "Convex CLI not found. Run 'pnpm install' in $REPO_ROOT first."

convex() { node_modules/.bin/convex "$@" --deployment "$DEPLOYMENT"; }

EXISTING="$(convex env list 2>/dev/null | cut -d= -f1)" ||
  die "cannot reach the Convex deployment $DEPLOYMENT. Log in with 'npx convex login' and try again."

is_set() { grep -qx "$1" <<<"$EXISTING"; }

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
ask() {
  local name="$1" question="$2" validator="$3" hint="$4" secret="${5:-}" value
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
      return 0
    fi
    warn "$hint"
  done
}

valid_site_url() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; }
valid_digits() { [[ "$1" =~ ^[0-9]{1,20}$ ]]; }
valid_hex32() { [[ "$1" =~ ^[0-9a-fA-F]{32}$ ]]; }
valid_bucket() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; }
valid_access_key() { [[ "$1" =~ ^[A-Za-z0-9]{16,128}$ ]]; }
valid_secret_key() { [[ ${#1} -ge 32 && ! "$1" =~ [[:space:]] ]]; }
valid_api_key() { [[ ${#1} -ge 16 && ! "$1" =~ [[:space:]] ]]; }
valid_model() { [[ "$1" =~ ^[A-Za-z0-9._:/-]{1,100}$ ]]; }
valid_pem() { [[ "$1" == *"-----BEGIN"*"PRIVATE KEY-----"* && "$1" == *"-----END"*"PRIVATE KEY-----"* ]]; }

ask_private_key() {
  local path pem="" line
  echo
  info "GitHub App private key $(status_of GITHUB_APP_PRIVATE_KEY)"
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
    save GITHUB_APP_PRIVATE_KEY "$pem"
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

FAILURES=()

bold "LinxGen production setup"
info "Convex deployment: $DEPLOYMENT"
info "Press Enter at any question to keep the current value."

echo
bold "1. Web app address"
info "The public HTTPS address of the web app, for example https://linxgen.vercel.app (no trailing slash)."
info "Skip this if the web app is not deployed yet, and run this script again afterwards."
ask SITE_URL "Web app URL" valid_site_url "Use https://host with no path or trailing slash."

echo
bold "2. GitHub App (starts and cancels builds)"
info "App ID: on the app's settings page (github.com/settings/apps/<app-name>)."
info "Installation ID: the number at the end of github.com/settings/installations/<ID>."
ask GITHUB_APP_ID "App ID" valid_digits "The App ID is a number."
ask GITHUB_APP_INSTALLATION_ID "Installation ID" valid_digits "The installation ID is a number."
ask_private_key

echo
bold "3. Cloudflare R2 (stores build files)"
info "Account ID: Cloudflare dashboard > R2 > Overview (32 hex characters)."
info "API token: R2 > Manage API tokens > Object Read & Write, limited to the LinxGen bucket."
ask R2_ACCOUNT_ID "Account ID" valid_hex32 "The account ID is 32 hexadecimal characters."
ask R2_BUCKET "Bucket name" valid_bucket "Bucket names use 3-63 lowercase letters, digits and hyphens."
ask R2_ACCESS_KEY_ID "Access key ID" valid_access_key "The access key ID is letters and digits only."
ask R2_SECRET_ACCESS_KEY "Secret access key (hidden)" valid_secret_key "The secret access key is at least 32 characters with no spaces." secret

echo
bold "4. Ollama Cloud (optional default AI model)"
info "Without a key, members must add their own AI key in Settings before they can build."
ask PLATFORM_OLLAMA_API_KEY "Ollama Cloud API key (hidden)" valid_api_key "The key is at least 16 characters with no spaces." secret
ask PLATFORM_OLLAMA_MODEL "Model (default gpt-oss:120b)" valid_model "Use a model name such as gpt-oss:120b."

echo
bold "5. First administrator"
info "Creates a one-time admin invite code. Use it on the web app's 'Create account' form with this email."
info "Only works once the backend code is deployed. Running it again replaces the earlier code."
read -r -p "  Admin email (Enter to skip): " ADMIN_EMAIL
if [[ -n "$ADMIN_EMAIL" ]]; then
  if [[ "$ADMIN_EMAIL" =~ ^[^[:space:]@\"\\]+@[^[:space:]@\"\\]+\.[^[:space:]@\"\\]+$ ]]; then
    if ! convex run admin:bootstrapAdmin "{\"email\":\"$ADMIN_EMAIL\"}"; then
      warn "Could not create the invitation. Deploy the backend first, then run this script again."
      FAILURES+=("admin invitation")
    else
      info "Save the code above now. It is shown only once."
    fi
  else
    warn "That is not a valid email address. Skipped."
  fi
fi

echo
bold "6. Checking the configuration"
if ! convex run setup:verify; then
  warn "The check could not run. Deploy the backend first, then run this script again."
fi

echo
bold "Still to do outside this script"
info "GitHub: in linux-build-backend, Settings > Secrets and variables > Actions > Variables,"
info "  add LINXGEN_API_URL = $CONVEX_SITE_URL"
info "Vercel (linux-build-frontend project) environment variables:"
info "  NEXT_PUBLIC_CONVEX_URL = $CONVEX_CLOUD_URL"
info "  NEXT_PUBLIC_CONVEX_SITE_URL = $CONVEX_SITE_URL"
is_set SITE_URL || info "Then run this script again to set SITE_URL to the web app's address."

if ((${#FAILURES[@]})); then
  echo
  warn "Not saved: ${FAILURES[*]}"
  exit 1
fi
