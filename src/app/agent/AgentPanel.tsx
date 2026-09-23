"use client";

import { useState } from "react";
import type { AgentResult, AgentTerminationReason } from "@/lib/agent/types";

/**
 * DEV TEST PANEL — the five browser test cases (PHASE 6). These reproduce the
 * exact golden trajectories from the agent eval (`npm run eval:agent`) when the
 * decision layer is the deterministic mock policy (the default in dev).
 */
const SAMPLE_PROMPTS: { label: string; text: string }[] = [
  { label: "normal", text: "I need a black turtleneck with jeans for winter" },
  { label: "weather", text: "what should I wear today — is it cold outside?" },
  { label: "prefs", text: "an outfit for me with a top and jeans" },
  { label: "retry", text: "give me a black summer outfit" },
  { label: "zero-result", text: "一个精致的黑色手提包" },
];

const TERMINATION_LABEL: Record<AgentTerminationReason, string> = {
  "valid-outfit": "valid outfit — grounded & passed deterministic validation",
  "no-valid-outfit": "no valid outfit — retried, nothing passed",
  "unsatisfiable": "unsatisfiable — a hard constraint cannot be met",
  "max-iterations": "max-iterations — loop budget consumed",
  "timeout": "timeout — wall-clock deadline reached",
  "tool-unavailable": "tool-unavailable — a required tool/provider failed",
  "invalid-tool-call": "invalid-tool-call — no decision could be validated",
};

const TERMINATION_TONE: Record<AgentTerminationReason, "ok" | "warn" | "bad"> = {
  "valid-outfit": "ok",
  "no-valid-outfit": "warn",
  "unsatisfiable": "bad",
  "max-iterations": "bad",
  "timeout": "bad",
  "tool-unavailable": "bad",
  "invalid-tool-call": "bad",
};

