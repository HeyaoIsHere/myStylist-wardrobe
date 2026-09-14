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

/** ALL saved looks — reached from the profile's "See the rest" button. */
export default async function SavedLooksPage() {
  const lang: Lang = (await cookies()).get("lang")?.value === "zh" ? "zh" : "en";
  const dict = getDict(lang);
  const store = getStore();

  const savedOutfits = store.outfits.filter((o) => o.saved);
  const fallbackImages = store.wardrobe.map((i) => ({ id: i.id, image: itemImage(i) }));

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 md:px-8 md:py-16">
      <Link href="/profile" className="btn-ghost mb-8">
        ← {dict.common.back}
      </Link>

      <SectionHeading
        eyebrow={dict.brand.tagline}
        title={dict.profile.allSavedLooks}
        sub={dict.profile.savedOutfitsSub}
      />

      {savedOutfits.length === 0 ? (
        <EmptyState
          title={dict.profile.emptyOutfits}
          hint={dict.profile.emptyOutfitsHint}
          action={
            <Link href="/stylist" className="btn-primary">
              {dict.profile.openStylist}
            </Link>
          }
        />
      ) : (
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {savedOutfits.map((outfit) => (
            <SavedLookCard key={outfit.id} outfit={outfit} lang={lang} fallbackImages={fallbackImages} />
          ))}
        </div>
      )}
    </div>
  );
}
