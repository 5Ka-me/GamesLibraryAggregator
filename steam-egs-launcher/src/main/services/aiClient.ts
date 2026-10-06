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
/** Streaming: how long the first token may take, how long a silence mid-stream may last, and the hard cap. */
const FIRST_TOKEN_TIMEOUT_MS = 60_000;
const IDLE_TIMEOUT_MS = 30_000;
const STREAM_MAX_MS = 240_000;
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

/** Curated model id for a role ("smart" = the escalation target for advice), or null when the list has none. */
export const modelForRole = (role: AiModelRole): string | null => CURATED_MODELS.find((m) => m.role === role)?.id ?? null;
/** Position in the curated list — a rough capability/price rank (0 = cheapest). Unknown ids rank last. */
export const modelRank = (id: string): number => {
  const i = CURATED_MODELS.findIndex((m) => m.id === id);
  return i < 0 ? CURATED_MODELS.length : i;
};

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

/**
 * JSON + bearer headers for the other chutes.ai endpoints (the embedding chute uses the same key), so
 * callers never touch the key itself. Throws Error('AI_NO_KEY') when `required` and no key is stored.
 */
export function chutesHeaders(required = true): Record<string, string> {
  return authHeaders(required);
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
  /** Start with this model instead of the user's setting (the others stay as fallbacks). */
  model?: string;
  /** Stream the completion and report the text accumulated so far after every chunk. */
  onDelta?: (textSoFar: string) => void;
  /** Called before each attempt; `attempt` > 0 means the previous model was busy or silent and this one is next. */
  onAttempt?: (model: string, attempt: number) => void;
}

/** Reads an OpenAI-style SSE body: `data: {…}` lines with choices[0].delta.content, usage in the last chunk when requested. */
async function readSse(res: Response, onText: (full: string) => void, onChunk?: () => void): Promise<{ text: string; usage: any | null }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', usage: null };
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let usage: any | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onChunk?.();
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const d = j?.choices?.[0]?.delta?.content;
        if (typeof d === 'string' && d) {
          text += d;
          onText(text);
        }
        if (j?.usage) usage = j.usage;
      } catch {
        /* a partial or keep-alive line */
      }
    }
  }
  return { text, usage };
}

async function chatOnce(model: string, messages: ChatMessage[], maxTokens: number, opts: ChatOptions): Promise<ChatResult> {
  const stream = !!opts.onDelta;
  // Streaming is timed by silence, not by total length: a busy model that never starts
  // is dropped after FIRST_TOKEN_TIMEOUT_MS, a stalled one after IDLE_TIMEOUT_MS, and a
  // long but healthy answer is allowed up to STREAM_MAX_MS.
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdle = (ms: number) => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new DOMException('No data from the model', 'TimeoutError')), ms);
  };
  const total = AbortSignal.timeout(opts.timeoutMs ?? (stream ? STREAM_MAX_MS : TIMEOUT_MS));
  const signals = [total, ...(opts.signal ? [opts.signal] : []), ...(stream ? [idle.signal] : [])];
  if (stream) armIdle(FIRST_TOKEN_TIMEOUT_MS);
  const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(true),
    signal: AbortSignal.any(signals),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      // LAUNCHER_AI_JSON_MODE=off drops the provider's forced JSON mode (an experiment switch for the eval:
      // constrained decoding is suspected of the repeated-key loops some models fall into).
      ...(process.env.LAUNCHER_AI_JSON_MODE === 'off' ? {} : { response_format: { type: 'json_object' } }),
      // Thinking models (Qwen3) otherwise spend the budget on reasoning and return an empty content field.
      chat_template_kwargs: { enable_thinking: false },
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('AI_AUTH');
  if (res.status === 402) throw new Error('AI_BALANCE');
  if (!res.ok) {
    // The provider's own words help when it's a limit: "at maximum capacity", "X requests per minute"…
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new AiHttpError(res.status, detail);
  }
  let text = '';
  let usageDoc: any = null;
  if (stream) {
    try {
      const r = await readSse(res, opts.onDelta!, () => armIdle(IDLE_TIMEOUT_MS));
      text = r.text;
      usageDoc = r.usage;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  } else {
    const json = (await res.json()) as any;
    const raw = json?.choices?.[0]?.message?.content;
    text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p: any) => p?.text ?? '').join('') : '';
    usageDoc = json?.usage ?? null;
  }
  const promptTokens = Number(usageDoc?.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(usageDoc?.completion_tokens ?? 0) || 0;
  addAiUsage(promptTokens, completionTokens);
  if (process.env.LAUNCHER_AI_DEBUG) {
    const defect = jsonDefect(text);
    if (defect) console.log(`[ai] degenerate JSON from ${model}: ${defect}`);
  }
  // An empty content field (reasoning-only reply, truncated output) is treated like a busy model: try the next one.
  if (!text.trim()) throw new AiHttpError(503, `empty reply from ${model}`);
  return { text, model, promptTokens, completionTokens };
}

