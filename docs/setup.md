# Setup

This guide connects LinxGen to its external services. **Every step here creates cloud resources, grants permissions, publishes workflows or deploys code.** None of it has been done for you. Each step needs explicit authorization from the project owner before anyone carries it out.

## 1. Convex deployment

```bash
cd packages/backend
npx convex deploy            # or `npx convex dev` for a development deployment
```

`CONVEX_SITE_URL` is provided by Convex automatically. Set everything else with `npx convex env set NAME value` (or in the dashboard):

| Variable | Required | Purpose |
|---|---|---|
| `SITE_URL` | yes | Public URL of the web app, for example `https://linxgen.example.com`. Used as the Better Auth base URL and trusted origin. |
| `OWNER_EMAIL` | yes | Email of the owner account, the only one that can create, list and revoke invite codes (Settings > Invitations in the web app). Other admins cannot demote or revoke it. Without it, invite codes can only be created from the CLI. |
| `BETTER_AUTH_SECRET` | yes | Random secret for Better Auth sessions, at least 32 characters: `openssl rand -base64 32`. |
| `CREDENTIAL_ENCRYPTION_KEYS` | yes | Keyring for personal AI keys: `{"current":"v1","keys":{"v1":"<base64 of 32 random bytes>"}}`. To rotate, add a new version, make it `current`, and keep the old one until every key has been re-saved. |
| `PLATFORM_OLLAMA_API_KEY` | for platform AI | Ollama Cloud key for the platform default provider. |
| `PLATFORM_OLLAMA_MODEL` | no | Default `gpt-oss:120b`. |
| `PACKAGE_RESOLUTION_MODE` | no | `archive` (default) checks package names against Debian madison and Launchpad. `runner-only` skips that and relies on the runner's manifest check. |
| `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` | yes | GitHub App that dispatches builds (see step 3). Paste the PEM with `\n` escapes if needed. |
| `GITHUB_REPOSITORY` | yes | `owner/name` of the repository that hosts the build workflow. |
| `GITHUB_REPOSITORY_ID` | recommended | Numeric repository id; pins OIDC trust to that exact repository. |
| `GITHUB_WORKFLOW_FILE` | no | Default `linxgen-build.yml`. |
| `GITHUB_WORKFLOW_REF` | no | Branch or ref to dispatch. Default `main`. OIDC tokens must come from this ref. |
| `GITHUB_WORKFLOW_SHA_ALLOWLIST` | recommended | Comma-separated workflow commit SHAs allowed to claim builds. Leave it empty to trust any commit on the ref. |
| `RUNNER_OIDC_AUDIENCE` | no | Default `linxgen-runner`. Must match the workflow's `LINXGEN_OIDC_AUDIENCE`. |
| `RUNNER_CAPABILITY_SECRET` | yes | At least 32 random characters; used to sign dispatch nonces and capability tokens. |
| `RUNNER_CLAIM_TIMEOUT_MINUTES` | no | Default 30. |
| `RUNNER_HEARTBEAT_TIMEOUT_MINUTES` | no | Default 10. |
| `STORAGE_S3_ENDPOINT` | yes | Backblaze B2 S3 endpoint of the bucket, for example `https://s3.us-west-004.backblazeb2.com` (see step 2). |
| `STORAGE_S3_REGION` | no | Signing region. Derived from a `s3.<region>.backblazeb2.com` endpoint; only needed for other S3-compatible hosts. |
| `STORAGE_BUCKET` | yes | Private B2 bucket that keeps build files for 24 hours. |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | yes | B2 application key (`keyID` and `applicationKey`) limited to that bucket with Read and Write access. |
| `GITHUB_SAVE_WORKFLOW_FILE` | no | Default `linxgen-save.yml`. The save workflow lives in `GITHUB_REPOSITORY` next to the build workflow and is dispatched by the same GitHub App. |
| `STORAGE_GITHUB_APP_ID`, `STORAGE_GITHUB_APP_SLUG`, `STORAGE_GITHUB_APP_CLIENT_ID`, `STORAGE_GITHUB_APP_CLIENT_SECRET`, `STORAGE_GITHUB_APP_PRIVATE_KEY` | for saving to GitHub | The separate "LinxGen Storage" GitHub App (see step 3b). Set all five or none. Without them, members cannot save builds to GitHub and everything else works. |
| `STORAGE_REPO_NAME` | no | Name of the private repository created in each member's account. Default `storage`. |

