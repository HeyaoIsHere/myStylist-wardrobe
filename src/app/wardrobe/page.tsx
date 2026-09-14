import { redirect } from "next/navigation";

/** The wardrobe lives inside the merged /stylist page. */
export default function WardrobePage() {
  redirect("/stylist");
}
