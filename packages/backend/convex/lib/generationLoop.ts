import {
  buildRepairMessage,
  buildSystemPrompt,
  buildUserMessage,
  evaluateAiOutput,
  getDistroInfo,
  type BuildPreferences,
  type BuildSpec,
  type InferredDefault,
  type UnsupportedRequirement,
} from "@linxgen/spec";
import { ProviderError, type ChatMessage, type ChatResult } from "./providers";
import { ResolverUnavailableError, type PackageResolution, type ResolvedPackage } from "./packages";

export interface GenerationAttemptRecord {
  attempt: number;
  outcome: "malformed" | "unresolved_packages" | "unsupported" | "accepted" | "provider_error";
  issues: string[];
  inputTokens?: number;
  outputTokens?: number;
}

export type GenerationOutcome =
  | {
      kind: "accepted";
      spec: BuildSpec;
      inferredDefaults: InferredDefault[];
      resolvedPackages: ResolvedPackage[];
      attempts: GenerationAttemptRecord[];
    }
  | { kind: "unsupported"; reasons: UnsupportedRequirement[]; attempts: GenerationAttemptRecord[] }
  | { kind: "failed"; code: "generation_failed" | "provider_error"; message: string; attempts: GenerationAttemptRecord[] }
  | { kind: "cancelled"; attempts: GenerationAttemptRecord[] };

export interface GenerationDeps {
  prompt: string;
  preferences?: BuildPreferences;
  maxAttempts: number;
  callModel: (messages: ChatMessage[]) => Promise<ChatResult>;
  /** Returns null when archive resolution is disabled. */
  resolvePackages: (spec: BuildSpec) => Promise<PackageResolution | null>;
  /** Called before each model call and before validation; return false to stop. */
  shouldContinue?: (phase: "generating" | "validating", attempt: number) => Promise<boolean>;
}

const EXCERPT_CHARS = 8000;

/**
 * Turns a prompt into an accepted spec with a bounded number of model calls. Malformed output and unknown
 * package names are retried with feedback; capability violations end the request without substitution.
 */
export async function runGenerationLoop(deps: GenerationDeps): Promise<GenerationOutcome> {
  const attempts: GenerationAttemptRecord[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(deps.preferences) },
    { role: "user", content: buildUserMessage(deps.prompt) },
  ];
  let lastMissing: { distroLabel: string; names: string[] } | null = null;

  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    if (deps.shouldContinue && !(await deps.shouldContinue("generating", attempt))) return { kind: "cancelled", attempts };

    let result: ChatResult;
    try {
      result = await deps.callModel(messages);
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("The AI provider call failed.", null, true);
      attempts.push({ attempt, outcome: "provider_error", issues: [err.message] });
      if (!err.retryable || attempt === deps.maxAttempts) {
        return { kind: "failed", code: "provider_error", message: err.message, attempts };
      }
      continue;
    }

    if (deps.shouldContinue && !(await deps.shouldContinue("validating", attempt))) return { kind: "cancelled", attempts };

    const record: GenerationAttemptRecord = {
      attempt,
      outcome: "malformed",
      issues: [],
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
    attempts.push(record);

    const evaluation = evaluateAiOutput(result.text, deps.preferences);
    if (evaluation.kind === "unsupported") {
      record.outcome = "unsupported";
      record.issues = evaluation.reasons.map((r) => `${r.requirement}: ${r.reason}`);
      return { kind: "unsupported", reasons: evaluation.reasons, attempts };
    }
    if (evaluation.kind === "malformed") {
      record.issues = evaluation.issues;
      messages.push({ role: "assistant", content: result.text.slice(0, EXCERPT_CHARS) }, { role: "user", content: buildRepairMessage(evaluation.issues) });
      continue;
    }

    let resolution: PackageResolution | null;
    try {
      resolution = await deps.resolvePackages(evaluation.spec);
    } catch (e) {
      if (e instanceof ResolverUnavailableError) {
        return {
          kind: "failed",
          code: "generation_failed",
          message: "Could not verify package names against the distribution archive. Please retry later.",
          attempts,
        };
      }
      throw e;
    }

    if (resolution && resolution.missing.length > 0) {
      const distroLabel = getDistroInfo(evaluation.spec.distro).label;
      record.outcome = "unresolved_packages";
      record.issues = [`Packages not found in ${distroLabel}: ${resolution.missing.join(", ")}`];
      lastMissing = { distroLabel, names: resolution.missing };
      messages.push(
        { role: "assistant", content: result.text.slice(0, EXCERPT_CHARS) },
        {
          role: "user",
          content: buildRepairMessage([
            `These packages do not exist in the official ${distroLabel} archive for amd64: ${resolution.missing.join(", ")}.`,
            "Replace each with the exact official binary package name. If no official package provides the requested software, add it to unsupported instead.",
          ]),
        },
      );
      continue;
    }

    record.outcome = "accepted";
    return {
      kind: "accepted",
      spec: evaluation.spec,
      inferredDefaults: evaluation.inferredDefaults,
      resolvedPackages: resolution?.found ?? [],
      attempts,
    };
  }

  if (lastMissing && attempts.at(-1)?.outcome === "unresolved_packages") {
    return {
      kind: "unsupported",
      reasons: lastMissing.names.map((name) => ({
        requirement: `Package ${name}`,
        reason: `No package named ${name} exists in the official ${lastMissing!.distroLabel} archive.`,
      })),
      attempts,
    };
  }
  return {
    kind: "failed",
    code: "generation_failed",
    message: `The AI provider did not return a valid configuration after ${deps.maxAttempts} attempts.`,
    attempts,
  };
}
