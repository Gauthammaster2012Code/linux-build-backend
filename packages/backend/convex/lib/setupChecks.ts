import {
  ConfigError,
  credentialKeyring,
  githubAppConfig,
  platformAi,
  runnerSecret,
  saveDispatchConfig,
  STORAGE_APP_VARS,
  storageAppConfig,
  storageConfig,
} from "./config";
import { base64ToBytes } from "./crypto";
import { getRepository, getWorkflow, GitHubError, installationToken } from "./github";
import { getStorageApp } from "./githubStorage";
import { ObjectStorage, StorageError } from "./objectStorage";
import { ProviderError, testProviderConnection } from "./providers";

/** One line of the setup report. `detail` never contains secret values. */
export interface SetupCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const REQUIRED_VARS = [
  "SITE_URL",
  "BETTER_AUTH_SECRET",
  "CREDENTIAL_ENCRYPTION_KEYS",
  "RUNNER_CAPABILITY_SECRET",
  "GITHUB_REPOSITORY",
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "STORAGE_S3_ENDPOINT",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_BUCKET",
] as const;

const LEGACY_VARS: Record<string, string> = {
  GITHUB_CLIENT_ID: "No longer used (sign-in is email and password). You can remove it.",
  GITHUB_CLIENT_SECRET: "No longer used (sign-in is email and password). You can remove it.",
  R2_ACCOUNT_ID: "No longer used (temporary storage moved to Backblaze B2). You can remove it.",
  R2_ACCESS_KEY_ID: "No longer used (temporary storage moved to Backblaze B2). You can remove it.",
  R2_SECRET_ACCESS_KEY: "No longer used (temporary storage moved to Backblaze B2). You can remove it.",
  R2_BUCKET: "No longer used (temporary storage moved to Backblaze B2). You can remove it.",
};

const PROBE_PREFIX = "_linxgen-probe/";

function env(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

/** Error text that is safe to report. Unknown errors are reduced to their name so no response body or value leaks. */
function describe(e: unknown): string {
  if (e instanceof ConfigError || e instanceof GitHubError || e instanceof StorageError || e instanceof ProviderError) return e.message;
  return e instanceof Error ? `Unexpected ${e.name}` : "Unexpected error";
}

function checkSiteUrl(value: string): SetupCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { name: "env:SITE_URL", ok: false, detail: "Set, but not a valid URL." };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) return { name: "env:SITE_URL", ok: false, detail: "Must use https outside local development." };
  if (url.pathname !== "/" || url.search) return { name: "env:SITE_URL", ok: false, detail: "Must be an origin without a path, for example https://linxgen.example.com." };
  return { name: "env:SITE_URL", ok: true, detail: `Set to ${url.origin}.` };
}

function isPem(value: string): boolean {
  return /-----BEGIN (RSA )?PRIVATE KEY-----/.test(value.replace(/\\n/g, "\n"));
}

function checkVariable(name: (typeof REQUIRED_VARS)[number]): SetupCheck {
  const value = env(name);
  const check = (ok: boolean, detail: string) => ({ name: `env:${name}`, ok, detail });
  if (!value) return check(false, "Missing.");
  try {
    switch (name) {
      case "SITE_URL":
        return checkSiteUrl(value);
      case "BETTER_AUTH_SECRET":
        return value.length >= 32 ? check(true, "Set.") : check(false, "Set, but shorter than 32 characters.");
      case "CREDENTIAL_ENCRYPTION_KEYS": {
        const ring = credentialKeyring();
        const bad = Object.entries(ring.keys).filter(([, k]) => {
          try {
            return base64ToBytes(k).length !== 32;
          } catch {
            return true;
          }
        });
        if (bad.length) return check(false, `Key versions ${bad.map(([v]) => v).join(", ")} are not base64 of 32 bytes.`);
        return check(true, `Valid; current version ${ring.current}, ${Object.keys(ring.keys).length} key(s).`);
      }
      case "RUNNER_CAPABILITY_SECRET":
        runnerSecret();
        return check(true, "Set, at least 32 characters.");
      case "GITHUB_REPOSITORY":
        return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(value) ? check(true, `Set to ${value}.`) : check(false, "Set, but not in owner/name form.");
      case "GITHUB_APP_PRIVATE_KEY":
        return isPem(value) ? check(true, "Set, PEM format.") : check(false, "Set, but not a PEM private key.");
      case "STORAGE_S3_ENDPOINT": {
        const cfg = storageConfig();
        return check(true, `Set to ${cfg.endpoint} (region ${cfg.region}).`);
      }
      case "STORAGE_BUCKET":
        return /^[a-z0-9][a-z0-9-]{4,48}[a-z0-9]$/i.test(value)
          ? check(true, `Set to ${value}.`)
          : check(false, "Set, but B2 bucket names are 6-50 letters, digits and hyphens.");
      default:
        return check(true, "Set.");
    }
  } catch (e) {
    return check(false, describe(e));
  }
}

