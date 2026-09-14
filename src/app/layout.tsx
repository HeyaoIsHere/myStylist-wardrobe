import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { LanguageProvider } from "@/i18n/LanguageProvider";
import { Nav } from "@/components/layout/Nav";
import type { Lang } from "@/lib/types";

export const metadata: Metadata = {
  title: "myStylist — AI Personal Stylist",
  description:
    "Your digital wardrobe and personal stylist. Know your wardrobe, understand your style, dress better.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const lang: Lang = cookieStore.get("lang")?.value === "zh" ? "zh" : "en";

  return (
    <html lang={lang === "zh" ? "zh-CN" : "en"}>
      <body className="flex min-h-screen flex-col">
        <LanguageProvider initialLang={lang}>
          <Nav />
          <main className="flex-1">{children}</main>
        </LanguageProvider>
      </body>
    </html>
  );
}
