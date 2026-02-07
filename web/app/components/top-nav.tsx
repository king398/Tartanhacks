"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
};

const navItems: NavItem[] = [
  { href: "/", label: "Live View" },
  { href: "/analytics", label: "Analytics" },
  { href: "/business-profile", label: "Business Profile" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname.startsWith(href);
}

export default function TopNav() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-30 px-3 pt-3 md:px-4 md:pt-4">
      <div className="mx-auto flex w-[min(1280px,calc(100%-24px))] items-center justify-between rounded-2xl border border-slate-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur md:w-[min(1280px,calc(100%-36px))] md:px-4">
        <div className="display text-sm font-semibold tracking-tight text-graphite md:text-base">Queue Command Center</div>
        <nav className="flex flex-wrap gap-2">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                  active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
