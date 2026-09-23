import { NextResponse } from "next/server";
import { defaultAgentDeps, runAgent } from "@/lib/agent";

/**
 * POST /api/agent/recommend — bounded agentic outfit planning (Phase 6).
 *
 * Exactly the same contract as POST /api/recommend (which stays for direct
 * comparison), but the LOOK is chosen by a bounded agent: a decision layer
 * observes the structured run state and picks a tool from the allowlist
 * (`search_wardrobe` / `get_weather` / `get_user_preferences` /
 * `generate_outfit` / `validate_outfit` / `finish`) until a grounded outfit
 * passes deterministic validation or the run terminates for a structured reason.
 *
 *   { text }  →  { ok, title, reason, items, hard, terminationReason, trace,
 *                   iterationCount, toolCallCount, durationMs, decisionProvider,
 *                   validation, meta }
 *
 * Deterministic validation is ALWAYS re-run on the final look and stays
 * authoritative — the agent cannot bypass it. The response is ALWAYS a shaped
 * safe JSON object; the try/catch below is a belt-and-braces net.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  try {
    const result = await runAgent(text, defaultAgentDeps());
    return NextResponse.json(result);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        title: "No recommendation",
        reason: "Recommendation is temporarily unavailable — try again shortly.",
        items: [],
        hard: {},
        terminationReason: "tool-unavailable",
        trace: [],
        iterationCount: 0,
        toolCallCount: 0,
        durationMs: 0,
        decisionProvider: "unavailable",
        validation: null,
        meta: {
          agentRunId: "n/a",
          requestId: "n/a",
          provider: "n/a",
          model: "n/a",
          toolSchemaVersion: "n/a",
          latencyMs: 0,
          usage: null,
          errorCategory: "unknown",
        },
      },
      { status: 200 },
    );
  }
}