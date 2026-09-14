import { NextResponse } from "next/server";
import { resetStore } from "@/lib/db/store";

export const dynamic = "force-dynamic";

/** Restore the seeded demo data. */
export async function POST() {
  resetStore();
  return NextResponse.json({ ok: true });
}
