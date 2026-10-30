import { z } from "zod";
import { CAPABILITY_SUMMARY, findPackagePolicyViolations } from "./capabilities";
import {
  ARCHITECTURES,
  DOCUMENTED_DEFAULTS,
  OUTPUTS,
  PACKAGE_NAME_PATTERN,
  PROFILES,
  SPEC_LIMITS,
  SPEC_SCHEMA_VERSION,
  SUPPORTED_DISTROS,
  buildSpecSchema,
  canonicalOutputs,
  type BuildPreferences,
  type BuildSpec,
  type Distro,
  type OutputType,
  type Profile,
  type ResolvedBuildSpec,
} from "./spec";

/** Loose shape the model fills in. Values are checked against capabilities afterwards so we can tell malformed output from unsupported requests. */
export const specDraftSchema = z
  .object({
    schemaVersion: z.number().int().optional(),
    name: z.string().max(200).optional(),
    distro: z.object({ family: z.string().max(40), release: z.string().max(20) }).strict().optional(),
    architecture: z.string().max(20).optional(),
    profile: z.string().max(40).optional(),
    packages: z.array(z.string().max(120)).max(400).optional(),
    outputs: z.array(z.string().max(20)).max(5).optional(),
    hostname: z.string().max(100).optional(),
    timezone: z.string().max(100).optional(),
    locale: z.string().max(50).optional(),
  })
  .strict();

export const inferredDefaultSchema = z
  .object({
    field: z.string().max(40),
    value: z.string().max(200),
    reason: z.string().max(300),
  })
  .strict();
export type InferredDefault = z.infer<typeof inferredDefaultSchema>;

export const unsupportedRequirementSchema = z
  .object({
    requirement: z.string().max(300),
    reason: z.string().max(500),
  })
  .strict();
export type UnsupportedRequirement = z.infer<typeof unsupportedRequirementSchema>;

export const aiResponseSchema = z
  .object({
    spec: specDraftSchema,
    inferredDefaults: z.array(inferredDefaultSchema).max(20).optional(),
    unsupported: z.array(unsupportedRequirementSchema).max(20).optional(),
  })
  .strict();
export type AiResponse = z.infer<typeof aiResponseSchema>;

export const MAX_AI_OUTPUT_CHARS = 64_000;

export function aiResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(aiResponseSchema, { io: "input", target: "draft-7" }) as Record<string, unknown>;
}

export type AiEvaluation =
  | { kind: "malformed"; issues: string[] }
  | { kind: "unsupported"; reasons: UnsupportedRequirement[] }
  | { kind: "candidate"; spec: BuildSpec; inferredDefaults: InferredDefault[] };

export function effectiveDefaults(preferences?: BuildPreferences) {
  return {
    distro: preferences?.distro ?? DOCUMENTED_DEFAULTS.distro,
    architecture: DOCUMENTED_DEFAULTS.architecture,
    profile: preferences?.profile ?? DOCUMENTED_DEFAULTS.profile,
    outputs: canonicalOutputs(preferences?.outputs ?? DOCUMENTED_DEFAULTS.outputs),
  };
}

export function buildSystemPrompt(preferences?: BuildPreferences): string {
  const d = effectiveDefaults(preferences);
  return [
    "You translate a user's description of a Linux system into a JSON build specification for LinxGen.",
    "Respond with a single JSON object only. No prose, no markdown, no code fences, no shell commands, no Dockerfiles.",
    "",
    "Response shape:",
    '{ "spec": { ... }, "inferredDefaults": [{ "field", "value", "reason" }], "unsupported": [{ "requirement", "reason" }] }',
    "",
    "spec fields:",
    `- schemaVersion: always ${SPEC_SCHEMA_VERSION}`,
    `- name: short human-readable name, max ${SPEC_LIMITS.maxNameLength} characters, letters, digits, spaces and . _ ( ) + -`,
    `- distro: one of ${SUPPORTED_DISTROS.map((x) => `{"family":"${x.family}","release":"${x.release}"}`).join(" or ")}`,
    `- architecture: "${ARCHITECTURES.join('" | "')}"`,
    `- profile: "minimal" (headless, no GUI) or "xfce" (XFCE desktop with LightDM)`,
    `- packages: exact binary package names from the official archive of the chosen distro (Debian: main; Ubuntu: main and universe), max ${SPEC_LIMITS.maxPackages}. Do not include kernels, bootloaders, live-boot tooling, init systems, or desktop/profile packages; the builder supplies those.`,
    `- outputs: any of ${OUTPUTS.map((o) => `"${o}"`).join(", ")}. "iso" is a bootable live ISO; "container" is an image archive for docker load.`,
    `- hostname (optional): lowercase RFC 1123 label`,
    `- timezone (optional): IANA zone such as "Europe/Berlin" or "UTC"`,
    `- locale (optional): such as "en_US.UTF-8"`,
    "",
    "Defaults for anything the user did not specify:",
    `- distro: ${JSON.stringify(d.distro)}`,
    `- architecture: "${d.architecture}"`,
    `- profile: "${d.profile}"`,
    `- outputs: ${JSON.stringify(d.outputs)}`,
    "Explicit user requirements always take precedence over these defaults.",
    "List every default you applied in inferredDefaults with a short reason.",
    "",
    "Supported capabilities:",
    ...CAPABILITY_SUMMARY.distros.map((x) => `- distro: ${x}`),
    ...CAPABILITY_SUMMARY.profiles.map((x) => `- profile: ${x}`),
    ...CAPABILITY_SUMMARY.outputs.map((x) => `- output: ${x}`),
    "Not supported:",
    ...CAPABILITY_SUMMARY.notSupported.map((x) => `- ${x}`),
    "",
    "If the user asks for anything outside the supported capabilities (another distro, architecture, desktop environment, custom scripts, third-party repositories, etc.),",
    "do NOT substitute something else and do NOT drop it silently. Add an entry to unsupported describing the requirement and why, and still return your best spec.",
    "Map software requests to real package names (for example: Node.js -> nodejs and npm, Python -> python3, Neovim -> neovim, Docker -> docker.io).",
  ].join("\n");
}

