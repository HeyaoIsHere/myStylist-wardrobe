import {
  AIProviderError,
  type AIErrorCategory,
  type AICallMeta,
  type AIProvider,
  type StructuredRequest,
} from "../ai/provider";
import { getAIProvider } from "../ai/providers/index";
import { logMetadataExtraction } from "../telemetry";
import type { Category } from "../types";
import { buildMetadataSystemPrompt, buildMetadataUserText } from "./prompt";
import {
  METADATA_SCHEMA_VERSION,
  canonicalizeAttributes,
  clothingAttributesRawSchema,
  computeConfidence,
  hasUsableAttributes,
  type ClothingAttributes,
  type ClothingAttributesRaw,
  type ClothingMetadataRecord,
  type MetadataSystemInfo,
  type MetadataValidationResult,
} from "./schema";
import { saveMetadataRecord } from "./store";

/**
 * Provider-agnostic AI metadata extraction (ADR D-14/D-15).
 *
 * Orchestrates: prompt → provider (transport only) → retry → structural zod
 * validation → canonicalization → fail-safe persist → telemetry.
 *
 * FAIL-SAFE CONTRACT: this service NEVER mutates wardrobe data and NEVER
 * throws to a caller on model trouble. On any failure it persists a DEGRADED
 * record (aiGenerated = null) with provenance, and returns it. The wardrobe
 * item itself is untouched either way.
 */

export const MAX_ATTEMPTS = 2;

export interface MetadataExtractionInput {
  itemId: string;
  name: string;
  category: Category;
  /** Minimal representation to send when the capability needs image input. */
  imageDataUrl?: string | null;
}

export interface MetadataExtractionResult {
  requestId: string;
  itemId: string;
  degraded: boolean;
  attrs: ClothingAttributes | null;
  system: MetadataSystemInfo;
}

/** Strip code fences / leading prose and extract the first JSON object.
 *  Shared with the recommendation query-understanding step (same discipline). */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text
    .replace(/```(?:json)?/gi, "")
    .trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    // Cope with providers that wrap the object in brackets/commas defensively.
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface ParsedAttributes {
  attrs: ClothingAttributes | null;
  validationResult: MetadataValidationResult;
}

function parseAttributes(text: string): ParsedAttributes {
  const json = extractJsonObject(text);
  if (!json) return { attrs: null, validationResult: "invalid" };

  // Layer 1 — structural validation (zod).
  const parsed = clothingAttributesRawSchema.safeParse(json);
  if (!parsed.success) return { attrs: null, validationResult: "invalid" };

  // Layer 2 — policy pass (enum membership, synonyms, bounds, dedupe).
  const { attrs, coerced } = canonicalizeAttributes(parsed.data as ClothingAttributesRaw);
  if (!hasUsableAttributes(attrs)) return { attrs: null, validationResult: "threshold" };

  return { attrs, validationResult: coerced ? "coerced" : "ok" };
}

/**
 * Extract + validate + persist metadata for one wardrobe item.
 * `provider` is injectable so tests can force failures; defaults to env-selected.
 */
export async function extractClothingMetadata(
  input: MetadataExtractionInput,
  provider?: AIProvider,
): Promise<MetadataExtractionResult> {
  const active = provider ?? getAIProvider();
  const requestId = crypto.randomUUID();
  const startTime = Date.now();
  const startTimeIso = new Date(startTime).toISOString();

  const request: StructuredRequest = {
    system: buildMetadataSystemPrompt(),
    user: buildMetadataUserText({ name: input.name, category: input.category }),
    ...(input.imageDataUrl ? { imageDataUrl: input.imageDataUrl } : {}),
  };

  let retryCount = 0;
  let errorCategory: AIErrorCategory | null = null;
  let lastMeta: AICallMeta | null = null;
  let text: string | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) retryCount += 1;
    try {
      const result = await active.complete(request);
      text = result.text;
      lastMeta = result.meta;
      break;
    } catch (err) {
      errorCategory = err instanceof AIProviderError ? err.category : "unknown";
      // Retry only transient categories; a validation/config failure won't fix itself.
      if (errorCategory === "validation" || errorCategory === "config") break;
    }
  }

  let attrs: ClothingAttributes | null = null;
  let validationResult: MetadataValidationResult = "ok";

  if (text !== null) {
    const parsed = parseAttributes(text);
    attrs = parsed.attrs;
    validationResult = parsed.validationResult;
  } else {
    validationResult = "none";
  }

  const degraded = attrs === null;
  const system: MetadataSystemInfo = {
    provider: active.name,
    model: lastMeta?.model ?? "n/a",
    version: METADATA_SCHEMA_VERSION,
    confidence: computeConfidence(attrs),
    extractedAt: new Date().toISOString(),
    requestId,
    degraded,
    attempts: retryCount + 1,
    validationResult,
    errorCategory: degraded ? errorCategory : null,
  };

  const record: ClothingMetadataRecord = {
    itemId: input.itemId,
    userProvided: { name: input.name, category: input.category },
    aiGenerated: attrs,
    system,
  };

  // Persist ALWAYS (even degraded — provenance). Only ever from a
  // by-construction-valid record; wardrobe data is never touched here.
  saveMetadataRecord(record);

  logMetadataExtraction({
    kind: "metadata_extraction",
    requestId,
    clothingId: input.itemId,
    provider: system.provider,
    model: system.model,
    version: system.version,
    startTime: startTimeIso,
    durationMs: Date.now() - startTime,
    success: !degraded,
    validationResult,
    retryCount,
    errorCategory,
  });

  return { requestId, itemId: input.itemId, degraded, attrs, system };
}