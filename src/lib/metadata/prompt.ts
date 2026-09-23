import type { Category } from "../types";

/**
 * Prompts for the metadata extraction task. Versioned by METADATA_SCHEMA_VERSION
 * (see service.ts / schema.ts) so model output is always judged against the
 * schema it was prompted with.
 */

export interface DescriptorInput {
  name: string;
  category: Category;
}

export function buildMetadataSystemPrompt(): string {
  return [
    "You extract structured metadata for a single item of clothing shown in the image.",
    "Use the image for VISUAL attributes only (subcategory, colors, pattern, material cues, fit).",
    "Return ONLY a JSON object — no prose, no code fences, no markdown.",
    "Allowed season values: spring, summer, autumn, winter. At least one; up to four.",
    "Allowed formality values: casual, smart-casual, business, business-formal, formal.",
    "Allowed weather values: cold, cool, mild, warm, hot.",
    "colors must be an array of { name, hex? }. Use common color names (e.g. navy, black, cream).",
    "If a field is unknown, omit it — do not guess wildly. subcategory may be null.",
    "Occasions and styleTags are short lowercase tags, at most six and eight respectively.",
  ].join("\n");
}

export function buildMetadataUserText(input: DescriptorInput): string {
  return `Item name: ${input.name}\nCategory: ${input.category}\nExtract the structured clothing metadata as JSON.`;
}