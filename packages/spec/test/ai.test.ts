import { describe, expect, it } from "vitest";
import {
  aiResponseJsonSchema,
  buildSystemPrompt,
  evaluateAiOutput,
  extractJsonObject,
  MAX_AI_JSON_DEPTH,
  MAX_AI_OUTPUT_CHARS,
  resolveSpecDefaults,
  withResolvedDefaults,
  type BuildSpec,
} from "../src";

const ok = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ spec, ...extra });

describe("extractJsonObject", () => {
  it("handles fences and surrounding prose", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go: {"a":1} thanks')).toEqual({ a: 1 });
  });
  it("throws on non-JSON", () => {
    expect(() => extractJsonObject("no json here")).toThrow();
  });
});

describe("evaluateAiOutput", () => {
  it("accepts a full spec", () => {
    const r = evaluateAiOutput(
      ok({
        schemaVersion: 1,
        name: "Developer Desktop",
        distro: { family: "ubuntu", release: "24.04" },
        architecture: "x86_64",
        profile: "xfce",
        packages: ["git", "curl", "neovim"],
        outputs: ["iso", "container"],
      }),
    );
    expect(r.kind).toBe("candidate");
    if (r.kind === "candidate") {
      expect(r.spec.distro.family).toBe("ubuntu");
      expect(r.inferredDefaults).toEqual([]);
    }
  });

  it("applies documented defaults and records them", () => {
    const r = evaluateAiOutput(ok({ name: "Tiny", packages: ["htop"] }));
    expect(r.kind).toBe("candidate");
    if (r.kind !== "candidate") return;
    expect(r.spec.distro).toEqual({ family: "debian", release: "13" });
    expect(r.spec.profile).toBe("minimal");
    expect(r.spec.outputs).toEqual(["iso", "container"]);
    expect(r.inferredDefaults.map((d) => d.field).sort()).toEqual(["architecture", "distro", "outputs", "profile"]);
  });

  it("uses user advanced defaults over documented defaults", () => {
    const r = evaluateAiOutput(ok({ name: "Tiny" }), { distro: { family: "ubuntu", release: "24.04" }, outputs: ["container"] });
    expect(r.kind).toBe("candidate");
    if (r.kind !== "candidate") return;
    expect(r.spec.distro.family).toBe("ubuntu");
    expect(r.spec.outputs).toEqual(["container"]);
  });

  it("normalizes package case and duplicates", () => {
    const r = evaluateAiOutput(ok({ name: "X", packages: ["Git", "git", " curl "] }));
    expect(r.kind === "candidate" && r.spec.packages).toEqual(["git", "curl"]);
  });

  it("reports model-flagged unsupported requirements", () => {
    const r = evaluateAiOutput(ok({ name: "X" }, { unsupported: [{ requirement: "ARM64", reason: "Only x86_64" }] }));
    expect(r).toEqual({ kind: "unsupported", reasons: [{ requirement: "ARM64", reason: "Only x86_64" }] });
  });

  it.each([
    [{ distro: { family: "arch", release: "rolling" } }, "Distribution"],
    [{ architecture: "aarch64" }, "Architecture"],
    [{ profile: "kde" }, "Profile"],
    [{ outputs: ["qcow2"] }, "Output type"],
    [{ packages: ["task-kde-desktop"] }, "Package task-kde-desktop"],
    [{ packages: ["linux-image-amd64"] }, "Package linux-image-amd64"],
  ])("treats %j as unsupported instead of substituting", (patch, requirement) => {
    const r = evaluateAiOutput(ok({ name: "X", ...patch }));
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") expect(r.reasons[0]?.requirement).toContain(requirement);
  });

  it.each([
    ["not json", "Sure! Here's a config"],
    ["wrong shape", JSON.stringify({ name: "x" })],
    ["extra spec keys", ok({ name: "X", commands: ["rm -rf /"] })],
    ["bad package names", ok({ name: "X", packages: ["git && curl"] })],
    ["bad schema version", ok({ name: "X", schemaVersion: 7 })],
    ["bad timezone", ok({ name: "X", timezone: "Mars/Olympus Mons" })],
  ])("flags %s as malformed", (_label, text) => {
    expect(evaluateAiOutput(text).kind).toBe("malformed");
  });

  it("ignores null optional fields", () => {
    expect(evaluateAiOutput(ok({ name: "X", hostname: null, packages: null })).kind).toBe("candidate");
  });
});

describe("prompt and schema", () => {
  it("mentions defaults and capabilities", () => {
    const p = buildSystemPrompt();
    expect(p).toContain('"family":"debian","release":"13"');
    expect(p).toContain("Secure Boot");
  });
  it("produces a JSON schema object", () => {
    const s = aiResponseJsonSchema();
    expect(s.type).toBe("object");
    expect(Object.keys(s.properties as object)).toContain("spec");
  });
});

describe("hostile AI output", () => {
  it("reports deeply nested JSON as malformed instead of overflowing the stack", () => {
    // Stays under MAX_AI_OUTPUT_CHARS while nesting far deeper than the default call stack allows.
    const depth = (MAX_AI_OUTPUT_CHARS - 100) / 2;
    const text = `{"spec":{"name":"X","packages":${"[".repeat(depth)}${"]".repeat(depth)}}}`;
    const r = evaluateAiOutput(text);
    expect(r.kind).toBe("malformed");
    if (r.kind === "malformed") expect(r.issues.join(" ")).toContain(String(MAX_AI_JSON_DEPTH));
  });

  it("still accepts ordinary nesting", () => {
    const r = evaluateAiOutput(JSON.stringify({ spec: { name: "X", distro: { family: "debian", release: "13" } } }));
    expect(r.kind).toBe("candidate");
  });
});

describe("withResolvedDefaults", () => {
  const spec: BuildSpec = {
    schemaVersion: 1,
    name: "Dev Box",
    distro: { family: "debian", release: "13" },
    architecture: "x86_64",
    profile: "minimal",
    packages: [],
    outputs: ["iso"],
  };

  it("records hostname, timezone and locale filled during final resolution", () => {
    const resolved = resolveSpecDefaults(spec);
    const out = withResolvedDefaults([{ field: "profile", value: "minimal", reason: "default" }], spec, resolved);
    expect(out.map((d) => d.field)).toEqual(["profile", "hostname", "timezone", "locale"]);
    expect(out.find((d) => d.field === "hostname")?.value).toBe(resolved.hostname);
    expect(out.find((d) => d.field === "timezone")?.value).toBe(resolved.timezone);
  });

  it("does not duplicate recorded defaults or list fields the request set", () => {
    const withTz = { ...spec, timezone: "Europe/Berlin" };
    const out = withResolvedDefaults([{ field: "locale", value: "en_US.UTF-8", reason: "model" }], withTz, resolveSpecDefaults(withTz));
    expect(out.map((d) => d.field)).toEqual(["locale", "hostname"]);
  });
});
