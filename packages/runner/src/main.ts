import { RunnerApi } from "./api";
import { isSaveMode, readRunnerEnv, readSaveEnv, readToolchainLock } from "./config";
import { execCommand } from "./exec";
import { fetchOidcToken } from "./oidc";
import { runPipeline } from "./pipeline";
import { runSave } from "./save";
import { SaveApi } from "./saveApi";

const log = (line: string) => console.log(`[linxgen-runner] ${line}`);
const mask = (secret: string) => console.log(`::add-mask::${secret}`);

async function build() {
  const env = readRunnerEnv();
  const lock = readToolchainLock(env.builderDir);
  const api = new RunnerApi(env.apiUrl);
  const result = await runPipeline({
    env,
    lock,
    api,
    exec: execCommand,
    getOidcToken: () => fetchOidcToken(fetch, env.oidcRequestUrl, env.oidcRequestToken, env.audience),
    console: log,
    mask,
  });
  // A delivered result is authoritative in the backend; the job fails only if the result could not be reported.
  process.exitCode = result.finished ? 0 : 1;
}

async function save() {
  const env = readSaveEnv();
  const result = await runSave({
    env,
    api: new SaveApi(env.apiUrl),
    getOidcToken: () => fetchOidcToken(fetch, env.oidcRequestUrl, env.oidcRequestToken, env.audience),
    console: log,
    mask,
  });
  process.exitCode = result.finished ? 0 : 1;
}

(isSaveMode() ? save() : build()).catch((e: unknown) => {
  console.error(`[linxgen-runner] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
