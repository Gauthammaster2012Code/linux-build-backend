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

EXISTING="$(convex env list --names-only 2>/dev/null)" ||
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
ask_private_key GITHUB_APP_PRIVATE_KEY "GitHub App"

echo
bold "3. Backblaze B2 (keeps build files for 24 hours)"
info "Bucket: B2 > Buckets > Create a Bucket, Files in Bucket: Private, Default Encryption: Enable."
info "  LinxGen deletes files itself after 24 hours. As a backstop, set Lifecycle Settings > custom rules to"
info "  daysFromUploadingToHiding 2, daysFromHidingToDeleting 1, daysFromStartingToCancelingUnfinishedLargeFiles 1"
info "  (raise daysFromUploadingToHiding if you raise the retention in the admin page; see docs/setup.md)."
info "Endpoint: the bucket's 'Endpoint' value with https:// in front, for example https://s3.us-west-004.backblazeb2.com."
info "Key: Application Keys > Add a New Application Key, allow access to this bucket only, Read and Write."
info "  keyID is the access key ID and applicationKey is the secret; the secret is shown only once."
ask STORAGE_S3_ENDPOINT "S3 endpoint" valid_b2_endpoint "Use https://s3.<region>.backblazeb2.com with no path."
ask STORAGE_BUCKET "Bucket name" valid_bucket "Bucket names are 6-50 letters, digits and hyphens."
ask STORAGE_ACCESS_KEY_ID "keyID" valid_access_key "The keyID is letters and digits only."
ask STORAGE_SECRET_ACCESS_KEY "applicationKey (hidden)" valid_secret_key "The applicationKey is at least 20 characters with no spaces." secret
if is_set R2_ACCOUNT_ID || is_set R2_BUCKET || is_set R2_ACCESS_KEY_ID || is_set R2_SECRET_ACCESS_KEY; then
  warn "Old Cloudflare R2 variables are still set. LinxGen no longer reads them; remove them with"
  warn "  npx convex env remove R2_ACCOUNT_ID --deployment $DEPLOYMENT (and R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)."
fi

echo
bold "3b. LinxGen Storage GitHub App (optional: lets members save builds to their own GitHub)"
info "Skip this whole section to keep saving to GitHub turned off. See docs/setup.md for how to create the app."
info "App ID, client ID and the URL name (slug) are on github.com/settings/apps/<app-name>."
info "Client secret: same page > Client secrets > Generate a new client secret."
ask STORAGE_GITHUB_APP_ID "Storage app ID" valid_digits "The App ID is a number."
ask STORAGE_GITHUB_APP_SLUG "Storage app URL name (slug)" valid_slug "Use the app's URL name, lowercase letters, digits and hyphens."
ask STORAGE_GITHUB_APP_CLIENT_ID "Storage app client ID" valid_client_id "Client IDs start with Iv, for example Iv23li..."
ask STORAGE_GITHUB_APP_CLIENT_SECRET "Storage app client secret (hidden)" valid_api_key "The client secret is at least 16 characters with no spaces." secret
ask_private_key STORAGE_GITHUB_APP_PRIVATE_KEY "LinxGen Storage GitHub App"
ask STORAGE_REPO_NAME "Repository name created in each member's account (default storage)" valid_repo_name "Use letters, digits, '.', '_' and '-'."

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
