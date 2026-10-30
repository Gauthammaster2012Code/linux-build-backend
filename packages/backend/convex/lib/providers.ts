import type { ProviderKind } from "@linxgen/spec";

export type { ProviderKind };

/** Fixed chat endpoints; names, default models and key pages are in the shared PROVIDER_CATALOG. */
const CHAT_URLS: Record<ProviderKind, string> = {
  ollama: "https://ollama.com/api/chat",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
export const API_KEY_PATTERN = /^[\x21-\x7e]{8,512}$/;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

/** Maps provider failures to fixed messages. Provider error bodies are not echoed because some include fragments of the key. */
function errorForStatus(status: number): ProviderError {
  if (status === 401 || status === 403) return new ProviderError("The AI provider rejected the API key.", status, false);
  if (status === 404) return new ProviderError("The selected model was not found at the AI provider.", status, false);
  if (status === 402) return new ProviderError("The AI provider account has insufficient credits.", status, false);
  if (status === 429) return new ProviderError("The AI provider rate limit or quota was reached.", status, true);
  if (status >= 500) return new ProviderError("The AI provider is temporarily unavailable.", status, true);
  return new ProviderError(`The AI provider rejected the request (HTTP ${status}).`, status, false);
}

async function post(fetchImpl: FetchLike, url: string, apiKey: string, body: unknown, timeoutMs: number, extraHeaders: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError" || (e as Error).name === "AbortError";
    throw new ProviderError(timeout ? "The AI provider timed out." : "Could not reach the AI provider.", null, true);
  }
  if (!res.ok) throw errorForStatus(res.status);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ProviderError("The AI provider returned an unreadable response.", res.status, true);
  }
}

const OPENROUTER_HEADERS = { "HTTP-Referer": "https://linxgen.app", "X-Title": "LinxGen" };

export async function chatJson(opts: {
  provider: ProviderKind;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  jsonSchema: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<ChatResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const chatUrl = CHAT_URLS[opts.provider];

  if (opts.provider === "ollama") {
    const body = await post(fetchImpl, chatUrl, opts.apiKey, {
      model: opts.model,
      messages: opts.messages,
      stream: false,
      format: opts.jsonSchema,
      options: { temperature: 0 },
    }, timeoutMs);
    const message = body.message as { content?: unknown } | undefined;
    if (typeof message?.content !== "string") throw new ProviderError("The AI provider returned no content.", 200, true);
    return {
      text: message.content,
      inputTokens: numberOrUndefined(body.prompt_eval_count),
      outputTokens: numberOrUndefined(body.eval_count),
    };
  }

  const body = await post(
    fetchImpl,
    chatUrl,
    opts.apiKey,
    {
      model: opts.model,
      messages: opts.messages,
      response_format: {
        type: "json_schema",
        json_schema: { name: "linxgen_build_spec", schema: opts.jsonSchema, strict: false },
      },
    },
    timeoutMs,
    opts.provider === "openrouter" ? OPENROUTER_HEADERS : {},
  );
  const choices = body.choices as { message?: { content?: unknown; refusal?: unknown } }[] | undefined;
  const msg = choices?.[0]?.message;
  if (typeof msg?.refusal === "string" && msg.refusal) {
    throw new ProviderError("The AI model refused the request.", 200, false);
  }
  if (typeof msg?.content !== "string") throw new ProviderError("The AI provider returned no content.", 200, true);
  const usage = body.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  return {
    text: msg.content,
    inputTokens: numberOrUndefined(usage?.prompt_tokens),
    outputTokens: numberOrUndefined(usage?.completion_tokens),
  };
}

/** Validates a key and model without generating a build. */
export async function testProviderConnection(opts: {
  provider: ProviderKind;
  apiKey: string;
  model: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const get = async (url: string, auth: boolean) => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: auth ? { Authorization: `Bearer ${opts.apiKey}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ProviderError("Could not reach the AI provider.", null, true);
    }
    if (!res.ok) throw errorForStatus(res.status);
    return res;
  };
  if (opts.provider === "openai") {
    await get(`https://api.openai.com/v1/models/${encodeURIComponent(opts.model)}`, true);
    return;
  }
  if (opts.provider === "openrouter") {
    await get("https://openrouter.ai/api/v1/key", true);
    const models = (await (await get("https://openrouter.ai/api/v1/models", false)).json()) as { data?: { id: string }[] };
    if (!models.data?.some((m) => m.id === opts.model)) {
      throw new ProviderError("The selected model was not found at the AI provider.", 404, false);
    }
    return;
  }
  await post(
    fetchImpl,
    CHAT_URLS.ollama,
    opts.apiKey,
    { model: opts.model, messages: [{ role: "user", content: "Reply with {}" }], stream: false, format: "json", options: { num_predict: 4 } },
    30_000,
  );
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function keyHint(apiKey: string): string {
  return apiKey.length >= 8 ? `…${apiKey.slice(-4)}` : "…";
}
