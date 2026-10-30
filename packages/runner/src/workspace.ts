import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  BUILDER_BASE_PACKAGES,
  getDistroInfo,
  PROFILE_PACKAGES,
  resolvedBuildSpecSchema,
  type OutputType,
  type ResolvedBuildSpec,
} from "@linxgen/spec";
import type { ToolchainLock } from "./config";

export interface WorkspaceFiles {
  buildEnv: string;
  lists: Record<"iso" | "container" | "requested", string[]>;
  imageKey: string;
}

const unique = (names: string[]) => [...new Set(names)];

export function imageKeyFor(spec: ResolvedBuildSpec): string {
  return `${spec.distro.family}-${spec.distro.release}`;
}

export function packageListFor(spec: ResolvedBuildSpec, output: OutputType): string[] {
  const family = spec.distro.family;
  return unique([...BUILDER_BASE_PACKAGES[family][output], ...PROFILE_PACKAGES[family][spec.profile], ...spec.packages]);
}

/** Renders the files the builder scripts consume. Scripts read KEY=value lines literally and never evaluate them. */
export function renderWorkspace(
  rawSpec: ResolvedBuildSpec,
  ids: { buildId: string; attemptId: string },
  lock: ToolchainLock,
): WorkspaceFiles {
  const spec = resolvedBuildSpecSchema.parse(rawSpec);
  const info = getDistroInfo(spec.distro);
  const imageKey = imageKeyFor(spec);
  const image = lock.images[imageKey];
  if (!image) throw new Error(`No pinned image for ${imageKey}`);
  const mirrors =
    spec.distro.family === "debian"
      ? { main: lock.mirrors.debian, security: lock.mirrors.debianSecurity }
      : { main: lock.mirrors.ubuntu, security: lock.mirrors.ubuntuSecurity };
  const values: Record<string, string> = {
    BUILD_ID: ids.buildId,
    ATTEMPT_ID: ids.attemptId,
    DISTRO_FAMILY: spec.distro.family,
    DISTRO_RELEASE: spec.distro.release,
    DISTRO_CODENAME: info.codename,
    PROFILE: spec.profile,
    HOSTNAME: spec.hostname,
    TIMEZONE: spec.timezone,
    LOCALE: spec.locale,
    IMAGE_LABEL: spec.name,
    APT_RECOMMENDS: spec.profile === "xfce" ? "true" : "false",
    MIRROR: mirrors.main,
    SECURITY_MIRROR: mirrors.security,
    BASE_IMAGE: image,
    TOOLCHAIN_IMAGE: image,
  };
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n\0]/.test(value)) throw new Error(`${key} contains a control character`);
  }
  return {
    buildEnv: Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")
      .concat("\n"),
    lists: {
      iso: packageListFor(spec, "iso"),
      container: packageListFor(spec, "container"),
      requested: [...spec.packages],
    },
    imageKey,
  };
}

export function writeWorkspace(dir: string, files: WorkspaceFiles) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, "out"), { recursive: true });
  writeFileSync(path.join(dir, "build.env"), files.buildEnv);
  for (const [name, list] of Object.entries(files.lists)) {
    writeFileSync(path.join(dir, `packages.${name}.list`), list.length ? `${list.join("\n")}\n` : "");
  }
}

export function artifactFileName(spec: ResolvedBuildSpec, kind: "iso" | "container" | "manifest-iso" | "manifest-container") {
  const base = `${spec.hostname}-${spec.distro.family}${spec.distro.release}-amd64`;
  switch (kind) {
    case "iso":
      return `${base}.iso`;
    case "container":
      return `${base}-container.tar.gz`;
    case "manifest-iso":
      return `${base}-iso-manifest.json`;
    case "manifest-container":
      return `${base}-container-manifest.json`;
  }
}
