# Operations

## Limits and defaults

Admins can change these on the Admin page. They are stored in the `settings` table; the defaults live in `packages/backend/convex/lib/config.ts`.

| Setting | Default |
|---|---|
| Active builds per user | 1 |
| Active builds overall | 2 |
| Unfinished builds per user (including queued) | 3 |
| Build timeout | 120 minutes; at most 330. The build workflow's job timeout is 360 minutes (the GitHub-hosted maximum), which leaves room for runner setup and the final log upload and report. |
| Max artifact size | 6 GiB |
| Max log size | 200 MiB |
| Artifact retention | 7 days |
| Platform AI generations per user per day | 20 |

Personal AI connections do not count toward the platform generation quota.

Quotas and membership revocation look up a member's unfinished builds by status, so any number of newer finished builds cannot hide an older unfinished one.

## Sessions and AI selection

- Every member request checks the Better Auth session behind the Convex token, not just the token. Signing out, revoking a session or session expiry ends access right away, even though the token itself is still unexpired.
- If a member deletes the personal AI connection they have selected, the selection is kept and shown as missing in Settings and on the home page. New builds fail with `PROVIDER_MISSING` until the member picks a replacement. LinxGen does not move them to the platform provider.

## Build statuses

`generating → validating → queued → preparing → building → verifying → uploading → succeeded`. The terminal failure statuses are `failed`, `cancelled` and `timed_out`. Failures carry a code such as `unsupported_configuration`, `generation_failed`, `provider_error`, `dispatch_failed`, `runner_lost`, `build_failed`, `verification_failed`, `upload_failed`, `partial_outputs` or `timed_out`.

A runner that is lost before any output is verified gets one automatic new attempt. GitHub re-runs of a workflow are refused: the claim requires `run_attempt == 1`, so a new attempt always gets a new nonce.

## Toolchain pinning

- Base and toolchain images are pinned by digest in `builder/toolchain.lock.json`.
- Workflow actions are pinned to full commit SHAs.
- To refresh image digests, run `builder/refresh-toolchain.sh`. It needs Docker with buildx. Review the diff, run a full build of every distro, profile and output on a branch, then merge. Add the new workflow commit to `GITHUB_WORKFLOW_SHA_ALLOWLIST` if you use the allowlist.
- Distribution packages come from the official mirrors at build time. Their exact versions are recorded in each output's manifest artifact.

## Runner protocol

All routes are `POST` under the Convex site URL. Schemas are in `packages/spec/src/runner-protocol.ts`.

| Route | Auth | Purpose |
|---|---|---|
| `/runner/claim` | GitHub OIDC token + dispatch nonce | Claim the attempt; returns the capability token, spec and limits |
| `/runner/events` | capability | Stage changes, events and log lines with an increasing `seq`; the response says whether cancellation was requested. The runner sends a batch at least once a minute, empty if there is nothing else, as its heartbeat |
| `/runner/uploads/start` | capability | Register an artifact (kind, name, size, sha256) and create the R2 multipart upload |
| `/runner/uploads/parts` | capability | Presigned part URLs, up to 50 per call |
| `/runner/uploads/complete` | capability | Complete the upload; the backend checks the stored size. Retrying after a lost response is safe: an object R2 already assembled at the expected size is accepted |
| `/runner/finish` | capability | Per-output verification results and the final status |

The capability token works only for its attempt and expires after the build deadline plus a grace period. Requests from stale or superseded attempts are rejected with `409`.

The workflow is dispatched with two inputs only, `attempt_id` and `dispatch_nonce`. The build id comes from the claim response.

Log limits: one events batch carries at most 500 lines and 256 KiB of UTF-8 log text (`MAX_LOG_BATCH_BYTES`); larger batches are rejected with `413 log_batch_too_large`. The backend keeps the newest 300 batches per attempt for the live log, and the web log viewer shows at most the newest 50,000 lines. The complete log, capped at the maximum log size including its truncation notice, is uploaded as an artifact when the build finishes.

Reconciliation decisions are bound to the state they observed: an attempt is marked lost only if its status and last heartbeat are unchanged since the GitHub lookup, and a build is timed out only if it still runs the same attempt under the same deadline. The GitHub run is cancelled only after that decision is recorded.

## Builder scripts

| Script | Runs as | Purpose |
|---|---|---|
| `builder/host-setup.sh` | root on the runner | Installs QEMU and OVMF and enables KVM |
| `builder/build-iso.sh` | root | Starts the pinned toolchain container, which runs `debian/iso.sh` or `ubuntu/iso.sh` |
| `builder/container/build.sh` | root | Builds and saves the container image from the fixed `Dockerfile` |
| `builder/verify/iso-boot.sh` | runner user | Boots the ISO in QEMU (BIOS or UEFI) and waits for the serial boot marker |
| `builder/verify/container-smoke.sh` | root | Loads the archive and runs the smoke test with `--network none` |

Scripts read `build.env` as literal `KEY=value` lines and never evaluate them. They check every value again (hostname, timezone, locale, package names) even though the backend already validated the spec.

Container images are built with `--platform linux/amd64`, and the build fails if the resulting image has another architecture. The image sets `LANG` to the requested locale. The smoke test runs with the hostname from `build.env`, compares canonical paths for the timezone (so aliases such as `UTC` → `Etc/UTC` pass), and checks that the effective `LANG` is the requested locale and loads without warnings.

## Troubleshooting

- **Builds stay queued.** Check the global active limit and the Admin "Operational errors" list for dispatch failures, such as a missing GitHub App installation or a wrong `GITHUB_WORKFLOW_REF`.
- **Claim returns 401.** The OIDC claims do not match `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_FILE`/`GITHUB_WORKFLOW_REF`, the SHA allowlist or the audience.
- **Boot tests time out.** Without `/dev/kvm`, QEMU falls back to software emulation and timeouts are tripled. Check the serial log lines in the build log.
- **Personal provider fails.** The build fails with `provider_error`. Users can test connections in Settings. LinxGen never switches providers silently.
- **Submissions fail with `PROVIDER_MISSING`.** The member's selected personal connection was deleted. They need to choose another connection or the platform provider in Settings.
- **Self-hosted runners run out of disk.** The workflow's "Free disk space" step runs only on GitHub-hosted runners. On self-hosted machines it never deletes files or Docker images, so the operator has to keep enough free space.
