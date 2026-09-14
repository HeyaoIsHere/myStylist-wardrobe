import { NextResponse } from "next/server";
import { ai } from "@/lib/services/ai";

export const dynamic = "force-dynamic";

/** Mock vision classification — simulate model latency, then respond. */
export async function POST(request: Request) {
  let body: { hash?: string; name?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const hash = body.hash ?? body.name ?? "item";
  await new Promise((r) => setTimeout(r, 1400));
  const result = await ai.classifyClothing(hash);
  return NextResponse.json(result);
}