`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and the Cloudflare R2 variables (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) are no longer used. Remove them if an older deployment still has them. Files left in an old R2 bucket are not migrated; delete the bucket when you no longer need them.

`scripts/configure-production.sh` asks for the values only the owner has (web app URL, GitHub App, Backblaze B2, the optional LinxGen Storage app, Ollama, the owner email), saves them on the production deployment without showing or writing them anywhere, creates the owner's invite code and runs `setup:verify`. Set `LINXGEN_CONVEX_DEPLOYMENT` to target a deployment other than `gautham-r-krishna:linxgen:production`.

### Sign-in and invitations

People sign in with an email address and a password (12 to 128 characters). LinxGen is invite-only:

- An invitation is bound to one email address and carries a one-time code such as `7K3D-QF9M-…` (140 random bits). Only a SHA-256 hash of the code is stored, so the code is shown once, when the invitation is created. Codes expire after 14 days. Inviting the same email again revokes the older code.
- Creating an account needs the code. Better Auth refuses `/sign-up/email` unless the code belongs to a pending, unexpired invitation for that exact email. After sign-up the web app redeems the code, which activates membership with the invitation's role and marks the code used.
- Someone who already has an account but no membership can enter a code after signing in.
- Only the owner (`OWNER_EMAIL`) creates, lists and revokes invitations, on the web app's Settings page. Other admins manage members and limits but cannot issue codes.
- Email addresses are not verified (there is no email sender). The code is the proof that the owner invited that address.
- There is no password reset yet, and the reset, verification email, email change and social sign-in routes are switched off. If someone forgets their password, an operator has to delete their Better Auth `user`, `account` and `session` rows (Convex dashboard, `betterAuth` component) and send them a new invitation.

Rate limits: Better Auth limits `/sign-in/email` to 5 requests a minute and `/sign-up/email` to 5 an hour per client IP, stored in the Better Auth `rateLimit` table. Each email address also gets at most 10 sign-in attempts per 15 minutes, and each user at most 5 invite code attempts per 15 minutes. If Better Auth cannot find a single client IP in `x-forwarded-for`, it logs a warning and all clients share one bucket per route, with looser limits (60 sign-ins a minute, 30 sign-ups an hour).

### Owner and first invite code

Set `OWNER_EMAIL` to your email, then create your admin invitation from the CLI. It returns the one-time code and never activates an existing account:

```bash
npx convex env set OWNER_EMAIL you@example.com
npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}'
# { invitationId: "…", email: "you@example.com", role: "admin", code: "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", expiresAt: … }
```

Open the web app, choose **Create account**, and enter that email, a password and the code. If you already have an account, sign in and enter the code instead. You then invite everyone else from **Settings > Invitations**, which shows each new code once.

### Check the configuration

```bash
npx convex run setup:verify
```

This returns `{ "ok": boolean, "checks": [{ "name", "ok", "detail" }] }`. It never returns or logs secret values. It checks:

- `env:*`: every required variable is set. `BETTER_AUTH_SECRET` and `RUNNER_CAPABILITY_SECRET` are at least 32 characters, `CREDENTIAL_ENCRYPTION_KEYS` parses and every key is 32 bytes, `SITE_URL` is an https origin, `OWNER_EMAIL` is an email address, and `GITHUB_APP_PRIVATE_KEY` is a PEM key. `STORAGE_S3_ENDPOINT` is an https B2 endpoint with a region and `STORAGE_BUCKET` is a valid B2 bucket name. Leftover `GITHUB_CLIENT_*` and `R2_*` variables are listed as unused.
- `github:app`, `github:repository`, `github:workflow`: the app gets an installation token, the installation can see `GITHUB_REPOSITORY`, and `GITHUB_WORKFLOW_FILE` is active on the default branch. Before the workflow is pushed, `github:workflow` says it is "not on main yet". The app has no contents permission, so a `GITHUB_WORKFLOW_REF` other than the default branch is not checked.
- `storage:bucket`: writes, reads back and deletes a 2-byte object under `_linxgen-probe/`, then lists its versions to confirm the key can delete every version.
- `github-storage:app`: if any `STORAGE_GITHUB_APP_*` variable is set, all five are set, the app can be read with its private key, its slug matches, and it has Administration and Contents write and no other permissions. Not configured is reported as optional.
- `github:save-workflow`: when the storage app is configured, `GITHUB_SAVE_WORKFLOW_FILE` is active on the build repository's default branch.
- `ollama:platform`: if `PLATFORM_OLLAMA_API_KEY` is set, sends a tiny chat request to Ollama Cloud with `PLATFORM_OLLAMA_MODEL` and reports whether the key is accepted. Otherwise it reports "not set (optional)".

Run it after setting variables and again after publishing the workflow.

## 2. Backblaze B2 (temporary storage)

Build files are kept in a private Backblaze B2 bucket for 24 hours by default (admins can choose 1 to 168 hours). After that LinxGen deletes them, including every stored version. Members who want to keep a build download it or save it to their own GitHub account (step 3b).

1. **Bucket.** B2 → Buckets → Create a Bucket. Files in Bucket: **Private**. Default Encryption: **Enable** (SSE-B2). Object Lock: off. B2 bucket names are global, 6–50 letters, digits and hyphens.
2. **Lifecycle rules (backstop).** LinxGen removes expired files itself every 15 minutes, so lifecycle rules only catch files it missed. Under the bucket's Lifecycle Settings, choose custom rules with an empty file name prefix:

   ```json
   [{ "fileNamePrefix": "", "daysFromUploadingToHiding": 2, "daysFromHidingToDeleting": 1, "daysFromStartingToCancelingUnfinishedLargeFiles": 1 }]
   ```

   `daysFromUploadingToHiding` must stay above the retention plus the six-hour hold an active save may add. With the default 24 hours, 2 is enough. If an admin raises the retention, raise it to at least `ceil((retention hours + 6) / 24) + 1`, or files can vanish while LinxGen still lists them.
3. **Application key.** B2 → Application Keys → Add a New Application Key. Allow access to this bucket only, type of access **Read and Write**, no file name prefix. Copy `keyID` into `STORAGE_ACCESS_KEY_ID` and `applicationKey` into `STORAGE_SECRET_ACCESS_KEY`; B2 shows the application key once. Read and Write includes `deleteFiles`, which LinxGen needs to remove every version of a file.
4. **Endpoint.** The bucket page shows `Endpoint: s3.<region>.backblazeb2.com`. Set `STORAGE_S3_ENDPOINT` to that host with `https://` in front.

