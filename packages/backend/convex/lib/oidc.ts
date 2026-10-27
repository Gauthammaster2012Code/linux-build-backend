import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface RunnerTrust {
  issuer: string;
  audience: string;
  repository: string;
  repositoryId?: string;
  workflowRef: string;
  allowedWorkflowShas: string[];
}

export interface RunnerIdentity {
  repository: string;
  runId: string;
  runAttempt: number;
  workflowSha: string;
  workflowRef: string;
  runnerEnvironment?: string;
}

export class RunnerAuthError extends Error {}

/** Checks GitHub Actions OIDC claims against the single trusted repository and workflow. */
export function checkRunnerClaims(payload: JWTPayload, trust: RunnerTrust): RunnerIdentity {
  const claim = (name: string) => {
    const v = (payload as Record<string, unknown>)[name];
    return typeof v === "string" ? v : undefined;
  };
  const repository = claim("repository");
  if (repository !== trust.repository) throw new RunnerAuthError("Untrusted repository");
  if (trust.repositoryId && claim("repository_id") !== trust.repositoryId) throw new RunnerAuthError("Repository id mismatch");
  if (claim("event_name") !== "workflow_dispatch") throw new RunnerAuthError("Runner must be started by workflow_dispatch");
  const workflowRef = claim("workflow_ref");
  if (workflowRef !== trust.workflowRef) throw new RunnerAuthError("Untrusted workflow");
  const jobWorkflowRef = claim("job_workflow_ref");
  if (jobWorkflowRef !== undefined && jobWorkflowRef !== trust.workflowRef) throw new RunnerAuthError("Untrusted job workflow");
  const workflowSha = claim("workflow_sha") ?? claim("sha");
  if (!workflowSha || !/^[a-f0-9]{40}$/.test(workflowSha)) throw new RunnerAuthError("Missing workflow revision");
  if (trust.allowedWorkflowShas.length > 0 && !trust.allowedWorkflowShas.includes(workflowSha)) {
    throw new RunnerAuthError("Workflow revision is not allowed");
  }
  const runId = claim("run_id");
  const runAttempt = Number(claim("run_attempt"));
  if (!runId || !/^\d+$/.test(runId) || !Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new RunnerAuthError("Missing run identity");
  }
  return { repository, runId, runAttempt, workflowSha, workflowRef, runnerEnvironment: claim("runner_environment") };
}

let remoteJwks: JWTVerifyGetKey | undefined;

export async function verifyRunnerOidcToken(
  token: string,
  trust: RunnerTrust,
  keys?: JWTVerifyGetKey,
): Promise<RunnerIdentity> {
  remoteJwks ??= createRemoteJWKSet(new URL(`${trust.issuer}/.well-known/jwks`));
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys ?? remoteJwks, {
      issuer: trust.issuer,
      audience: trust.audience,
      algorithms: ["RS256"],
      maxTokenAge: "15m",
    }));
  } catch {
    throw new RunnerAuthError("Invalid OIDC token");
  }
  return checkRunnerClaims(payload, trust);
}