const isCapacity = (e: unknown): boolean =>
  e instanceof AiHttpError && (e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504);
/** A model that never answered in time — treated like a busy one, but not worth a second try. */
const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || /timeout|aborted due to timeout/i.test(e.message));

/**
 * JSON-mode chat completion with resilience: a short retry on the chosen
 * model, then the other curated models in order. chutes.ai answers 429
 * "Infrastructure is at maximum capacity" per model when it is busy, so
 * switching models is the fix that actually works; the result reports which
 * model answered.
 */
export async function chatJson(messages: ChatMessage[], maxTokens: number, opts: ChatOptions = {}): Promise<ChatResult> {
  if (!getChutesApiKey()) throw new Error('AI_NO_KEY');
  const preferred = opts.model ?? getAiModel() ?? DEFAULT_AI_MODEL;
  const order = [preferred, ...CURATED_MODELS.map((m) => m.id).filter((id) => id !== preferred)];
  let lastErr: unknown = null;
  let attempt = 0;
  for (const [i, model] of order.entries()) {
    const attempts = i === 0 ? 2 : 1;
    for (let a = 0; a < attempts; a++) {
      try {
        opts.onAttempt?.(model, attempt++);
        return await chatOnce(model, messages, maxTokens, opts);
      } catch (e) {
        lastErr = e;
        if (opts.signal?.aborted) throw new Error('AI_CANCELLED');
        if (isTimeout(e)) break; // silent model: straight to the next one, no second wait
        if (!isCapacity(e)) throw e; // auth, balance, bad request: no point retrying
        await sleep(a === 0 ? 1500 : 4000);
      }
    }
  }
  if (lastErr instanceof Error && isTimeout(lastErr)) throw new Error('AI_TIMEOUT: no model answered in time');
  throw lastErr instanceof Error ? lastErr : new Error('AI_RATE');
}

/**
 * A sign that a reply degenerated even if it still parses: a key repeated inside one object, or an empty key.
 * JSON.parse accepts both (the last duplicate wins), so a looping model ("title":"D","note":"","title":"Dungeons
 * 3",…) would otherwise pass as a short, odd answer. Returns a short description, or null for a clean reply.
 */
export function jsonDefect(text: string): string | null {
  const objects: (Set<string> | null)[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') objects.push(new Set());
    else if (ch === '[') objects.push(null);
    else if (ch === '}' || ch === ']') objects.pop();
    else if (ch === '"') {
      let j = i + 1;
      let str = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') {
          str += text[j + 1] ?? '';
          j += 2;
        } else str += text[j++];
      }
      i = j;
      let k = j + 1;
      while (k < text.length && /\s/.test(text[k])) k++;
      const keys = objects[objects.length - 1];
      // A value that swallowed the rest of the object list ("…30 min.'}, {'title':'Void Bastards',…"): the model
      // switched to single-quoted pseudo-JSON inside a string, which parses as one long note.
      if (text[k] !== ':' && /['"]\s*[,}\]]\s*,?\s*\{?\s*['"](title|note|answer|games|fit)['"]\s*:/.test(str)) return 'JSON inside a string';
      if (text[k] !== ':' || !keys) continue;
      if (!str.trim()) return 'empty key';
      if (keys.has(str)) return `repeated key "${str.slice(0, 30)}"`;
      keys.add(str);
    }
  }
  return null;
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
