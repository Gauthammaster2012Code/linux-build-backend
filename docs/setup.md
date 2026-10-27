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
| `BETTER_AUTH_SECRET` | yes | Random secret for Better Auth sessions: `openssl rand -base64 32`. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth app used for sign-in. Callback URL: `${SITE_URL}/api/auth/callback/github`. |
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
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | yes | Private R2 bucket and an API token scoped to that bucket with object read and write. |

### First administrator

LinxGen is invite-only. Create the first admin from the CLI. This either activates an existing profile or creates an admin invitation for that email:

```bash
npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}'
```

Then sign in with a GitHub account whose verified email matches. Later members are invited from the Admin page.

## 2. Cloudflare R2

Create a private bucket (no public access and no custom domain needed) and an API token limited to it. Downloads use presigned GET URLs that expire after 10 minutes. Uploads use presigned multipart PUT URLs that expire after 15 minutes. No CORS rule is needed: browsers download by navigating to the URL, and only the runner uploads.

Optional: add a lifecycle rule that aborts incomplete multipart uploads after 1 day. LinxGen also cleans them up itself.

## 3. GitHub App and workflow

1. Push this repository (or just `builder/`, `packages/`, the root workspace files and `.github/workflows/linxgen-build.yml`) to the build repository named in `GITHUB_REPOSITORY`. **This publishes the workflow.**
2. Create a GitHub App with **only** the repository permission `Actions: Read and write`. No webhooks and no user permissions are needed. Install it on the build repository only. **This grants permissions.**
3. In the build repository, set these repository variables (Settings → Secrets and variables → Actions → Variables):
   - `LINXGEN_API_URL`: the Convex **site** URL, for example `https://your-deployment.convex.site`.
   - `LINXGEN_RUNNER_LABELS` (optional): JSON runner labels, for example `["ubuntu-24.04"]`. Larger or self-hosted runners may cost money; **choosing paid runners needs explicit approval.** Self-hosted runners need Docker, passwordless `sudo`, privileged containers and `/dev/kvm`, and enough free disk space: the workflow does not clean up self-hosted machines.
   - `LINXGEN_OIDC_AUDIENCE` (optional): only if you changed `RUNNER_OIDC_AUDIENCE`.
4. The workflow needs no repository secrets. The runner authenticates with OIDC (`id-token: write`) and a nonce that is valid for one attempt only.

Standard GitHub-hosted `ubuntu-24.04` runners provide Docker, privileged containers and `/dev/kvm`. A full ISO plus container build typically takes 20–60 minutes. XFCE builds are larger and slower. On GitHub-hosted runners only, the workflow first frees about 20 GB of preinstalled tooling. The job timeout is 360 minutes, so the build timeout setting is capped at 330 minutes.

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
- [ ] Create the R2 bucket and its scoped API token
- [ ] Create the GitHub OAuth app (sign-in)
- [ ] Create and install the GitHub App (Actions read/write on one repository)
- [ ] Publish `.github/workflows/linxgen-build.yml` to the build repository
- [ ] Choose runner labels (paid larger runners need separate approval)
- [ ] Deploy the web app to Vercel
- [ ] Run `admin:bootstrapAdmin` for the first administrator
