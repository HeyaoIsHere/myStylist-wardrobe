"use client";

import { useI18n } from "@/i18n/LanguageProvider";

export function LanguageSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <div className="flex items-center gap-1.5 text-[12px] tracking-[0.08em]" role="group" aria-label="Language">
      <button
        onClick={() => setLang("en")}
        className={`px-1 py-0.5 transition-colors ${lang === "en" ? "text-ink underline underline-offset-4" : "text-ink-faint hover:text-ink"}`}
      >
        EN
      </button>
      <span className="text-line-strong">/</span>
      <button
        onClick={() => setLang("zh")}
        className={`px-1 py-0.5 transition-colors ${lang === "zh" ? "text-ink underline underline-offset-4" : "text-ink-faint hover:text-ink"}`}
      >
        中文
      </button>
    </div>
  );
}
