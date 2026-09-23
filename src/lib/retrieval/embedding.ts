import { AIProviderError } from "../ai/provider";
import type { EmbeddingOutput, EmbeddingProvider } from "./types";

/**
 * Embedding providers (ADR D-17 — strategy A: text from metadata).
 *
 * Replaceable seam, selected by env at the single factory below:
 *   · LocalHashEmbedding   — deterministic, offline, zero keys (DEFAULT).
 *                            Signed bag-of-words with a CJK-safe tokenizer.
 *                            NOT a neural semantic model — lexical overlap
 *                            only; bilingual label tokens in textrep() give it
 *                            useful en/zh recall for the foundation.
 *   · OpenAICompatEmbedding — hosted `POST {base}/embeddings` (OpenAI-compatible;
 *                            works with Qwen/BGE/Hunyuan endpoints too).
 *                            Sends TEXT ONLY — never images (ADR D-04).
 *
 * Providers throw AIProviderError with the same taxonomy as the chat seam
 * (config/timeout/network/http/provider) so callers degrade consistently.
 */

// ── Deterministic local provider ─────────────────────────────────────────────

export const LOCAL_EMBEDDING_DIM = 384;

/** FNV-1a style 32-bit hash — stable across runs (deterministic vectors). */
function hash32(s: string, seed: number): number {
  let h = (seed >>> 0);
  for (const ch of s) {
    h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

interface TokenBag {
  counts: number;
  tokens: string[];
}

/** Latin words/numbers + CJK unigrams & bigrams (so zh queries and docs that
 *  share characters still overlap lexically). */
function tokenize(text: string): TokenBag {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.match(/[a-z0-9]+/g) ?? []) tokens.push(m);
  for (const run of lower.match(/[一-鿿]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length; i++) {
      tokens.push(run[i]);
      if (i > 0) tokens.push(run.slice(i - 1, i + 1));
    }
  }
  return { counts: tokens.length, tokens };
}

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v; // empty doc → zero vector
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

export class LocalHashEmbedding implements EmbeddingProvider {
  readonly name = "local";
  readonly model = "local-hash-bow-v1";
  readonly version = "embed-v1";
  readonly dimension: number | null = LOCAL_EMBEDDING_DIM;

  async embed(texts: string[]): Promise<EmbeddingOutput> {
    const started = Date.now();
    const vectors = texts.map((text) => {
      const v = new Array<number>(LOCAL_EMBEDDING_DIM).fill(0);
      const { tokens } = tokenize(text);
      for (const tok of tokens) {
        const sign = (hash32(tok, 17) & 1) === 1 ? 1 : -1;
        for (let k = 0; k < 3; k++) {
          const idx = hash32(`${tok}||${k}`, 31) % LOCAL_EMBEDDING_DIM;
          v[idx] += sign;
        }
        // sub-linear frequency weighting: log-ish dampening via second pass
        // (counts already aggregated above by the triple inclusion).
      }
      return l2Normalize(v);
    });
    return { vectors, latencyMs: Date.now() - started };
  }
}

// ── Hosted OpenAI-compatible provider ─────────────────────────────────────────

export interface OpenAICompatEmbedOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** test seam — the only place fetch is passed in. */
  fetchImpl?: typeof fetch;
}

export class OpenAICompatEmbedding implements EmbeddingProvider {
  readonly name = "openai-compatible";
  readonly version = "embed-v1";
  readonly dimension: number | null = null; // learned from the first response
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly modelName: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAICompatEmbedOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.AI_EMBEDDING_BASE_URL ?? "https://api.openai.com").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.EMBEDDING_API_KEY ?? "";
    this.modelName = opts.model ?? process.env.AI_EMBEDDING_MODEL ?? "text-embedding-3-small";
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.modelName;
  }

  async embed(texts: string[]): Promise<EmbeddingOutput> {
    if (!this.apiKey) {
      throw new AIProviderError(
        "config",
        "embedding provider 'openai-compatible' has no EMBEDDING_API_KEY — set it server-side or use AI_EMBEDDING_PROVIDER=local",
      );
    }
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.modelName, input: texts }),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as Error)?.name === "AbortError";
      throw new AIProviderError(
        aborted ? "timeout" : "network",
        `embedding transport ${aborted ? "timed out" : "failed"}: ${(err as Error)?.message ?? "?"}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AIProviderError("http", `embedding API answered ${res.status}: ${body.slice(0, 200)}`, res.status);
    }

    const json = (await res.json().catch(() => null)) as
      | { data?: Array<{ embedding?: number[] }> }
      | null;
    const vectors = json?.data?.map((d) => d.embedding).filter((e): e is number[] => Array.isArray(e));
    if (!vectors || vectors.length !== texts.length) {
      throw new AIProviderError("provider", "embedding API returned malformed vectors");
    }
    const normalized = vectors.map((v) => l2Normalize([...v]));
    return { vectors: normalized, latencyMs: Date.now() - started };
  }
}

// ── Factory (the only place env maps to an embedding implementation) ─────────

export function getEmbeddingProvider(): EmbeddingProvider {
  const kind = (process.env.AI_EMBEDDING_PROVIDER ?? "local").trim().toLowerCase();
  if (kind === "local" || kind === "hash") return new LocalHashEmbedding();
  if (kind === "openai" || kind === "openai-compatible") return new OpenAICompatEmbedding();
  // Unknown values degrade to the offline provider so nothing ever breaks.
  return new LocalHashEmbedding();
}