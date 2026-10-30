import { describe, expect, it, vi } from "vitest";
import { runGenerationLoop } from "../convex/lib/generationLoop";
import { ProviderError } from "../convex/lib/providers";
import { ResolverUnavailableError } from "../convex/lib/packages";

const good = JSON.stringify({ spec: { name: "Dev box", packages: ["git", "neovim"] } });
const resolveAll = async () => ({ found: [], missing: [] });

describe("runGenerationLoop", () => {
  it("accepts valid output on the first attempt", async () => {
    const r = await runGenerationLoop({ prompt: "dev box", maxAttempts: 3, callModel: async () => ({ text: good }), resolvePackages: resolveAll });
    expect(r.kind).toBe("accepted");
    expect(r.attempts).toHaveLength(1);
  });

  it("retries malformed output with feedback, without asking the user", async () => {
    const callModel = vi.fn().mockResolvedValueOnce({ text: "Sure! Here is your config." }).mockResolvedValueOnce({ text: good });
    const r = await runGenerationLoop({ prompt: "x", maxAttempts: 3, callModel, resolvePackages: resolveAll });
    expect(r.kind).toBe("accepted");
    const secondMessages = callModel.mock.calls[1]![0];
    expect(secondMessages.at(-1).content).toContain("could not be accepted");
  });

  it("gives up after the bounded number of attempts", async () => {
    const callModel = vi.fn().mockResolvedValue({ text: "not json" });
    const r = await runGenerationLoop({ prompt: "x", maxAttempts: 3, callModel, resolvePackages: resolveAll });
    expect(r).toMatchObject({ kind: "failed", code: "generation_failed" });
    expect(callModel).toHaveBeenCalledTimes(3);
  });

  it("ends immediately on unsupported requirements", async () => {
    const callModel = vi.fn().mockResolvedValue({ text: JSON.stringify({ spec: { distro: { family: "fedora", release: "41" } } }) });
    const r = await runGenerationLoop({ prompt: "fedora", maxAttempts: 3, callModel, resolvePackages: resolveAll });
    expect(r.kind).toBe("unsupported");
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("asks the model to fix unknown packages, then reports them as unsupported", async () => {
    const callModel = vi.fn().mockResolvedValue({ text: JSON.stringify({ spec: { name: "x", packages: ["nodejs-lts"] } }) });
    const resolvePackages = vi.fn().mockResolvedValue({ found: [], missing: ["nodejs-lts"] });
    const r = await runGenerationLoop({ prompt: "x", maxAttempts: 2, callModel, resolvePackages });
    expect(r.kind).toBe("unsupported");
    if (r.kind === "unsupported") expect(r.reasons[0]!.requirement).toBe("Package nodejs-lts");
    expect(callModel.mock.calls[1]![0].at(-1).content).toContain("nodejs-lts");
  });

  it("does not fall back after a non-retryable provider error", async () => {
    const callModel = vi.fn().mockRejectedValue(new ProviderError("The AI provider rejected the API key.", 401, false));
    const r = await runGenerationLoop({ prompt: "x", maxAttempts: 3, callModel, resolvePackages: resolveAll });
    expect(r).toMatchObject({ kind: "failed", code: "provider_error" });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("retries transient provider errors within the same budget", async () => {
    const callModel = vi.fn().mockRejectedValueOnce(new ProviderError("down", 503, true)).mockResolvedValueOnce({ text: good });
    const r = await runGenerationLoop({ prompt: "x", maxAttempts: 3, callModel, resolvePackages: resolveAll });
    expect(r.kind).toBe("accepted");
  });

  it("reports archive outages instead of guessing", async () => {
    const r = await runGenerationLoop({
      prompt: "x",
      maxAttempts: 3,
      callModel: async () => ({ text: good }),
      resolvePackages: async () => {
        throw new ResolverUnavailableError("down");
      },
    });
    expect(r).toMatchObject({ kind: "failed", code: "generation_failed" });
  });

  it("stops when the build is cancelled", async () => {
    const callModel = vi.fn();
    const r = await runGenerationLoop({ prompt: "x", maxAttempts: 3, callModel, resolvePackages: resolveAll, shouldContinue: async () => false });
    expect(r.kind).toBe("cancelled");
    expect(callModel).not.toHaveBeenCalled();
  });
});
