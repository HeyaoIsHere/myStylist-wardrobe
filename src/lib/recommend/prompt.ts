/**
 * Prompts for the query-understanding step (Phase 3).
 *
 * The system prompt carries a stable signature token (OUTFIT_QUERY_SCHEMA) —
 * the mock provider uses it to answer deterministically offline. Version the
 * schema + prompt together: model output is always judged against the JSON
 * shape it was prompted with.
 */

export const OUTFIT_QUERY_SCHEMA_VERSION = "outfit-query-v1";
export const OUTFIT_QUERY_PROMPT_SIGNATURE = "OUTFIT_QUERY_SCHEMA";

export function buildOutfitSystemPrompt(): string {
  return [
    `You are the myStylist query-understanding step. ${OUTFIT_QUERY_PROMPT_SIGNATURE}`,
    "You translate one free-text wardrobe request into structured JSON. Return ONLY the JSON object — no prose, no code fences, no markdown.",
    "Output shape:",
    '{ "hard": { "categories": [...], "colors": [...], "seasons": [...], "formality": "..." }, "soft": [...], "context": { "occasion": "...", "mood": "...", "note": "..." } }',
    "hard = constraints the user DISALLOWS violating. Empty arrays when unstated. Never guess a constraint the user did not say.",
    "  Allowed categories: tops, bottoms, dresses, outerwear, shoes, bags, accessories, others.",
    "  Allowed seasons: spring, summer, autumn, winter. Allowed formality: casual, smart-casual, business, business-formal, formal.",
    "  colors: short lowercase names (e.g. navy, black, cream).",
    "soft = non-binding style preferences / descriptors the user hinted at (e.g. \"minimalist\", \"relaxed\", \"for a coffee date\").",
    "context = occasion / mood / notes that explain or flavour the request but NEVER restrict it.",
    "CRITICAL RULES:",
    "- NEVER output clothing IDs, names of specific items, or wardrobe entries. You understand intents only.",
    "- Omit unknown fields rather than guessing.",
  ].join("\n");
}

export function buildOutfitUserText(raw: string): string {
  return `User request:\n${raw.trim()}\n\nReturn the query-understanding JSON.`;
}

/**
 * Outfit-validation prompts (Phase 4, ADR D-23).
 *
 * The review is ADVISORY and aesthetic: style coherence, colour harmony,
 * occasion appropriateness, silhouette compatibility. The model receives a
 * TEXTUAL description of the (already grounded) candidate pieces — never an
 * image, and its output schema contains no item fields, so it can flag a look
 * but can never alter what is recommended.
 */

export const OUTFIT_VALIDATION_SCHEMA_VERSION = "outfit-validation-v1";
export const OUTFIT_VALIDATION_PROMPT_SIGNATURE = "OUTFIT_VALIDATION_SCHEMA";

export function buildValidationSystemPrompt(): string {
  return [
    `You are the myStylist outfit-validation step. ${OUTFIT_VALIDATION_PROMPT_SIGNATURE}`,
    "You review ONE candidate outfit (real, grounded wardrobe items) and return a structured verdict. Return ONLY the JSON object — no prose, no code fences.",
    "Output shape:",
    '{ "passed": true, "score": 82, "issues": ["..."], "checks": { "styleCoherence": { "passed": true, "note": "..." }, "colorHarmony": { "passed": true, "note": "..." }, "occasionAppropriateness": { "passed": true, "note": "..." }, "silhouetteCompatibility": { "passed": true, "note": "..." } } }',
    "Rules:",
    "- score is 0-100. Set passed = (score >= 60). 0-59 fail, 60-74 weak pass, 75+ strong.",
    "- issues lists ONLY the aesthetic problems you find; empty when the look is fine.",
    "- Judge ONLY style coherence, colour harmony, occasion appropriateness, and silhouette/proportion compatibility.",
    "- You are advisory. Item existence, duplicates and hard constraints are ALREADY enforced deterministically — never question them.",
  ].join("\n");
}

function describeCandidate(
  item: { id: string; name: string; category: string },
  attrs: import("../metadata/schema").ClothingAttributes | null,
): string {
  if (!attrs) return `- ${item.name} (${item.category}) — [no metadata]`;
  const bits: string[] = [];
  if (attrs.subcategory) bits.push(`subcategory ${attrs.subcategory}`);
  if (attrs.colors.length) bits.push(`colors [${attrs.colors.map((c) => c.name).join(", ")}]`);
  if (attrs.styleTags.length) bits.push(`style [${attrs.styleTags.join(", ")}]`);
  if (attrs.fit) bits.push(`fit ${attrs.fit}`);
  if (attrs.pattern.length) bits.push(`pattern [${attrs.pattern.join(", ")}]`);
  if (attrs.formality) bits.push(`formality ${attrs.formality}`);
  if (attrs.seasons.length) bits.push(`seasons [${attrs.seasons.join(", ")}]`);
  if (attrs.weatherSuitability.length) bits.push(`weather [${attrs.weatherSuitability.join(", ")}]`);
  return `- ${item.name} (${item.category}) — ${bits.join("; ")}`;
}

export interface ValidationUserInput {
  items: { id: string; name: string; category: string }[];
  query: { context: { occasion?: string; mood?: string; note?: string }; hard: import("../retrieval/types").MetadataConstraints };
  getAttrs: (id: string) => import("../metadata/schema").ClothingAttributes | null;
  /** the original server-side request (never logged) so the reviewer knows the ask. */
  raw?: string;
}

export function buildValidationUserText(input: ValidationUserInput): string {
  const ctx = input.query.context;
  const hard = input.query.hard;
  const lines: string[] = [];
  if (input.raw) {
    lines.push("User request:");
    lines.push(`- ${input.raw.slice(0, 400)}`);
    lines.push("");
  }
  lines.push("Request context:");
  if (ctx.occasion) lines.push(`- occasion: ${ctx.occasion}`);
  if (ctx.mood) lines.push(`- mood: ${ctx.mood}`);
  if (ctx.note) lines.push(`- note: ${ctx.note}`);
  const hardBits: string[] = [];
  if (hard.categories?.length) hardBits.push(`categories [${hard.categories.join(", ")}]`);
  if (hard.colors?.length) hardBits.push(`colors [${hard.colors.join(", ")}]`);
  if (hard.seasons?.length) hardBits.push(`seasons [${hard.seasons.join(", ")}]`);
  if (hard.formality) hardBits.push(`formality ${hard.formality}`);
  lines.push(`- hard constraints asked: ${hardBits.length ? hardBits.join("; ") : "none"}`);

  lines.push("");
  lines.push("Candidate outfit (grounded, real wardrobe items):");
  for (const item of input.items) {
    lines.push(describeCandidate(item, input.getAttrs(item.id)));
  }

  lines.push("");
  lines.push("Return the validation JSON.");
  return lines.join("\n");
}