# LinxGen v2

Describe a Linux system in plain language. LinxGen turns the description into a validated build spec with a hosted AI model, builds it on a clean GitHub Actions runner, boot-tests it, and keeps verified artifacts for 24 hours in private Backblaze B2 storage. Users download them through short-lived signed links, or save them to a private repository in their own GitHub account with the optional LinxGen Storage app.

There are no clarification questions and no approval step. One prompt starts a build.

This repository holds the backend, runner, builder scripts and shared spec. The Next.js web app lives in the `linux-build-frontend` repository, which carries a copy of `packages/spec` and the Convex sources it needs for API types. Change those here first, then copy them across (see `shared/README.md` in the frontend repository).

## What it builds (v1)

| | Supported |
|---|---|
| Distributions | Debian 13 (trixie), Ubuntu 24.04 LTS (noble) |
| Architecture | x86_64 |
| Profiles | `minimal` (headless), `xfce` (XFCE + LightDM) |
| Outputs | `iso` (hybrid BIOS/UEFI live ISO), `container` (gzip image archive for `docker load`). Both are produced by default. |
| Packages | Official archive only (Debian `main`; Ubuntu `main` and `universe`) |

Not supported: installers or partitioning, Secure Boot, non-x86_64 architectures, custom scripts, Dockerfiles or files, third-party repositories or PPAs, other desktops, custom kernels or bootloaders, and registry publishing. Requests for these fail early with an "unsupported" result that explains why.

## How a build flows

1. **Generate.** The web app calls `generation.submit` with the prompt and a client request id. Repeated submissions with the same id return the same build. The selected AI provider returns structured JSON. Up to 3 attempts repair malformed output. LinxGen never silently switches to another provider: if the selected personal connection is deleted, submissions fail with `PROVIDER_MISSING` until the member chooses again.
2. **Validate.** The spec is checked against the shared zod schema (`packages/spec`) and the capability and package policy. Package names are checked against the archive. Defaults LinxGen fills in are recorded as "inferred defaults".
3. **Queue and dispatch.** The scheduler enforces 1 active build per user and 2 overall. It dispatches `.github/workflows/linxgen-build.yml` through a GitHub App with a per-attempt HMAC nonce.
4. **Claim.** The runner gets a GitHub OIDC token (audience `linxgen-runner`) and calls `/runner/claim`. The backend checks the repository, workflow ref, event, revision allowlist and nonce. It then issues a capability token scoped to that one attempt.
5. **Build.** `packages/runner` runs the `builder/` scripts with argument vectors (never a shell string). Each stage, event and log batch is streamed with a sequence number, within a 256 KiB per-batch log budget. During quiet steps such as boot tests and uploads the runner still sends a heartbeat batch every minute. Progress is only ever real stage changes, never a simulation.
   - Debian ISO: `live-build` inside the pinned `debian:trixie` image.
   - Ubuntu ISO: `debootstrap` rootfs, Casper, SquashFS and GRUB (BIOS + UEFI), assembled by `grub-mkrescue`/xorriso inside the pinned `ubuntu:24.04` image.
   - Container: a fixed Dockerfile template on the pinned base image, then `docker save | gzip`.
6. **Verify.** Each ISO boots in QEMU under SeaBIOS and under OVMF (UEFI). It must print `LINXGEN-BOOT-OK` on the serial console; for XFCE the display manager must also be active. Each container archive is loaded fresh and smoke-tested with networking disabled. Every requested package must be present in the installed manifest.
7. **Upload.** Only verified ISO and container files are uploaded, through presigned multipart URLs straight to B2, as long as temporary storage stays under its limit (otherwise the build fails with `storage_full`). Manifests and the full log are uploaded too. The backend checks the stored size before it records an artifact.
8. **Finish.** The build becomes `succeeded` only if every requested output is verified. Partial results are reported as `partial_outputs`. An explicit runner failure, such as a timeout during the final uploads, takes precedence even if every image was verified. Artifacts expire 24 hours after the build finishes.
9. **Save (optional).** A member who connected GitHub can save a finished build, or turn on automatic saving. `.github/workflows/linxgen-save.yml` downloads the files, checks their SHA-256 and uploads them as release assets to the member's private storage repository, splitting files of 1.9 GiB or more into parts.

