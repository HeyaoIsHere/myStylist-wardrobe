import Link from "next/link";
import { cookies } from "next/headers";
import { getDict } from "@/i18n";
import { getStore } from "@/lib/db/store";
import { itemImage } from "@/lib/assets";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { EmptyState } from "@/components/ui/EmptyState";
import { SavedLookCard } from "@/components/looks/SavedLookCard";
import type { Lang } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const lang: Lang = (await cookies()).get("lang")?.value === "zh" ? "zh" : "en";
  const dict = getDict(lang);
  const store = getStore();

  const savedOutfits = store.outfits.filter((o) => o.saved);
  // only the three latest looks are shown here — the rest live in the AI Stylist
  const shown = savedOutfits.slice(0, 3);
  const more = savedOutfits.length - shown.length;

  const stats: { value: string; label: string }[] = [
    { value: String(store.wardrobe.length), label: dict.profile.statItems },
    { value: String(savedOutfits.length), label: dict.profile.statOutfits },
  ];

  const fallbackImages = store.wardrobe.map((i) => ({ id: i.id, image: itemImage(i) }));

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-16">
      <SectionHeading eyebrow={dict.brand.tagline} title={dict.profile.title} sub={dict.profile.subtitle} />

      {/* — stats — */}
      <section>
        <p className="eyebrow mb-5">{dict.profile.stats}</p>
        <div className="grid grid-cols-2 gap-px bg-line md:grid-cols-2">
          {stats.map(({ value, label }) => (
            <div key={label} className="bg-surface px-6 py-8 text-center">
              <p className="serif-display truncate text-4xl">{value}</p>
              <p className="eyebrow mt-2">{label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* — saved looks — */}
      <section className="mt-16">
        <SectionHeading
          eyebrow=""
          title={dict.profile.savedOutfits}
          sub={dict.profile.savedOutfitsSub}
          right={
            <Link href="/profile/saved" className="btn-ghost text-[12px] uppercase tracking-[0.14em]">
              {dict.profile.seeTheRest} →
            </Link>
          }
        />
        {savedOutfits.length === 0 ? (
          <EmptyState
            title={dict.profile.emptyOutfits}
            hint={dict.profile.emptyOutfitsHint}
            action={<Link href="/stylist" className="btn-primary">{dict.profile.openStylist}</Link>}
          />
        ) : (
          <>
            <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((outfit) => (
                <SavedLookCard key={outfit.id} outfit={outfit} lang={lang} fallbackImages={fallbackImages} />
              ))}
            </div>
            {more > 0 && (
              <p className="mt-8 text-center text-[12px] uppercase tracking-[0.16em] text-ink-faint">
                {dict.profile.moreLooks.replace("{n}", String(more))} —{" "}
                <Link href="/profile/saved" className="underline underline-offset-4">
                  {dict.profile.seeTheRest}
                </Link>
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
