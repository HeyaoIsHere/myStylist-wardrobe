import { getStore } from "@/lib/db/store";
import { itemImage } from "@/lib/assets";
import { AgentPanel } from "./AgentPanel";

export const dynamic = "force-dynamic";

/**
 * DEV TEST PANEL for the Phase 6 bounded agent (POST /api/agent/recommend).
 *
 * Deliberately minimal and self-contained (no backend / architecture changes):
 * it only forwards the live wardrobe's id→image and id→name maps to the client
 * so recommended items can be rendered and groundedness verified against the
 * REAL runtime store. The panel is a testing tool — the copy is not i18n'd.
 */
export default function AgentPage() {
  const store = getStore();
  const imageById: Record<string, string> = {};
  for (const item of store.wardrobe) {
    imageById[item.id] = itemImage(item);
  }
  return <AgentPanel imageById={imageById} wardrobeCount={store.wardrobe.length} />;
}