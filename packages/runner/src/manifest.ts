import { PACKAGE_NAME_PATTERN, type OutputType, type ResolvedBuildSpec } from "@linxgen/spec";

export type InstalledPackages = Map<string, string>;

/** Parses `dpkg-query -W -f='${Package}\t${Version}\n'` output. Malformed lines are ignored. */
export function parseDpkgManifest(tsv: string): InstalledPackages {
  const installed: InstalledPackages = new Map();
  for (const line of tsv.split("\n")) {
    const [name, version] = line.split("\t");
    if (!name || version === undefined || !PACKAGE_NAME_PATTERN.test(name)) continue;
    installed.set(name, version.trim().slice(0, 200));
  }
  return installed;
}

export function checkRequestedPackages(requested: readonly string[], installed: InstalledPackages) {
  const packages: { name: string; version: string }[] = [];
  const missing: string[] = [];
  for (const name of requested) {
    const version = installed.get(name);
    if (version === undefined || version === "") missing.push(name);
    else packages.push({ name, version });
  }
  return { present: missing.length === 0, packages, missing };
}

export interface ManifestDocument {
  manifestVersion: 1;
  output: OutputType;
  buildId: string;
  attemptId: string;
  builderRevision: string;
  distro: ResolvedBuildSpec["distro"];
  profile: ResolvedBuildSpec["profile"];
  baseImage: string;
  toolchain: Record<string, string>;
  requestedPackages: { name: string; version: string }[];
  installedPackages: { name: string; version: string }[];
  artifact?: { fileName: string; sizeBytes: number; sha256: string };
}

export function buildManifest(input: Omit<ManifestDocument, "manifestVersion" | "installedPackages"> & { installed: InstalledPackages }): ManifestDocument {
  const { installed, ...rest } = input;
  return {
    manifestVersion: 1,
    ...rest,
    installedPackages: [...installed.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, version]) => ({ name, version })),
  };
}
