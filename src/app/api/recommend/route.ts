import { NextResponse } from "next/server";
import { defaultRecommendDeps, recommend } from "@/lib/recommend/pipeline";

/**
 * POST /api/recommend — LLM query understanding + grounded recommendation +
 * outfit validation (Phase 3 + Phase 4).
 *
 * The only input is the user's free-text request. The response is ALWAYS a
 * shaped, safe JSON object (`ok` / `items` / `reason` / `validation` / `meta`)
 * — on model, retrieval, compose, or validation trouble it resolves with
 * `ok:false`, never with an error that could crash the UI. Item ids in `items`
 * are REAL wardrobe ids returned by the retrieval lane and re-verified by the
 * deterministic validator; the LLM never supplies them.
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
    // `recommend` is fail-safe end-to-end; the try/catch is a belt-and-braces
    // net so a slam-dunk bug can still never crash the route.
    const recommendation = await recommend(text, defaultRecommendDeps());
    return NextResponse.json(recommendation);
  } catch {
    return NextResponse.json(
      {
        ok: false,
        title: "Recommendation unavailable",
        reason: "Recommendation is temporarily unavailable — try again shortly.",
        items: [],
        query: null,
        retrieval: null,
        validation: {
          passed: false,
          deterministic: {
            passed: false,
            checks: [],
          },
          semantic: {
            run: false,
            passed: null,
            score: null,
            validationResult: "none",
            checks: [],
            issues: [],
            provider: null,
            model: null,
            schemaVersion: null,
            llmAttempts: 0,
            llmRetries: 0,
            usage: null,
            errorCategory: null,
            skipReason: "pipeline aborted before validation",
          },
        },
        meta: { requestId: "n/a", errorCategory: "unknown", grounded: false },
      },
      { status: 200 },
    );
  }
}