No CORS rule is needed: browsers download by navigating to a presigned GET URL (valid for 10 minutes), and only runners upload, through presigned multipart PUT URLs (valid for 15 minutes; parts are at least 5 MB, at most 10,000 per file).

**Cost.** B2 includes 10 GB of storage for free. The admin setting *Temporary storage limit* (default 9 GiB) caps what LinxGen keeps at once: a build whose upload would go over it fails with `storage_full` and the member is asked to try again after older builds expire. Downloads are free up to three times the average amount stored per month, then $0.01 per GB. Uploads, downloads, HEAD requests and deletes are free transactions, and presigning happens inside LinxGen without calling B2. Listing calls such as `ListObjectVersions` are Class D: the first 2,500 a day are free, then $0.004 per 10,000. LinxGen lists versions once per deleted file (twice for the `setup:verify` probe), which stays well below that for normal use. Enter a payment method in B2 only if you raise the limit above the free tier, and set a B2 cap alert so a mistake cannot run up a bill.
## 3. GitHub App and workflow

1. Push this repository (or just `builder/`, `packages/`, the root workspace files, `.github/workflows/linxgen-build.yml` and `.github/workflows/linxgen-save.yml`) to the build repository named in `GITHUB_REPOSITORY`. **This publishes the workflow.**
2. Create a GitHub App with **only** the repository permission `Actions: Read and write`. No webhooks and no user permissions are needed. Install it on the build repository only. **This grants permissions.**
3. In the build repository, set these repository variables (Settings → Secrets and variables → Actions → Variables):
   - `LINXGEN_API_URL`: the Convex **site** URL, for example `https://your-deployment.convex.site`.
   - `LINXGEN_RUNNER_LABELS` (optional): JSON runner labels, for example `["ubuntu-24.04"]`. Larger or self-hosted runners may cost money; **choosing paid runners needs explicit approval.** Self-hosted runners need Docker, passwordless `sudo`, privileged containers and `/dev/kvm`, and enough free disk space: the workflow does not clean up self-hosted machines.
   - `LINXGEN_SAVE_RUNNER_LABELS` (optional): JSON runner labels for save jobs. Default `["ubuntu-24.04"]`.
   - `LINXGEN_OIDC_AUDIENCE` (optional): only if you changed `RUNNER_OIDC_AUDIENCE`.
4. The workflow needs no repository secrets. The runner authenticates with OIDC (`id-token: write`) and a nonce that is valid for one attempt only.

Standard GitHub-hosted `ubuntu-24.04` runners provide Docker, privileged containers and `/dev/kvm`. A full ISO plus container build typically takes 20–60 minutes. XFCE builds are larger and slower. On GitHub-hosted runners only, the workflow first frees about 20 GB of preinstalled tooling. The job timeout is 360 minutes, so the build timeout setting is capped at 330 minutes.

## 3b. LinxGen Storage GitHub App (optional)

Members can copy a finished build to a private repository in **their own** GitHub account, as a release, so it outlives the 24-hour temporary storage. This uses a second GitHub App, separate from the build app, because it is installed by each member on their own account.

