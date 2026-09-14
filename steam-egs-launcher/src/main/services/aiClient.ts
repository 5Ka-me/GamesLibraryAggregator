import { getChutesApiKey } from './secretStore';
import { addAiUsage, getAiModel, getAiUsage } from '../config';

// Thin client for chutes.ai (OpenAI-compatible chat completions) shared by
// the natural-language search (ai.ts) and the library enrichment
// (enrichment.ts). Owns: the curated model list, JSON-mode calls with
// retry/fallback, usage accounting, and the live price catalog.

export const AI_BASE_URL = 'https://llm.chutes.ai/v1';
/** Cheap, capable, supports JSON mode (see /v1/models: ~$0.12 in / $0.37 out per 1M). */
export const DEFAULT_AI_MODEL = 'google/gemma-4-31B-turbo-TEE';

const TIMEOUT_MS = 90_000;
const CATALOG_TTL_MS = 10 * 60_000;

export interface AiUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AiStatus {
  configured: boolean;
  model: string;
  usage: AiUsage;
}

export type AiModelRole = 'default' | 'alt' | 'smart' | 'best';

export interface AiModelInfo {
  id: string;
  role: AiModelRole;
  /** USD per 1M tokens; null when the catalog doesn't say. */
  promptPrice: number | null;
  completionPrice: number | null;
  context: number | null;
  jsonMode: boolean;
}

/**
 * The short list offered in Settings. All support JSON mode (the planner
 * depends on it); they differ in price and reasoning depth. Anything else in
 * the chutes catalog is deliberately hidden — fewer, well-tested choices.
 */
export const CURATED_MODELS: { id: string; role: AiModelRole }[] = [
  { id: 'google/gemma-4-31B-turbo-TEE', role: 'default' }, // cheap, fast, good at structured output
  { id: 'Qwen/Qwen3-32B-TEE', role: 'alt' }, // similar price, different strengths (RU phrasing)
  { id: 'deepseek-ai/DeepSeek-V4-Flash-0731-TEE', role: 'smart' }, // better judgement on meaning-based picks
  { id: 'zai-org/GLM-5.1-TEE', role: 'best' }, // top quality, ~8x the default's price
];

export function aiStatus(): AiStatus {
  return { configured: !!getChutesApiKey(), model: getAiModel() ?? DEFAULT_AI_MODEL, usage: getAiUsage() };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let catalogCache: { at: number; byId: Map<string, any> } | null = null;

async function catalog(): Promise<Map<string, any>> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.byId;
  let byId = new Map<string, any>();
  try {
    const res = await fetch(`${AI_BASE_URL}/models`, { headers: authHeaders(false), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.ok) {
      const json = (await res.json()) as any;
      const list: any[] = Array.isArray(json?.data) ? json.data : [];
      byId = new Map(list.filter((m) => typeof m?.id === 'string').map((m) => [m.id as string, m]));
    }
  } catch {
    /* offline — the curated ids are still listed without prices */
  }
  if (byId.size) catalogCache = { at: Date.now(), byId };
  return byId;
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The curated models, with live prices from the catalog when it answers. */
export async function aiListModels(): Promise<AiModelInfo[]> {
  const byId = await catalog();
  return CURATED_MODELS.map(({ id, role }) => {
    const m = byId.get(id);
    return {
      id,
      role,
      promptPrice: num(m?.pricing?.prompt),
      completionPrice: num(m?.pricing?.completion),
      context: num(m?.context_length ?? m?.max_model_len),
      jsonMode: m ? Array.isArray(m?.supported_features) && m.supported_features.includes('json_mode') : true,
    };
  });
}

/** USD for a token estimate on the given (or selected) model; null when prices are unknown. */
export async function estimateUsd(promptTokens: number, completionTokens: number, model?: string): Promise<number | null> {
  const id = model ?? getAiModel() ?? DEFAULT_AI_MODEL;
  const m = (await catalog()).get(id);
  const pin = num(m?.pricing?.prompt);
  const pout = num(m?.pricing?.completion);
  if (pin == null || pout == null) return null;
  return (promptTokens * pin + completionTokens * pout) / 1_000_000;
}

// ---------- chat completion ----------

function authHeaders(required: boolean): Record<string, string> {
  const key = getChutesApiKey();
  if (!key) {
    if (required) throw new Error('AI_NO_KEY');
    return { 'Content-Type': 'application/json' };
  }
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

class AiHttpError extends Error {
  constructor(
    public status: number,
    detail: string
  ) {
    super(`${status === 429 ? 'AI_RATE' : `AI_HTTP_${status}`}: ${detail}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ChatOptions {
  /** Long generations (a batch of profiles) need more than the default 90 s. */
  timeoutMs?: number;
  /** Lets the caller abort an in-flight request (cancel button). */
  signal?: AbortSignal;
}

async function chatOnce(model: string, messages: ChatMessage[], maxTokens: number, opts: ChatOptions): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(true),
    signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
    }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('AI_AUTH');
  if (res.status === 402) throw new Error('AI_BALANCE');
  if (!res.ok) {
    // The provider's own words help when it's a limit: "at maximum capacity", "X requests per minute"…
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new AiHttpError(res.status, detail);
  }
  const json = (await res.json()) as any;
  const raw = json?.choices?.[0]?.message?.content;
  const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p: any) => p?.text ?? '').join('') : '';
  const promptTokens = Number(json?.usage?.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(json?.usage?.completion_tokens ?? 0) || 0;
  addAiUsage(promptTokens, completionTokens);
  return { text, model, promptTokens, completionTokens };
}

const isCapacity = (e: unknown): boolean =>
  e instanceof AiHttpError && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504);

/**
 * JSON-mode chat completion with resilience: a short retry on the chosen
 * model, then the other curated models in order. chutes.ai answers 429
 * "Infrastructure is at maximum capacity" per model when it is busy, so
 * switching models is the fix that actually works; the result reports which
 * model answered.
 */
export async function chatJson(messages: ChatMessage[], maxTokens: number, opts: ChatOptions = {}): Promise<ChatResult> {
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const preferred = getAiModel() ?? DEFAULT_AI_MODEL;
  const order = [preferred, ...CURATED_MODELS.map((m) => m.id).filter((id) => id !== preferred)];
  let lastErr: unknown = null;
  for (const [i, model] of order.entries()) {
    const attempts = i === 0 ? 2 : 1;
    for (let a = 0; a < attempts; a++) {
      try {
        return await chatOnce(model, messages, maxTokens, opts);
      } catch (e) {
        lastErr = e;
        if (opts.signal?.aborted) throw new Error('AI_CANCELLED');
        if (!isCapacity(e)) throw e; // auth, balance, bad request: no point retrying
        await sleep(a === 0 ? 1500 : 4000);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('AI_RATE');
}

/** Tolerant JSON extraction: strips code fences and anything around the outermost object. */
export function parseJson(text: string): any | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
