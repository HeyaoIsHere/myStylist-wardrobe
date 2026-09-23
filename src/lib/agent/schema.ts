import { z } from "zod";
import { FORMALITY, SEASONS } from "../metadata/vocab";
import { CATEGORY_VALUES } from "../recommend/schemas";
import type { MetadataConstraints } from "../retrieval/types";
import type {
  AgentDecision,
  AgentFinishStatus,
  AgentToolName,
  RawAgentDecision,
} from "./types";

/**
 * The tool-call contract (section 6 of the Phase-6 brief): every decision is
 * validated against zod BEFORE it can be executed, and the schema itself is the
 * allowlist — actions outside `AGENT_TOOL_NAMES` fail the discriminated union,
 * so the agent can only ever invoke the six registered tools.
 *
 * Two layers, same discipline as the metadata / query-understanding seams:
 *   1. `agentDecisionRawSchema` — STRUCTURAL validation (zod). Wrong types,
 *      non-object arguments, unknown actions fail here.
 *   2. `canonicalizeAgentDecision` — policy pass: dedupe ids, drop empty
 *      constraint arrays, bound lengths. Never invents values.
 *
 * Note the deliberate shape: `hard` constraints transferred by the model are
 * bounded and validated against closed enums; anything the user actually stated
 * is ALREADY in `state.hard` (seeded deterministically) and the runner can only
 * union, never subtract (see tools.ts `mergeConstraints`).
 */

const metadataConstraintsRawSchema = z.object({
  categories: z.array(z.enum(CATEGORY_VALUES)).max(8).optional(),
  colors: z.array(z.string().max(40)).max(8).optional(),
  materials: z.array(z.string().max(40)).max(8).optional(),
  seasons: z.array(z.enum(SEASONS)).max(4).optional(),
  occasions: z.array(z.string().max(40)).max(6).optional(),
  formality: z.enum(FORMALITY).nullable().optional(),
  excludeIds: z.array(z.string().max(64)).max(20).optional(),
});

/** Each tool's input schema (the allowlisted, typed surface). */
export const searchToolArgsSchema = z.object({
  query: z.string().max(400).optional(),
  constraints: metadataConstraintsRawSchema.optional(),
});
export const weatherToolArgsSchema = z.object({
  location: z.string().max(120).optional(),
});
export const prefsToolArgsSchema = z.object({}).strict();
export const generateToolArgsSchema = z.object({
  itemIds: z.array(z.string().max(64)).max(50).optional(),
});
export const validateToolArgsSchema = z.object({
  itemIds: z.array(z.string().max(64)).max(16).optional(),
  context: z
    .object({
      occasion: z.string().max(120).optional(),
      mood: z.string().max(120).optional(),
      note: z.string().max(300).optional(),
    })
    .optional(),
});
export const finishToolArgsSchema = z.object({
  itemIds: z.array(z.string().max(64)).max(50).optional(),
  message: z.string().max(400).optional(),
  status: z.enum(["success", "no-valid", "unsatisfiable"]).optional(),
});

/** The allowlist as a zod discriminated union — unknown actions are rejected. */
export const agentDecisionRawSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("search_wardrobe"), arguments: searchToolArgsSchema.optional() }),
  z.object({ action: z.literal("get_weather"), arguments: weatherToolArgsSchema.optional() }),
  z.object({ action: z.literal("get_user_preferences"), arguments: prefsToolArgsSchema.optional() }),
  z.object({ action: z.literal("generate_outfit"), arguments: generateToolArgsSchema.optional() }),
  z.object({ action: z.literal("validate_outfit"), arguments: validateToolArgsSchema.optional() }),
  z.object({ action: z.literal("finish"), arguments: finishToolArgsSchema.optional() }),
]);

export type ParsedAgentDecision = { ok: true; decision: AgentDecision } | { ok: false };

function stripEmptyConstraints(c: z.infer<typeof metadataConstraintsRawSchema> | undefined): MetadataConstraints | undefined {
  if (!c) return undefined;
  const out: MetadataConstraints = {};
  if (c.categories?.length) out.categories = c.categories;
  if (c.colors?.length) out.colors = c.colors;
  if (c.materials?.length) out.materials = c.materials;
  if (c.seasons?.length) out.seasons = c.seasons;
  if (c.occasions?.length) out.occasions = c.occasions;
  if (c.formality) out.formality = c.formality;
  if (c.excludeIds?.length) out.excludeIds = c.excludeIds;
  return Object.keys(out).length > 0 ? out : undefined;
}

function dedupeIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (id.trim() && !out.includes(id)) out.push(id.trim());
  return out;
}

function canonicalizeStatus(status: "success" | "no-valid" | "unsatisfiable" | undefined): AgentFinishStatus {
  return status ?? "success";
}

/**
 * Turn a zod-validated raw decision into the canonical, allowlisted form
 * (null arguments → empty objects; empty arrays stripped; ids deduped).
 */
export function parseAgentDecision(raw: RawAgentDecision): ParsedAgentDecision {
  const res = agentDecisionRawSchema.safeParse(raw);
  if (!res.success) return { ok: false };
  const d = res.data;

  switch (d.action) {
    case "search_wardrobe": {
      const args = d.arguments ?? {};
      return {
        ok: true,
        decision: {
          action: "search_wardrobe",
          arguments: {
            query: args.query?.trim().slice(0, 400) || undefined,
            constraints: stripEmptyConstraints(args.constraints),
          },
        },
      };
    }
    case "get_weather":
      return { ok: true, decision: { action: "get_weather", arguments: { location: d.arguments?.location?.trim() || undefined } } };
    case "get_user_preferences":
      return { ok: true, decision: { action: "get_user_preferences", arguments: {} } };
    case "generate_outfit": {
      const itemIds = dedupeIds(d.arguments?.itemIds ?? []);
      return { ok: true, decision: { action: "generate_outfit", arguments: itemIds.length ? { itemIds } : {} } };
    }
    case "validate_outfit": {
      const args = d.arguments ?? {};
      const itemIds = dedupeIds(args.itemIds ?? []);
      const context = args.context && (args.context.occasion || args.context.mood || args.context.note)
        ? {
            ...(args.context.occasion ? { occasion: args.context.occasion.trim().slice(0, 120) } : {}),
            ...(args.context.mood ? { mood: args.context.mood.trim().slice(0, 120) } : {}),
            ...(args.context.note ? { note: args.context.note.trim().slice(0, 300) } : {}),
          }
        : undefined;
      return {
        ok: true,
        decision: {
          action: "validate_outfit",
          arguments: { ...(itemIds.length ? { itemIds } : {}), ...(context ? { context } : {}) },
        },
      };
    }
    case "finish": {
      const args = d.arguments ?? {};
      const itemIds = dedupeIds(args.itemIds ?? []);
      return {
        ok: true,
        decision: {
          action: "finish",
          arguments: {
            ...(itemIds.length ? { itemIds } : {}),
            ...(args.message?.trim() ? { message: args.message.trim().slice(0, 400) } : {}),
            status: canonicalizeStatus(args.status),
          },
        },
      };
    }
  }
}

export type { AgentDecision, AgentToolName };