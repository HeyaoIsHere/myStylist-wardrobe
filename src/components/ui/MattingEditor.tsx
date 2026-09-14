"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/i18n/LanguageProvider";
import type { Category } from "@/lib/types";
import { CutoutEditor } from "@/components/ui/CutoutEditor";

/** Local Python matting service (GroundingDINO + SAM2). */
const MATTING_URL = process.env.NEXT_PUBLIC_MATTING_URL ?? "http://localhost:8001";

interface MattingEditorProps {
  src: string; // original photo data URL — the mask overlays it directly
  onDone: (cutoutDataUrl: string) => void; // final 512 transparent PNG
  onHint?: (category: Category | null) => void;
  onCancel: () => void;
}

type Stage = "detect" | "mask" | "normalize" | "done" | "manual" | "error";

/** Progress shown per stage — the service reports stages live via NDJSON. */
const STAGES: { key: Stage; label: "stageDetect" | "stageMask" | "stageNormalize"; pct: number }[] = [
  { key: "detect", label: "stageDetect", pct: 15 },
  { key: "mask", label: "stageMask", pct: 45 },
  { key: "normalize", label: "stageNormalize", pct: 75 },
];

/**
 * Auto matting page: fixed 3:4 portrait preview on the left, live progress
 * report on the right. Only two actions — Done and Cancel.
 */
export function MattingEditor({ src, onDone, onHint, onCancel }: MattingEditorProps) {
  const { dict } = useI18n();
  const [stage, setStage] = useState<Stage>("detect");
  const [result, setResult] = useState<{ url: string; baseUrl: string } | null>(null);
  const [edited, setEdited] = useState<string | null>(null); // manual repair output
  const abortRef = useRef<AbortController | null>(null);
  // refs so the pipeline doesn't re-run when the parent re-renders callbacks
  const onHintRef = useRef(onHint);
  onHintRef.current = onHint;

  const run = useCallback(() => {
    setStage("detect");
    setResult(null);
    setEdited(null);
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        let res: Response;
        try {
          res = await fetch(`${MATTING_URL}/matting`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: src }),
            signal: controller.signal,
          });
        } catch {
          // the local service may still be loading models right after it
          // starts (health not up yet) — give it one short second chance
          await new Promise((r) => setTimeout(r, 1200));
          res = await fetch(`${MATTING_URL}/matting`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: src }),
            signal: controller.signal,
          });
        }
        if (!res.ok || !res.body) throw new Error("matting request failed");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const raw = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            nl = buf.indexOf("\n");
            if (!raw) continue;
            const evt = JSON.parse(raw) as {
              stage: string;
              url?: string;
              baseUrl?: string;
              categoryHint?: Category | null;
            };
            if (evt.stage === "done" || evt.stage === "manual") {
              setResult({ url: evt.url ?? "", baseUrl: evt.baseUrl ?? evt.url ?? "" });
              onHintRef.current?.(evt.categoryHint ?? null);
              setStage(evt.stage as Stage);
            } else if (evt.stage === "error") {
              throw new Error("matting failed");
            } else {
              setStage(evt.stage as Stage);
            }
          }
        }
      } catch {
        // Service down or pipeline crash — fall back to manual painting on
        // the original photo so the edit step always works, even without
        // the local matting service. The retry button lets the user try
        // auto matting again once the service is back.
        if (!controller.signal.aborted) {
          setResult({ url: "", baseUrl: "" });
          setStage("manual");
        }
      }
    })();
  }, [src]);

  useEffect(() => {
    run();
    return () => abortRef.current?.abort();
  }, [run]);

  const stageIndex = STAGES.findIndex((s) => s.key === stage);
  const pct = stage === "done" ? 100 : stage === "manual" ? 90 : stageIndex >= 0 ? STAGES[stageIndex].pct : 0;
  const showEditor = (stage === "done" || stage === "manual") && result !== null;

  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,460px)_1fr]">
      {/* — left: fixed 3:4 portrait preview, left-aligned with the page heading.
           After the pipeline the GREEN mask editor takes over the box: the
           photo stays visible, green marks what is kept, Done cuts it. — */}
      <div>
        <div className="checker hairline aspect-[3/4] w-full max-w-[460px] overflow-hidden">
          {showEditor ? (
            <CutoutEditor
              photoSrc={src}
              maskSrc={result.url}
              initialEmpty={stage === "manual"}
              onSave={setEdited}
            />
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element — user upload */
            <img
              src={src}
              alt=""
              className="h-full w-full object-contain opacity-90 transition-opacity duration-500"
            />
          )}
        </div>
        <p className="mt-3 max-w-[460px] text-[11px] uppercase tracking-[0.18em] text-ink-faint">
          {dict.addItem.cutoutHint}
        </p>
      </div>

      {/* — right: live progress report, only Done + Cancel — */}
      <div className="flex flex-col gap-6">
        <div>
          <p className="eyebrow">{dict.common.aiNote}</p>
          <p className="serif-display text-2xl">
            {stage === "done" ? dict.addItem.matting.stageDone : stage === "manual" ? dict.addItem.matting.manualNotice : dict.addItem.processing}
          </p>
        </div>

        {/* progress bar */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-ink transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* live stage report */}
        <ol className="flex flex-col gap-3">
          {STAGES.map((s, i) => {
            const past = stageIndex > i || stage === "done";
            const active = stageIndex === i;
            return (
              <li
                key={s.key}
                className={`flex items-center gap-2.5 text-[14px] transition-colors ${
                  past ? "text-ink" : active ? "text-ink-soft" : "text-ink-faint"
                }`}
              >
                <span className="w-4 text-center">
                  {past ? "✓" : active ? "●" : "○"}
                </span>
                {dict.addItem.matting[s.label]}
              </li>
            );
          })}
        </ol>

        <div className="mt-2 flex items-center gap-4">
          {stage === "manual" && (
            <button className="btn-outline" onClick={run}>
              ↺ {dict.addItem.matting.retry}
            </button>
          )}
          <button
            className="btn-primary"
            onClick={() => edited && onDone(edited)}
            disabled={!edited}
          >
            {dict.common.done}
          </button>
          <button className="btn-ghost" onClick={onCancel}>
            {dict.common.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
