import { getDistroInfo, type Distro } from "@linxgen/spec";

export interface ResolvedPackage {
  name: string;
  version: string;
  component: string;
}

export interface PackageResolution {
  found: ResolvedPackage[];
  missing: string[];
}

export class ResolverUnavailableError extends Error {}

type FetchLike = typeof fetch;

/**
 * Parses `madison.php?text=on` output. Only binary packages from the requested suite's main component
 * that are built for amd64 or are architecture-independent count as found.
 */
export function parseMadison(text: string, codename: string): Map<string, ResolvedPackage> {
  const out = new Map<string, ResolvedPackage>();
  for (const line of text.split("\n")) {
    const cols = line.split("|").map((c) => c.trim());
    if (cols.length < 4) continue;
    const [name, version, suite, archList] = cols as [string, string, string, string];
    if (suite !== codename && suite !== `${codename}/main`) continue;
    const archs = archList.split(",").map((a) => a.trim());
    if (!archs.includes("amd64") && !archs.includes("all")) continue;
    if (!out.has(name)) out.set(name, { name, version, component: "main" });
  }
  return out;
}

export interface LaunchpadEntry {
  binary_package_name?: string;
  binary_package_version?: string;
  component_name?: string;
  pocket?: string;
  status?: string;
}

const UBUNTU_COMPONENTS = new Set(["main", "universe"]);
const UBUNTU_POCKETS = new Set(["Release", "Updates", "Security"]);

export function pickLaunchpadEntry(name: string, entries: LaunchpadEntry[]): ResolvedPackage | null {
  for (const e of entries) {
    if (e.binary_package_name !== name) continue;
    if (e.status && e.status !== "Published") continue;
    if (!e.component_name || !UBUNTU_COMPONENTS.has(e.component_name)) continue;
    if (!e.pocket || !UBUNTU_POCKETS.has(e.pocket)) continue;
    return { name, version: e.binary_package_version ?? "unknown", component: e.component_name };
  }
  return null;
}

async function fetchText(fetchImpl: FetchLike, url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { "User-Agent": "linxgen-v2" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ResolverUnavailableError("Package archive lookup failed");
  }
  if (!res.ok) throw new ResolverUnavailableError(`Package archive lookup returned ${res.status}`);
  return res.text();
}

async function resolveDebian(names: string[], codename: string, fetchImpl: FetchLike): Promise<PackageResolution> {
  const found = new Map<string, ResolvedPackage>();
  for (let i = 0; i < names.length; i += 40) {
    const batch = names.slice(i, i + 40);
    const url = `https://qa.debian.org/madison.php?package=${encodeURIComponent(batch.join(" "))}&table=debian&s=${codename}&text=on`;
    for (const [k, v] of parseMadison(await fetchText(fetchImpl, url), codename)) found.set(k, v);
  }
  return { found: names.flatMap((n) => found.get(n) ?? []), missing: names.filter((n) => !found.has(n)) };
}

async function resolveUbuntu(names: string[], series: string, fetchImpl: FetchLike): Promise<PackageResolution> {
  const found: ResolvedPackage[] = [];
  const missing: string[] = [];
  const archSeries = `https://api.launchpad.net/1.0/ubuntu/${series}/amd64`;
  for (let i = 0; i < names.length; i += 8) {
    const batch = names.slice(i, i + 8);
    const results = await Promise.all(
      batch.map(async (name) => {
        const url =
          `https://api.launchpad.net/1.0/ubuntu/+archive/primary?ws.op=getPublishedBinaries` +
          `&binary_name=${encodeURIComponent(name)}&exact_match=true&status=Published&ws.size=20` +
          `&distro_arch_series=${encodeURIComponent(archSeries)}`;
        const body = JSON.parse(await fetchText(fetchImpl, url)) as { entries?: LaunchpadEntry[] };
        return [name, pickLaunchpadEntry(name, body.entries ?? [])] as const;
      }),
    );
    for (const [name, pkg] of results) {
      if (pkg) found.push(pkg);
      else missing.push(name);
    }
  }
  return { found, missing };
}

/** Resolves package names against the approved official archive for the distro. */
export async function resolvePackagesInArchive(distro: Distro, names: string[], fetchImpl: FetchLike = fetch): Promise<PackageResolution> {
  if (names.length === 0) return { found: [], missing: [] };
  const info = getDistroInfo(distro);
  return distro.family === "debian"
    ? resolveDebian(names, info.codename, fetchImpl)
    : resolveUbuntu(names, info.codename, fetchImpl);
}