Cancellation, runner loss, dispatch uncertainty, timeouts and cleanup are handled by Convex cron jobs (`convex/crons.ts`, `convex/maintenance.ts`, `convex/orchestrator.ts`).

## Repository layout

```
packages/spec       Shared build spec schema, defaults, capabilities, lifecycle, runner protocol
packages/backend    Convex backend: auth, invitations, AI pipeline, orchestration, runner HTTP API, B2 storage, GitHub saves
packages/runner     Runner client used inside GitHub Actions (bundled with esbuild)
builder/            Build, verification and toolchain scripts (bash, shellchecked)
.github/workflows   linxgen-build.yml (build runner), linxgen-save.yml (save runner) and ci.yml (checks)
docs/               Setup, configuration and operations
```

## Local development

Requires Node 22.12+ (CI uses 24) and pnpm 12.

```bash
pnpm install
pnpm check          # typecheck + lint + tests for every package
pnpm shellcheck     # builder scripts
```

To run the backend locally against an anonymous local Convex deployment:

```bash
cd packages/backend
CONVEX_AGENT_MODE=anonymous npx convex dev
```

Then start the web app from the `linux-build-frontend` repository with `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL` pointing at that deployment. Set `SITE_URL` (for example `http://localhost:3000`), `BETTER_AUTH_SECRET` and `OWNER_EMAIL` (your email; only that account can issue invite codes) on the local deployment, then create an invite code for yourself with `npx convex run admin:bootstrapAdmin '{"email":"you@example.com"}'` and create an account with it.

Sign-in is email and password, invite-only (see [docs/setup.md](docs/setup.md#sign-in-and-invitations)). Builds, AI generation and downloads need the external services in [docs/setup.md](docs/setup.md). Without them the app runs, but those features return clear "not configured" errors. `npx convex run setup:verify` reports what is missing.

## Testing scope

- `packages/spec`: schema, defaults, policy, log batch byte budget, verification rules and AI output evaluation, including deeply nested output (unit tests).
- `packages/backend`: crypto, OIDC claim checks, GitHub helpers, B2 signing and multipart completion recovery, storage budget, save scheduling and release text, the storage app's repository checks, the generation loop and `setup:verify` with fake services (unit tests). Sign-up gating through the real Better Auth HTTP routes (missing, wrong, expired, revoked, reused and other-email codes), invite redemption and its attempt limit, owner-only invitations and owner protection, sign-in rate limits, disabled routes, `bootstrapAdmin`, the lifecycle, Better Auth session checks (with the registered Better Auth component), quotas, dedup, claims, events and log limits, uploads, finish and failure codes, cancel, reconciliation guards, provider selection, settings bounds, retention and save holds, GitHub connect and the save lifecycle use `convex-test`.
- `packages/runner`: workspace rendering, manifests, argument-safe exec, HTTP retries, sequenced reporting with heartbeats and byte-bounded batches, multipart upload and worker settlement, the full pipeline with fake builders (success, boot failure, missing packages, build and upload failure, full storage, cancellation, a missing work root), and the save job against fake storage and GitHub (split parts, `SHA256SUMS`, checksum mismatch, expired URLs, token refresh, release reuse and refusal of foreign releases, partial asset cleanup, cancellation, log masking).
- `builder/`: checked statically with shellcheck. Real ISO and container builds and the QEMU boot tests run only on a GitHub Actions runner; they need Docker, privileged containers and KVM.

## Further reading

- [docs/setup.md](docs/setup.md): provisioning, environment variables, and the steps that need explicit authorization
- [docs/operations.md](docs/operations.md): limits, the toolchain refresh, the runner protocol and troubleshooting
