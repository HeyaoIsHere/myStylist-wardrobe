/**
 * Provider-neutral AI seam.
 *
 * All application/business logic must depend on this interface (and on zod for
 * runtime schema validation) — never on a specific provider. Provider-specific
 * code lives in ./providers/ and is selected at runtime from environment
 * config, so swapping the model never touches business logic (ADR D-03/D-14).
 *
 * The provider layer is TRANSPORT ONLY: it returns raw text plus observable
 * metadata. Parsing to JSON, schema validation, canonicalization and the
 * fail-safe fallback are the caller's job (ADR D-15) so that invalid model
 * output can never corrupt wardrobe data.
 */

/** Classifies a provider failure. Never contains content, keys, or images. */
export type AIErrorCategory =
  | "config" // missing / invalid provider configuration
  | "timeout" // request exceeded the deadline
  | "network" // transport failure (DNS, refused, TLS, …)
  | "http" // provider answered non-2xx
  | "provider" // malformed provider response (empty choices, no content)
  | "validation" // model returned unparseable output
  | "unknown"; // any unexpected error not classified above

export class AIProviderError extends Error {
  readonly category: AIErrorCategory;
  readonly status?: number;

  constructor(category: AIErrorCategory, message: string, status?: number) {
    super(message);
    this.name = "AIProviderError";
    this.category = category;
    this.status = status;
  }
}

/** Token/cost accounting for one call, when the provider reports it (ADR D-22). */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Estimated cost in USD — only set when a pricing table is configured. */
  costUsd?: number;
}

/** Observable, non-sensitive metadata describing one AI call. */
export interface AICallMeta {
  provider: string;
  model: string;
  /** Provider contract version this call was made against. */
  version: string;
  latencyMs: number;
  /** Token usage for this call when the provider surfaces it (optional). */
  usage?: TokenUsage;
}

export interface StructuredRequest {
  /** System / instruction context for the model. */
  system?: string;
  /** The user-side content. */
  user: string;
  /**
   * Optional inline image as a data URL — the MINIMAL representation, only for
   * capabilities that genuinely require image input (ADR D-04). Never used for
   * text-only calls and never logged or persisted.
   */
  imageDataUrl?: string;
}

export interface CompleteOptions {
  /** Override the default model (e.g. a vision-capable model). */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export type CompleteResult = { text: string; meta: AICallMeta };

export interface AIProvider {
  readonly name: string;
  readonly contractVersion: string;
  complete(req: StructuredRequest, opts?: CompleteOptions): Promise<CompleteResult>;
}