export function buildUserMessage(prompt: string): string {
  return `User request:\n"""\n${prompt.slice(0, SPEC_LIMITS.maxPromptLength)}\n"""`;
}

export function buildRepairMessage(issues: readonly string[]): string {
  return [
    "Your previous response could not be accepted:",
    ...issues.slice(0, 20).map((i) => `- ${i}`),
    "Return the complete corrected JSON object only.",
  ].join("\n");
}

/** Extracts a JSON object from model text that may include code fences or stray prose. */
export function extractJsonObject(text: string): unknown {
  if (text.length > MAX_AI_OUTPUT_CHARS) throw new Error("Response is too long");
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1] !== undefined) body = fence[1].trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error("Response is not valid JSON");
  }
}

/** The response schema is at most four levels deep; anything much deeper is malformed. */
export const MAX_AI_JSON_DEPTH = 32;

class NestingTooDeepError extends Error {}

function stripNulls(value: unknown, depth = 0): unknown {
  if (depth > MAX_AI_JSON_DEPTH) throw new NestingTooDeepError(`Response is nested more than ${MAX_AI_JSON_DEPTH} levels deep`);
  if (Array.isArray(value)) return value.filter((v) => v !== null).map((v) => stripNulls(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNulls(v, depth + 1)]),
    );
  }
  return value;
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/**
 * Lists the defaults that final resolution filled in (hostname, timezone, locale) and that are not already
 * recorded, so every choice LinxGen made is shown with the build.
 */
export function withResolvedDefaults(
  inferred: readonly InferredDefault[],
  spec: BuildSpec,
  resolved: ResolvedBuildSpec,
): InferredDefault[] {
  const out = [...inferred];
  const known = new Set(inferred.map((d) => d.field));
  const add = (field: "hostname" | "timezone" | "locale", reason: string) => {
    if (spec[field] === undefined && !known.has(field)) out.push({ field, value: resolved[field], reason });
  };
  add("hostname", "Not specified in the request; derived from the system name.");
  add("timezone", "Not specified in the request; applied the default.");
  add("locale", "Not specified in the request; applied the default.");
  return out;
}

