/** Provider catalog shared by the backend adapters and the Settings UI. Endpoints stay in the backend. */
export const PROVIDER_KINDS = ["ollama", "openai", "openrouter"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderCatalogEntry {
  label: string;
  defaultModel: string;
  keyUrl: string;
}

export const PROVIDER_CATALOG: Record<ProviderKind, ProviderCatalogEntry> = {
  ollama: { label: "Ollama Cloud", defaultModel: "gpt-oss:120b", keyUrl: "https://ollama.com/settings/keys" },
  openai: { label: "OpenAI", defaultModel: "gpt-5-mini", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { label: "OpenRouter", defaultModel: "openai/gpt-5-mini", keyUrl: "https://openrouter.ai/settings/keys" },
};
