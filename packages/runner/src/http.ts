import type { z } from "zod";

export type FetchLike = typeof fetch;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(`request failed (${status} ${code})`);
  }
}

export interface RequestOptions<T extends z.ZodType> {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
  schema: T;
  retries?: number;
  timeoutMs?: number;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function backoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  return Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + Math.random() / 2);
}

/** JSON request with bounded retries for network failures, 429 and 5xx. Other 4xx responses fail immediately. */
export async function requestJson<T extends z.ZodType>(
  fetchImpl: FetchLike,
  url: string,
  opts: RequestOptions<T>,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<z.infer<T>> {
  const retries = opts.retries ?? 4;
  let lastError: ApiError = new ApiError(0, "not_attempted", true);
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await wait(backoffMs(attempt - 1));
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: opts.method ?? "POST",
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      lastError = new ApiError(0, `network_${(e as Error).name}`, true);
      continue;
    }
    if (res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch (e) {
        // The connection dropped after the headers arrived; the request may be retried like any transport failure.
        lastError = new ApiError(res.status, `network_${(e as Error).name}`, true);
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, "invalid_response", false);
      }
      const parsed = opts.schema.safeParse(raw);
      if (!parsed.success) throw new ApiError(res.status, "invalid_response", false);
      return parsed.data;
    }
    let code = "http_error";
    try {
      code = String(((await res.json()) as { error?: unknown }).error ?? code).slice(0, 64);
    } catch {
      // non-JSON error bodies keep the generic code
    }
    const retryable = res.status === 429 || res.status >= 500;
    lastError = new ApiError(res.status, code, retryable);
    if (!retryable) throw lastError;
  }
  throw lastError;
}