async function checkGitHub(): Promise<SetupCheck[]> {
  let cfg: ReturnType<typeof githubAppConfig>;
  try {
    cfg = githubAppConfig();
  } catch (e) {
    return [{ name: "github:app", ok: false, detail: `Skipped: ${describe(e)}` }];
  }
  let token: string;
  try {
    token = await installationToken(cfg);
  } catch (e) {
    const hint =
      e instanceof GitHubError && e.status === 422
        ? " The installation may not include the repository, or the app lacks Actions read and write."
        : "";
    return [{ name: "github:app", ok: false, detail: `Could not get an installation token: ${describe(e)}.${hint}` }];
  }
  const checks: SetupCheck[] = [{ name: "github:app", ok: true, detail: "Installation token issued for the build repository." }];
  try {
    const repo = await getRepository(cfg, token);
    if (!repo) {
      checks.push({ name: "github:repository", ok: false, detail: `The installation cannot see ${cfg.repository}.` });
      return checks;
    }
    checks.push({ name: "github:repository", ok: true, detail: `Visible: ${repo.fullName} (default branch ${repo.defaultBranch}).` });
    const workflow = await getWorkflow(cfg, token);
    const ref = cfg.workflowRef.replace(/^refs\/heads\//, "");
    if (!workflow) {
      checks.push({
        name: "github:workflow",
        ok: false,
        detail: `.github/workflows/${cfg.workflowFile} is not on ${repo.defaultBranch} yet. Push it before dispatching builds.`,
      });
    } else if (workflow.state !== "active") {
      checks.push({ name: "github:workflow", ok: false, detail: `${workflow.path} exists but is ${workflow.state}. Enable it in the Actions tab.` });
    } else if (ref !== repo.defaultBranch) {
      checks.push({
        name: "github:workflow",
        ok: true,
        detail: `${workflow.path} is active on ${repo.defaultBranch}. GITHUB_WORKFLOW_REF is ${cfg.workflowRef}; the app has no contents permission, so the file on that ref was not checked.`,
      });
    } else {
      checks.push({ name: "github:workflow", ok: true, detail: `${workflow.path} is active on ${ref}.` });
    }
  } catch (e) {
    checks.push({ name: "github:repository", ok: false, detail: describe(e) });
  }
  return checks;
}

async function checkStorage(): Promise<SetupCheck> {
  let storage: ObjectStorage;
  try {
    storage = new ObjectStorage(storageConfig());
  } catch (e) {
    return { name: "storage:bucket", ok: false, detail: `Skipped: ${describe(e)}` };
  }
  const key = `${PROBE_PREFIX}${crypto.randomUUID()}`;
  try {
    await storage.putObject(key, "ok", "text/plain");
    const head = await storage.headObject(key);
    if (!head || head.sizeBytes !== 2) return { name: "storage:bucket", ok: false, detail: "The probe object was written but could not be read back." };
    await storage.deleteObject(key);
    const left = await storage.listVersions(key);
    if (left.length > 0) {
      return {
        name: "storage:bucket",
        ok: false,
        detail: "The probe object could not be removed completely. The application key needs the deleteFiles capability (Read and Write access).",
      };
    }
    return { name: "storage:bucket", ok: true, detail: `Wrote, read and permanently deleted a probe object under ${PROBE_PREFIX}.` };
  } catch (e) {
    const hint =
      e instanceof StorageError && / (401|403)$/.test(e.message)
        ? " Check the application key, that it is limited to this bucket, and that STORAGE_S3_ENDPOINT matches the bucket's region."
        : "";
    return { name: "storage:bucket", ok: false, detail: `${describe(e)}.${hint}` };
  }
}

/** The optional "LinxGen Storage" app for saving builds to members' own GitHub accounts. */
async function checkStorageApp(): Promise<SetupCheck[]> {
  const set = STORAGE_APP_VARS.filter((name) => env(name));
  if (set.length === 0) {
    return [{ name: "github-storage:app", ok: true, detail: "Not configured (optional). Members cannot save builds to GitHub." }];
  }
  const missing = STORAGE_APP_VARS.filter((name) => !env(name));
  if (missing.length > 0) return [{ name: "github-storage:app", ok: false, detail: `Partly configured; missing ${missing.join(", ")}.` }];
  if (!isPem(env("STORAGE_GITHUB_APP_PRIVATE_KEY")!)) {
    return [{ name: "github-storage:app", ok: false, detail: "STORAGE_GITHUB_APP_PRIVATE_KEY is not a PEM private key." }];
  }
  const checks: SetupCheck[] = [];
  try {
    const cfg = storageAppConfig();
    const app = await getStorageApp(cfg);
    const problems: string[] = [];
    if (app.slug !== cfg.slug) problems.push(`STORAGE_GITHUB_APP_SLUG is ${cfg.slug} but the app's slug is ${app.slug}`);
    if (app.permissions.administration !== "write") problems.push("Administration must be Read and write (to create the private repository)");
    if (app.permissions.contents !== "write") problems.push("Contents must be Read and write (to upload release files)");
    const extra = Object.keys(app.permissions).filter((p) => !["administration", "contents", "metadata"].includes(p));
    if (extra.length > 0) problems.push(`remove permissions it does not need: ${extra.join(", ")}`);
    checks.push(
      problems.length > 0
        ? { name: "github-storage:app", ok: false, detail: `${problems.join("; ")}.` }
        : { name: "github-storage:app", ok: true, detail: `App ${app.slug} found with Administration and Contents write.` },
    );
  } catch (e) {
    checks.push({ name: "github-storage:app", ok: false, detail: `Could not read the storage app: ${describe(e)}` });
  }
  checks.push(await checkSaveWorkflow());
  return checks;
}

async function checkSaveWorkflow(): Promise<SetupCheck> {
  try {
    const cfg = saveDispatchConfig();
    const token = await installationToken(cfg);
    const workflow = await getWorkflow(cfg, token);
    if (!workflow) return { name: "github:save-workflow", ok: false, detail: `.github/workflows/${cfg.workflowFile} is not on the default branch yet. Push it before saving builds.` };
    if (workflow.state !== "active") return { name: "github:save-workflow", ok: false, detail: `${workflow.path} exists but is ${workflow.state}.` };
    return { name: "github:save-workflow", ok: true, detail: `${workflow.path} is active.` };
  } catch (e) {
    return { name: "github:save-workflow", ok: false, detail: `Skipped: ${describe(e)}` };
  }
}

async function checkOllama(): Promise<SetupCheck> {
  const ai = platformAi();
  if (!ai.apiKey) return { name: "ollama:platform", ok: true, detail: "PLATFORM_OLLAMA_API_KEY not set (optional). Members must add their own AI key." };
  try {
    await testProviderConnection({ provider: "ollama", apiKey: ai.apiKey, model: ai.model });
    return { name: "ollama:platform", ok: true, detail: `Key accepted; model ${ai.model} answered.` };
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 401 || e.status === 403)) {
      return { name: "ollama:platform", ok: false, detail: "Unauthorized: Ollama Cloud rejected PLATFORM_OLLAMA_API_KEY." };
    }
    return { name: "ollama:platform", ok: false, detail: describe(e) };
  }
}

/** Checks configuration and external services. Safe to run repeatedly; the only write is a storage probe object it deletes again. */
export async function verifySetup(): Promise<{ ok: boolean; checks: SetupCheck[] }> {
  const checks: SetupCheck[] = REQUIRED_VARS.map(checkVariable);
  for (const [name, detail] of Object.entries(LEGACY_VARS)) {
    if (env(name)) checks.push({ name: `env:${name}`, ok: true, detail });
  }
  const [github, storage, storageApp, ollama] = await Promise.all([checkGitHub(), checkStorage(), checkStorageApp(), checkOllama()]);
  checks.push(...github, storage, ...storageApp, ollama);
  return { ok: checks.every((c) => c.ok), checks };
}
