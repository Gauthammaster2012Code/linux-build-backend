import { spawn } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine: (line: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
  /** Grace period between SIGTERM and SIGKILL when the signal aborts. */
  killGraceMs?: number;
}

export interface ExecResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
}

export type Exec = (command: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;

function lineSplitter(emit: (line: string) => void) {
  let rest = "";
  return {
    push(chunk: Buffer) {
      rest += chunk.toString("utf8");
      let i: number;
      while ((i = rest.indexOf("\n")) >= 0) {
        emit(rest.slice(0, i).replace(/\r$/, ""));
        rest = rest.slice(i + 1);
      }
      // Very long lines without a newline are flushed in pieces to bound memory.
      while (rest.length > 16_384) {
        emit(rest.slice(0, 16_384));
        rest = rest.slice(16_384);
      }
    },
    end() {
      if (rest) emit(rest);
      rest = "";
    },
  };
}

/** Runs a program with an argument vector. No shell is involved, so arguments are never interpreted. */
export const execCommand: Exec = (command, args, opts) =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, signal: null, aborted: true });
      return;
    }
    const child = spawn(command, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = lineSplitter((l) => opts.onLine(l, "stdout"));
    const err = lineSplitter((l) => opts.onLine(l, "stderr"));
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // the process group already exited
      }
    };
    const onAbort = () => {
      aborted = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), opts.killGraceMs ?? 20_000);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (exitCode, signal) => {
      out.end();
      err.end();
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, signal, aborted });
    });
  });
