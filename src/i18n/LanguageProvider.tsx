"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/types";
import { getDict, type Dict } from "./index";

interface I18nContextValue {
  lang: Lang;
  dict: Dict;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nContextValue>({
  lang: "en",
  dict: getDict("en"),
  setLang: () => {},
});

export function LanguageProvider({
  initialLang,
  children,
}: {
  initialLang: Lang;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback(
    (next: Lang) => {
      setLangState(next);
      document.cookie = `lang=${next}; path=/; max-age=31536000`;
      try {
        localStorage.setItem("mystylist.lang", next);
      } catch {
        /* private mode — cookie still works */
      }
      router.refresh();
    },
    [router],
  );

  return (
    <I18nContext.Provider value={{ lang, dict: getDict(lang), setLang }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