1. Create a GitHub App, for example named "LinxGen Storage" (github.com/settings/apps/new). **This creates an app that members will grant access to their accounts.**
   - Homepage URL: the web app URL (`SITE_URL`).
   - Callback URL: `<SITE_URL>/settings/github/callback`. Tick **Request user authorization (OAuth) during installation**. Leave "Expire user authorization tokens" on.
   - Setup URL: leave empty (GitHub sends members to the callback URL instead when OAuth during installation is on). Tick **Redirect on update** if GitHub offers it, so members who change an existing installation also come back to LinxGen.
   - Webhook: untick **Active**. No webhook is needed.
   - Repository permissions: **Administration: Read and write** (to create the private storage repository), **Contents: Read and write** (to create releases and upload files), Metadata: Read-only (always on). No other repository, organization or account permissions.
   - Where can this app be installed: **Any account**.
2. Generate a client secret and a private key on the app's page.
3. Set `STORAGE_GITHUB_APP_ID`, `STORAGE_GITHUB_APP_SLUG` (the app's URL name), `STORAGE_GITHUB_APP_CLIENT_ID`, `STORAGE_GITHUB_APP_CLIENT_SECRET` and `STORAGE_GITHUB_APP_PRIVATE_KEY` on Convex (`scripts/configure-production.sh` asks for them).
4. Push `.github/workflows/linxgen-save.yml` to the build repository with the build workflow. The build app dispatches it, so it needs no new permissions there.

How connecting works:

- Settings → **Connect GitHub** opens the app's install page with a one-time `state` (stored hashed, bound to the member, valid for 10 minutes). After installing, GitHub sends the member to the callback with an OAuth `code`. The backend exchanges the code, then looks up the member, their installation of the app and the repository with the member's own token. It never trusts an `installation_id` from the redirect.
- GitHub does not always pass `state` back after an installation, for example when the member changes an existing installation. The callback then offers **Continue**, which starts a plain authorization with a fresh `state`.
- LinxGen creates `<login>/storage` (or `STORAGE_REPO_NAME`) as a **private** repository with the topic `linxgen-storage`. An existing repository with that name is used only if it is private, owned by the member, and has that topic; otherwise the member is asked to rename it. If the member installed the app on selected repositories only, LinxGen cannot create the repository; the member either grants all repositories or creates the private repository with the topic and adds it to the installation.
- Organizations are not supported; the app must be installed on the member's personal account.
- **Disconnect** removes the link in LinxGen only. The app stays installed and the repository and its releases stay in the member's account until they remove them on GitHub.

How saving works: a save job (`linxgen-save.yml`) claims the save with an OIDC token for that workflow file and a per-attempt nonce, downloads the files with presigned URLs, checks each file's SHA-256 against the value recorded at upload, and uploads them to a release tagged `linxgen-<buildId>`. Files of 1.9 GiB or more are split into `.part01`, `.part02`, … assets (GitHub refuses assets of 2 GiB or more), and a `SHA256SUMS` file lists the original files. Rebuild a split file with `cat name.part* > name` and check it with `sha256sum -c SHA256SUMS`. The job receives a repository token limited to the member's storage repository with Contents write only, valid for one hour and refreshed when needed. While a save runs, its files are kept up to six hours past their expiry.
## 4. Web app on Vercel

The web app lives in the `linux-build-frontend` repository. Create a Vercel project from that repository with the repository root as the root directory and framework Next.js. Install command: `pnpm install --frozen-lockfile`. Build command: `pnpm build`. Environment variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_CONVEX_URL` | `https://your-deployment.convex.cloud` |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | `https://your-deployment.convex.site` |

Both variables must be present at build time as well as at runtime. `next build` fails without them, because the Better Auth server helper validates them when the app loads.

**Deploying needs explicit approval.** After you deploy, set `SITE_URL` in Convex to the production URL.

## Authorization checklist

Each of these needs a yes from the project owner before anyone carries it out:

- [ ] Create the Convex production deployment and set its environment variables
- [ ] Create the Backblaze B2 bucket, its lifecycle rules and its bucket-scoped application key
- [ ] Create and install the GitHub App (Actions read/write on one repository)
- [ ] Publish `.github/workflows/linxgen-build.yml` and `.github/workflows/linxgen-save.yml` to the build repository
- [ ] Optional: create the LinxGen Storage GitHub App (Administration and Contents write on members' repositories they choose to grant)
- [ ] Choose runner labels (paid larger runners need separate approval)
- [ ] Deploy the web app to Vercel
- [ ] Set `OWNER_EMAIL` and run `admin:bootstrapAdmin` for the owner
- [ ] Run `setup:verify` (it writes and deletes a probe object in B2 and sends one tiny Ollama request)
