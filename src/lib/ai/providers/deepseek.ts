import {
  AIProvider,
  AICallMeta,
  AIProviderError,
  CompleteOptions,
  CompleteResult,
  StructuredRequest,
} from "../provider";

/**
 * DeepSeek provider — a THIN OpenAI-compatible HTTP client (ADR D-09).
 * Transport only: returns the raw completion text; JSON parsing, zod validation
 * and canonicalization are the caller's responsibility (ADR D-15).
 *
 * No DeepSeek SDK is used, and nothing in this process other than this module
 * knows DeepSeek's wire format. Everything is configured through environment
 * variables so the endpoint/model are swappable per-deployment.
 *
 * Env vars (server-side only, never bundled to the client):
 *   DEEPSEEK_API_KEY  – required
 *   AI_TEXT_MODEL     – default chat model (default `deepseek-chat`)
 *   AI_BASE_URL       – an OpenAI-compatible base URL (default https://api.deepseek.com)
 */

function readConfig() {
  const baseUrl = (process.env.AI_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
  const apiKey = process.env.DEEPSEEK_API_KEY ?? "";
  const defaultModel = process.env.AI_TEXT_MODEL ?? "deepseek-chat";
  return { baseUrl, apiKey, defaultModel };
}

/** Deterministic provider contract version for observability. */
export const DEEPSEEK_CONTRACT_VERSION = "openai-compat-1";

export function createDeepSeekProvider(): AIProvider {
  return {
    name: "deepseek",
    contractVersion: DEEPSEEK_CONTRACT_VERSION,

    async complete(req: StructuredRequest, opts: CompleteOptions = {}): Promise<CompleteResult> {
      const { baseUrl, apiKey, defaultModel } = readConfig();
      if (!apiKey) {
        throw new AIProviderError(
          "config",
          "DEEPSEEK_API_KEY is not set — configure it server-side or use AI_PROVIDER=mock",
        );
      }

      const model = opts.model ?? defaultModel;
      const started = Date.now();
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: opts.temperature ?? 0.2,
            ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
            messages: buildMessages(req),
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        const aborted = (err as Error)?.name === "AbortError";
        throw new AIProviderError(
          aborted ? "timeout" : "network",
          `DeepSeek transport ${aborted ? "timed out" : "failed"}: ${(err as Error)?.message}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AIProviderError(
          "http",
          `DeepSeek answered ${res.status}: ${body.slice(0, 200)}`,
          res.status,
        );
      }

      const json = (await res.json().catch(() => null)) as
        | {
            choices?: Array<{ message?: { content?: string } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }
        | null;
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.trim() === "") {
        throw new AIProviderError("provider", "DeepSeek response contained no message content");
      }

      const meta: AICallMeta = {
        provider: "deepseek",
        model,
        version: DEEPSEEK_CONTRACT_VERSION,
        latencyMs: Date.now() - started,
        // OpenAI-compatible `usage` — surfaced for observability (never logged raw).
        ...(json?.usage
          ? {
              usage: {
                ...(json.usage.prompt_tokens !== undefined ? { promptTokens: json.usage.prompt_tokens } : {}),
                ...(json.usage.completion_tokens !== undefined ? { completionTokens: json.usage.completion_tokens } : {}),
                ...(json.usage.total_tokens !== undefined ? { totalTokens: json.usage.total_tokens } : {}),
              },
            }
          : {}),
      };
      return { text, meta };
    },
  };
}

function buildMessages(req: StructuredRequest) {
  const system = req.system ? [{ role: "system", content: req.system }] : [];
  // OpenAI-compatible multimodal content: image URLs (data URLs) are accepted by
  // vision-capable models. The image payload here is the app-provided minimal
  // representation (a thumbnail cutout) only.
  if (req.imageDataUrl) {
    return [
      ...system,
      {
        role: "user",
        content: [
          { type: "text", text: req.user },
          { type: "image_url", image_url: { url: req.imageDataUrl } },
        ],
      },
    ];
  }
  return [...system, { role: "user", content: req.user }];
}