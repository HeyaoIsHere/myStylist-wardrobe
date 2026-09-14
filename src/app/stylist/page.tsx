import { getStore } from "@/lib/db/store";
import { itemImage } from "@/lib/assets";
import { StylistClient } from "./StylistClient";

export const dynamic = "force-dynamic";

/** The merged page: fixed height, wardrobe left (scrolls), creative board right. */
export default async function StylistPage() {
  const store = getStore();
  const items = store.wardrobe.map((i) => ({ ...i, image: itemImage(i) }));
  return <StylistClient items={items} />;
}