export function evaluateAiOutput(text: string, preferences?: BuildPreferences): AiEvaluation {
  let raw: unknown;
  try {
    raw = extractJsonObject(text);
  } catch (e) {
    return { kind: "malformed", issues: [(e as Error).message] };
  }
  let normalized: unknown;
  try {
    normalized = stripNulls(raw);
  } catch (e) {
    if (e instanceof NestingTooDeepError) return { kind: "malformed", issues: [e.message] };
    throw e;
  }
  const parsed = aiResponseSchema.safeParse(normalized);
  if (!parsed.success) return { kind: "malformed", issues: formatZodIssues(parsed.error) };
  const response = parsed.data;

  if (response.unsupported && response.unsupported.length > 0) {
    return { kind: "unsupported", reasons: response.unsupported };
  }

  const draft = response.spec;
  const defaults = effectiveDefaults(preferences);
  const reasons: UnsupportedRequirement[] = [];
  const issues: string[] = [];
  const inferred = new Map<string, InferredDefault>();
  for (const item of response.inferredDefaults ?? []) inferred.set(item.field, item);
  const inferDefault = (field: string, value: unknown) => {
    if (!inferred.has(field)) {
      inferred.set(field, {
        field,
        value: typeof value === "string" ? value : JSON.stringify(value),
        reason: "Not specified in the request; applied the default.",
      });
    }
  };

  if (draft.schemaVersion !== undefined && draft.schemaVersion !== SPEC_SCHEMA_VERSION) {
    issues.push(`schemaVersion: must be ${SPEC_SCHEMA_VERSION}`);
  }

  let distro: Distro = defaults.distro;
  if (draft.distro) {
    const family = draft.distro.family.trim().toLowerCase();
    const release = draft.distro.release.trim();
    const match = SUPPORTED_DISTROS.find((d) => d.family === family && d.release === release);
    if (!match) {
      reasons.push({
        requirement: `Distribution ${draft.distro.family} ${draft.distro.release}`,
        reason: `Only ${SUPPORTED_DISTROS.map((d) => d.label).join(" and ")} are supported.`,
      });
    } else {
      distro = { family: match.family, release: match.release } as Distro;
    }
  } else {
    inferDefault("distro", defaults.distro);
  }

  if (draft.architecture !== undefined) {
    const arch = draft.architecture.trim().toLowerCase().replace(/^amd64$/, "x86_64");
    if (!(ARCHITECTURES as readonly string[]).includes(arch)) {
      reasons.push({ requirement: `Architecture ${draft.architecture}`, reason: "Only x86_64 is supported." });
    }
  } else {
    inferDefault("architecture", defaults.architecture);
  }

  let profile: Profile = defaults.profile;
  if (draft.profile !== undefined) {
    const p = draft.profile.trim().toLowerCase();
    if (!(PROFILES as readonly string[]).includes(p)) {
      reasons.push({
        requirement: `Profile ${draft.profile}`,
        reason: "Only the minimal (headless) and xfce (XFCE desktop) profiles are supported.",
      });
    } else {
      profile = p as Profile;
    }
  } else {
    inferDefault("profile", defaults.profile);
  }

  let outputs: OutputType[] = defaults.outputs;
  if (draft.outputs !== undefined && draft.outputs.length > 0) {
    const normalized = draft.outputs.map((o) => o.trim().toLowerCase());
    const unknown = normalized.filter((o) => !(OUTPUTS as readonly string[]).includes(o));
    if (unknown.length > 0) {
      reasons.push({
        requirement: `Output type ${unknown.join(", ")}`,
        reason: "Only bootable live ISOs and container image archives are supported.",
      });
    }
    outputs = canonicalOutputs(normalized.filter((o): o is OutputType => (OUTPUTS as readonly string[]).includes(o)));
  } else {
    inferDefault("outputs", defaults.outputs);
  }

  const packages = Array.from(new Set((draft.packages ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean)));
  const badNames = packages.filter((p) => !PACKAGE_NAME_PATTERN.test(p));
  if (badNames.length > 0) issues.push(`packages: invalid package names ${badNames.slice(0, 10).join(", ")}`);
  if (packages.length > SPEC_LIMITS.maxPackages) {
    reasons.push({
      requirement: `${packages.length} packages`,
      reason: `At most ${SPEC_LIMITS.maxPackages} packages are supported per build.`,
    });
  }
  for (const v of findPackagePolicyViolations(packages)) {
    reasons.push({ requirement: `Package ${v.packageName}`, reason: v.reason });
  }

  if (reasons.length > 0) return { kind: "unsupported", reasons };
  if (issues.length > 0) return { kind: "malformed", issues };

  let name = draft.name?.trim().replace(/\s+/g, " ").slice(0, SPEC_LIMITS.maxNameLength).trim();
  if (!name) {
    name = "Custom Linux";
    inferDefault("name", name);
  }

  const candidate = {
    schemaVersion: SPEC_SCHEMA_VERSION,
    name,
    distro,
    architecture: "x86_64" as const,
    profile,
    packages,
    outputs,
    ...(draft.hostname !== undefined ? { hostname: draft.hostname.trim().toLowerCase() } : {}),
    ...(draft.timezone !== undefined ? { timezone: draft.timezone.trim() } : {}),
    ...(draft.locale !== undefined ? { locale: draft.locale.trim() } : {}),
  };
  const strict = buildSpecSchema.safeParse(candidate);
  if (!strict.success) return { kind: "malformed", issues: formatZodIssues(strict.error) };

  return { kind: "candidate", spec: strict.data, inferredDefaults: Array.from(inferred.values()) };
}
