import { RunnerApi } from "./api";
import { readRunnerEnv, readToolchainLock } from "./config";
import { execCommand } from "./exec";
import { fetchOidcToken } from "./oidc";
import { runPipeline } from "./pipeline";

async function main() {
  const env = readRunnerEnv();
  const lock = readToolchainLock(env.builderDir);
  const api = new RunnerApi(env.apiUrl);
  const result = await runPipeline({
    env,
    lock,
    api,
    exec: execCommand,
    getOidcToken: () => fetchOidcToken(fetch, env.oidcRequestUrl, env.oidcRequestToken, env.audience),
    console: (line) => console.log(`[linxgen-runner] ${line}`),
    mask: (secret) => console.log(`::add-mask::${secret}`),
  });
  // A delivered result is authoritative in the backend; the job fails only if the result could not be reported.
  process.exitCode = result.finished ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(`[linxgen-runner] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
