"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/i18n/LanguageProvider";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";

const LINKS = [
  { key: "home", href: "/" },
  { key: "wardrobe", href: "/stylist" },
  { key: "profile", href: "/profile" },
] as const;

function activeKey(pathname: string): string {
  if (pathname === "/") return "home";
  return LINKS.find((l) => l.href !== "/" && (pathname === l.href || pathname.startsWith(l.href + "/")))?.key ?? "";
}

export function Nav() {
  const { dict } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = activeKey(pathname);
  const close = () => setOpen(false);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-paper/92 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 md:px-8">
          <Link href="/" className="font-serif text-[22px] font-medium tracking-tight text-ink" aria-label="myStylist">
            my<i className="font-normal">Stylist</i>
          </Link>

          <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
            {LINKS.map(({ key, href }) => (
              <Link
                key={key}
                href={href}
                onClick={close}
                className={`text-[12px] uppercase tracking-[0.16em] transition-colors ${
                  active === key
                    ? "text-ink"
                    : "text-ink-faint hover:text-ink"
                } relative after:absolute after:-bottom-1.5 after:left-0 after:h-px after:bg-ink after:transition-all ${
                  active === key ? "after:w-full" : "after:w-0"
                }`}
              >
                {dict.nav[key]}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <LanguageSwitch />
            <button
              className="flex h-10 w-10 flex-col items-center justify-center gap-1.5 md:hidden"
              onClick={() => setOpen(!open)}
              aria-label="Menu"
              aria-expanded={open}
            >
              <span className={`h-px w-6 bg-ink transition-transform ${open ? "translate-y-[3.5px] rotate-45" : ""}`} />
              <span className={`h-px w-6 bg-ink transition-transform ${open ? "-translate-y-[3.5px] -rotate-45" : ""}`} />
            </button>
          </div>
        </div>
      </header>

      {/* Mobile menu — rendered OUTSIDE the <header> on purpose: the header's
          backdrop-blur makes it the containing block for fixed descendants,
          so a `fixed` overlay inside the header would be trapped in the 4rem
          bar and overlap the page instead of covering the viewport. */}
      {open && (
        <div className="fixed inset-0 top-16 z-30 flex flex-col bg-paper px-8 pt-10 md:hidden">
          {LINKS.map(({ key, href }, i) => (
            <Link
              key={key}
              href={href}
              onClick={close}
              className={`border-b border-line py-5 font-serif text-3xl transition-colors ${
                active === key ? "text-ink" : "text-ink-faint"
              }`}
              style={{ animation: `fade-up .4s ease ${i * 0.05}s both` }}
            >
              {dict.nav[key]}
            </Link>
          ))}
          <p className="mt-auto mb-10 text-center text-[11px] uppercase tracking-[0.24em] text-ink-faint">
            {dict.brand.tagline}
          </p>
        </div>
      )}
    </>
  );
}