function Tone({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "border-sage/40 bg-sage/10 text-sage"
      : tone === "warn"
        ? "border-camel/50 bg-camel/10 text-camel-deep"
        : "border-terra/40 bg-terra/10 text-terra";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] ${cls}`}>
      {children}
    </span>
  );
}

function boolBadge(value: boolean | undefined | null) {
  if (value === true) return <Tone tone="ok">✓ passed</Tone>;
  if (value === false) return <Tone tone="bad">✗ failed</Tone>;
  return <span className="text-ink-faint">—</span>;
}

interface AgentPanelProps {
  imageById: Record<string, string>;
  wardrobeCount: number;
}

export function AgentPanel({ imageById, wardrobeCount }: AgentPanelProps) {
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(query: string) {
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/agent/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: query }),
      });
      const data = (await res.json()) as AgentResult;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  // ── groundedness against the LIVE store snapshot passed from the server ──
  const itemIds = result?.items.map((i) => i.id) ?? [];
  const missing = itemIds.filter((id) => !imageById[id]);
  const dupes = itemIds.filter((id, idx) => itemIds.indexOf(id) !== idx);
  const hasItems = itemIds.length > 0;
  const groundedBadge = !hasItems
    ? null
    : missing.length === 0 && dupes.length === 0
      ? { ok: true as const, label: `all ${itemIds.length} recommended item${itemIds.length === 1 ? "" : "s"} resolve to the live wardrobe` }
      : {
          ok: false as const,
          label: `grounding violated — ${missing.length} unknown id(s)${dupes.length ? `, ${dupes.length} duplicate(s)` : ""}`,
        };

  const termination = result?.terminationReason ?? null;
  const tone = termination ? TERMINATION_TONE[termination] : "warn";

  return (
    <div className="mx-auto max-w-5xl px-5 py-10 md:px-8">
      <p className="eyebrow">DEV TOOL — Phase 6 bounded agent</p>
      <h1 className="serif-display mt-1 text-4xl md:text-5xl">AI Stylist · agent test panel</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        Natural-language request → <code className="text-ink">POST /api/agent/recommend</code> → final look + validation
        + grounding + a sanitized execution trace. No chain-of-thought is shown — only structured tool outcomes. Live
        wardrobe: <span className="text-ink">{wardrobeCount} item{wardrobeCount === 1 ? "" : "s"}</span>.
      </p>

      {/* ── input ── */}
      <div className="hairline mt-8 rounded-xl bg-surface p-5">
        <label className="eyebrow block" htmlFor="agent-query">
          Outfit request
        </label>
        <textarea
          id="agent-query"
          rows={3}
          className="input mt-3 resize-y font-mono text-sm"
          placeholder="e.g. I need a black turtleneck with jeans for winter"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn-primary" onClick={() => run(text)} disabled={running || !text.trim()}>
            {running ? "working…" : "Ask the agent"}
          </button>
          <span className="mx-1 text-[11px] uppercase tracking-[0.16em] text-ink-faint">samples</span>
          {SAMPLE_PROMPTS.map((p) => (
            <button
              key={p.label}
              className="chip !px-2.5 !py-1 !text-[12px]"
              onClick={() => {
                setText(p.text);
                void run(p.text);
              }}
              disabled={running}
              title={p.text}
            >
              {p.label}
            </button>
          ))}
        </div>
        {error && (
          <p className="mt-3 text-[13px] text-terra">
            ✗ {error} — is the dev server running on :3000?
          </p>
        )}
      </div>

      {/* ── result ── */}
      {result && (
        <div className="mt-8 space-y-6">
          {/* status banner */}
          <section className="hairline rounded-xl bg-surface p-5">
            <div className="flex flex-wrap items-center gap-3">
              <Tone tone={result.ok ? "ok" : "bad"}>
                <span className="font-medium">{result.ok ? "recorded" : "not recorded"}</span>
              </Tone>
              <span className="serif-display text-2xl">{result.title}</span>
            </div>
            {result.reason && result.reason !== result.title && (
              <p className="mt-2 text-[13px] leading-relaxed text-ink-soft">{result.reason}</p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-ink-soft">
              <span>
                termination · <Tone tone={tone}>{termination ? TERMINATION_LABEL[termination] : "—"}</Tone>
              </span>
              <span>
                decision lane · <code className="text-ink">{result.decisionProvider}</code>
              </span>
              <span>
                iterations <code className="text-ink">{result.iterationCount}</code> · tools{" "}
                <code className="text-ink">{result.toolCallCount}</code> ·{" "}
                <code className="text-ink">{result.durationMs} ms</code>
              </span>
              <span>
                tools schema · <code className="text-ink">{result.meta.toolSchemaVersion}</code>
              </span>
            </div>
          </section>

          {/* grounding */}
          <section className="hairline rounded-xl bg-surface p-5">
            <p className="eyebrow">Grounding (live-store check)</p>
            <div className="mt-2 flex items-center gap-2">
              {groundedBadge ? (
                <Tone tone={groundedBadge.ok ? "ok" : "bad"}>{groundedBadge.label}</Tone>
              ) : (
                <Tone tone="warn">empty look — nothing grounded to check</Tone>
              )}
            </div>
          </section>

          {/* recommended items */}
          <section className="hairline rounded-xl bg-surface p-5">
            <p className="eyebrow">Final look — {itemIds.length} piece{itemIds.length === 1 ? "" : "s"}</p>
            {result.items.length === 0 ? (
              <p className="mt-3 text-sm text-ink-faint">No pieces recommended for this request.</p>
            ) : (
              <ul className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {result.items.map((it) => (
                  <li key={it.id} className="hairline overflow-hidden rounded-lg bg-paper">
                    <div className="aspect-[4/5] w-full bg-board">
                      {imageById[it.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imageById[it.id]} alt={it.name} className="h-full w-full object-contain" />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[11px] uppercase tracking-[0.16em] text-terra">
                          ghost?
                        </div>
                      )}
                    </div>
                    <div className="px-3 py-2.5">
                      <p className="truncate text-[13px] text-ink" title={it.name}>
                        {it.name}
                      </p>
                      <p className="text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                        {it.category} · {it.role} · #{Math.round(it.score * 100)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* validation */}
          <section className="hairline rounded-xl bg-surface p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="eyebrow">Validation</p>
              <div className="flex gap-2">
                <span className="text-[11px]">overall</span>
                {boolBadge(result.validation?.passed)}
                <span className="text-[11px]">score</span>
                <code className="text-[11px]">{result.validation?.score ?? "—"}</code>
              </div>
            </div>
            <div className="mt-4 grid gap-5 md:grid-cols-2">
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                  Deterministic (authoritative)
                </p>
                <p className="mt-1 text-sm">{boolBadge(result.validation?.deterministic.passed)}</p>
                <ul className="mt-2 space-y-1">
                  {(result.validation?.deterministic.checks ?? []).map((c) => (
                    <li key={c.id} className="flex items-center gap-2 text-[12px] text-ink-soft">
                      {boolBadge(c.passed)}
                      <span>{c.label}</span>
                      {c.detail && <code className="text-ink-faint">{c.detail}</code>}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                  Semantic (advisory review)
                </p>
                <p className="mt-1 text-sm">
                  {result.validation?.semantic.run === false ? (
                    <span className="text-ink-faint">not run (advisory lane skipped)</span>
                  ) : (
                    <>
                      {boolBadge(result.validation?.semantic.passed)} · score{" "}
                      <code>{result.validation?.semantic.score ?? "—"}</code> ·{" "}
                      {result.validation?.semantic.validationResult}
                    </>
                  )}
                </p>
                <ul className="mt-2 space-y-1">
                  {(result.validation?.semantic.checks ?? []).map((c) => (
                    <li key={c.id} className="flex items-center gap-2 text-[12px] text-ink-soft">
                      {boolBadge(c.passed)}
                      <span>{c.id}</span>
                      {c.note && <span className="text-ink-faint">{c.note}</span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-ink-faint">
                  semantic lane only reviews after the deterministic gate passes — it can never approve a look the
                  deterministic lane rejected (D-23).
                </p>
              </div>
            </div>
          </section>

          {/* trace */}
          <section className="hairline rounded-xl bg-surface p-5">
            <p className="eyebrow">Execution trace — {result.trace.length} tool call{result.trace.length === 1 ? "" : "s"}</p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">tool</th>
                    <th className="py-2 pr-3 font-medium">status</th>
                    <th className="py-2 pr-3 font-medium">cands</th>
                    <th className="py-2 pr-3 font-medium">gen</th>
                    <th className="py-2 pr-3 font-medium">det</th>
                    <th className="py-2 pr-3 font-medium">sem</th>
                    <th className="py-2 pr-3 font-medium">score</th>
                    <th className="py-2 pr-3 font-medium">constraints</th>
                    <th className="py-2 font-medium">coded summary</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trace.map((t) => (
                    <tr key={`${t.iteration}-${t.tool}`} className="border-b border-line/60 align-top">
                      <td className="py-2 pr-3 font-mono text-ink-faint">{t.iteration}</td>
                      <td className="py-2 pr-3 font-mono text-ink">{t.tool}</td>
                      <td className="py-2 pr-3">
                        <Tone tone={t.success ? "ok" : "bad"}>{t.success ? "ok" : "fail"}</Tone>
                      </td>
                      <td className="py-2 pr-3 font-mono text-ink-soft">{t.candidateCount ?? "—"}</td>
                      <td className="py-2 pr-3 font-mono text-ink-soft">{t.generatedCount ?? "—"}</td>
                      <td className="py-2 pr-3">
                        {t.validationDetPassed === undefined ? (
                          <span className="text-ink-faint">—</span>
                        ) : (
                          <Tone tone={t.validationDetPassed ? "ok" : "bad"}>
                            {t.validationDetPassed ? "pass" : "fail"}
                          </Tone>
                        )}
                      </td>
                      <td className="py-2 pr-3">{boolBadge(t.validationSemPassed)}</td>
                      <td className="py-2 pr-3 font-mono text-ink-soft">{t.validationScore ?? "—"}</td>
                      <td className="py-2 pr-3 font-mono text-ink-soft">
                        {t.searchConstraints ? JSON.stringify(t.searchConstraints) : "—"}
                      </td>
                      <td className="py-2 text-ink-faint">{t.summary}</td>
                    </tr>
                  ))}
                  {result.trace.length === 0 && (
                    <tr>
                      <td colSpan={10} className="py-3 text-ink-faint">
                        The agent ran no tools (e.g. the tool-unavailable fallback response).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* hard constraints */}
          <section className="hairline rounded-xl bg-surface p-5">
            <p className="eyebrow">Hard constraints the agent honored (frozen, union-only)</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-ink p-3 text-[11px] leading-relaxed text-paper">
              {JSON.stringify(result.hard, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}