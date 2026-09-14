import { en, type Dict } from "./en";
import { zh } from "./zh";
import type { Lang, Localized } from "@/lib/types";

export type { Dict };

export function getDict(lang: Lang): Dict {
  return lang === "zh" ? zh : en;
}

/** Pick the right side of a Localized string for the current language. */
export function pick(l: Localized, lang: Lang): string {
  return lang === "zh" ? l.zh : l.en;
}
