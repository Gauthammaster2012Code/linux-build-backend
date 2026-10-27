import { z } from "zod";

export const SPEC_SCHEMA_VERSION = 1 as const;

export const DISTRO_FAMILIES = ["debian", "ubuntu"] as const;
export const PROFILES = ["minimal", "xfce"] as const;
export const OUTPUTS = ["iso", "container"] as const;
export const ARCHITECTURES = ["x86_64"] as const;

export type DistroFamily = (typeof DISTRO_FAMILIES)[number];
export type Profile = (typeof PROFILES)[number];
export type OutputType = (typeof OUTPUTS)[number];
export type Architecture = (typeof ARCHITECTURES)[number];

export interface DistroInfo {
  family: DistroFamily;
  release: string;
  codename: string;
  label: string;
  archiveArea: string;
}

export const SUPPORTED_DISTROS: readonly DistroInfo[] = [
  { family: "debian", release: "13", codename: "trixie", label: "Debian 13 (trixie)", archiveArea: "main" },
  { family: "ubuntu", release: "24.04", codename: "noble", label: "Ubuntu 24.04 LTS (noble)", archiveArea: "main universe" },
] as const;

export const SPEC_LIMITS = {
  maxPackages: 150,
  maxNameLength: 64,
  maxPromptLength: 4000,
} as const;

/** Debian policy package names: lowercase alphanumerics plus `+ - .`, at least two characters, starting alphanumeric. */
export const PACKAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9+.-]{1,99}$/;
export const SPEC_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()+-]*$/;
export const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const TIMEZONE_PATTERN = /^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;
export const LOCALE_PATTERN = /^[a-z]{2,3}_[A-Z]{2}\.UTF-8$/;

export const distroSchema = z.discriminatedUnion("family", [
  z.object({ family: z.literal("debian"), release: z.literal("13") }).strict(),
  z.object({ family: z.literal("ubuntu"), release: z.literal("24.04") }).strict(),
]);
export type Distro = z.infer<typeof distroSchema>;

export const packageNameSchema = z
  .string()
  .regex(PACKAGE_NAME_PATTERN, "Invalid Debian/Ubuntu package name");

const uniqueStrings = (values: readonly string[]) => new Set(values).size === values.length;

export const buildSpecSchema = z
  .object({
    schemaVersion: z.literal(SPEC_SCHEMA_VERSION),
    name: z.string().trim().min(1).max(SPEC_LIMITS.maxNameLength).regex(SPEC_NAME_PATTERN),
    distro: distroSchema,
    architecture: z.enum(ARCHITECTURES),
    profile: z.enum(PROFILES),
    packages: z
      .array(packageNameSchema)
      .max(SPEC_LIMITS.maxPackages)
      .refine(uniqueStrings, "Packages must be unique"),
    outputs: z
      .array(z.enum(OUTPUTS))
      .min(1)
      .max(OUTPUTS.length)
      .refine(uniqueStrings, "Outputs must be unique"),
    hostname: z.string().regex(HOSTNAME_PATTERN).optional(),
    timezone: z.string().regex(TIMEZONE_PATTERN).optional(),
    locale: z.string().regex(LOCALE_PATTERN).optional(),
  })
  .strict();
export type BuildSpec = z.infer<typeof buildSpecSchema>;

/** A spec with every optional field filled in. This is what the runner builds. */
export const resolvedBuildSpecSchema = buildSpecSchema.extend({
  hostname: z.string().regex(HOSTNAME_PATTERN),
  timezone: z.string().regex(TIMEZONE_PATTERN),
  locale: z.string().regex(LOCALE_PATTERN),
});
export type ResolvedBuildSpec = z.infer<typeof resolvedBuildSpecSchema>;

export const DOCUMENTED_DEFAULTS = {
  distro: { family: "debian", release: "13" } as Distro,
  architecture: "x86_64" as Architecture,
  profile: "minimal" as Profile,
  outputs: ["iso", "container"] as OutputType[],
  timezone: "UTC",
  locale: "en_US.UTF-8",
} as const;

/** User-chosen advanced defaults. They replace documented defaults but never explicit prompt requirements. */
export const buildPreferencesSchema = z
  .object({
    distro: distroSchema.optional(),
    profile: z.enum(PROFILES).optional(),
    outputs: z.array(z.enum(OUTPUTS)).min(1).max(2).refine(uniqueStrings).optional(),
  })
  .strict();
export type BuildPreferences = z.infer<typeof buildPreferencesSchema>;

export function getDistroInfo(distro: Distro): DistroInfo {
  const info = SUPPORTED_DISTROS.find((d) => d.family === distro.family && d.release === distro.release);
  if (!info) throw new Error(`Unsupported distro ${distro.family} ${distro.release}`);
  return info;
}

export function hostnameFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return HOSTNAME_PATTERN.test(slug) ? slug : "linxgen";
}

export function canonicalOutputs(outputs: readonly OutputType[]): OutputType[] {
  return OUTPUTS.filter((o) => outputs.includes(o));
}

export function resolveSpecDefaults(spec: BuildSpec): ResolvedBuildSpec {
  return resolvedBuildSpecSchema.parse({
    ...spec,
    outputs: canonicalOutputs(spec.outputs),
    hostname: spec.hostname ?? hostnameFromName(spec.name),
    timezone: spec.timezone ?? DOCUMENTED_DEFAULTS.timezone,
    locale: spec.locale ?? DOCUMENTED_DEFAULTS.locale,
  });
}

/** Stable JSON used for hashing and snapshotting. Keys are sorted recursively. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
