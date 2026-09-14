import Link from "next/link";
import { cookies } from "next/headers";
import { getDict } from "@/i18n";
import type { Lang } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const lang: Lang = (await cookies()).get("lang")?.value === "zh" ? "zh" : "en";
  const dict = getDict(lang);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? dict.home.goodMorning : hour < 18 ? dict.home.goodAfternoon : dict.home.goodEvening;

  return (
    <div className="mx-auto flex h-[calc(100vh-4rem)] w-full max-w-6xl flex-col overflow-hidden px-5 py-8 md:px-8 md:py-10">
      {/* — the only content: centred in the LEFT half of the page — */}
      <div className="flex h-full max-w-[52%] flex-col justify-center md:max-w-[50%]">
        <p className="eyebrow mb-3">{greeting} — {dict.home.eyebrow}</p>
        <h1 className="serif-display text-5xl leading-[1.05] md:text-6xl">{dict.home.title}</h1>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-ink-soft">{dict.home.subtitle}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/stylist" className="btn-primary">
            {dict.home.ctaWardrobe} →
          </Link>
          <Link href="/wardrobe/add" className="btn-outline">
            + {dict.home.ctaAdd}
          </Link>
        </div>
      </div>
    </div>
  );
}
