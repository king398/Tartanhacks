"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

type NavItem = {
  href: string;
  label: string;
};

const navItems: NavItem[] = [
  { href: "/", label: "Live View" },
  { href: "/analytics", label: "Analytics" },
  { href: "/recommendation-activity", label: "Recommended Activity" },
  { href: "/business-profile", label: "Business Insights" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname.startsWith(href);
}

function IconButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
    >
      {children}
    </button>
  );
}

export default function TopNav() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMobileMenuOpen(false);
    setProfileMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!profileMenuRef.current?.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 shadow-sm backdrop-blur">
      <div className="mx-auto w-[min(1280px,calc(100%-24px))] md:w-[min(1280px,calc(100%-36px))]">
        <div className="flex h-14 items-center justify-between gap-3 md:h-16">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href="/"
              className="inline-flex items-center gap-2 rounded-md px-1 py-1 text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-slate-50 text-slate-700">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <rect x="4" y="6" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M6.5 6V3.8M10 6V3.2M13.5 6V3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
              <span className="text-sm font-semibold tracking-tight md:text-base">FriedVision</span>
            </Link>

            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              Live
            </span>
          </div>

          <nav className="hidden items-center gap-1 rounded-full border border-slate-200 bg-slate-50 p-1 md:flex">
            {navItems.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-full px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                    active
                      ? "bg-white font-medium text-slate-900 shadow-sm"
                      : "font-normal text-slate-600 hover:bg-white hover:text-slate-900"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-1.5">
            <div className="hidden items-center gap-1 sm:flex">
              <IconButton label="Search">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M13.2 13.2L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </IconButton>
              <IconButton label="Notifications">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <path d="M10 3.5C7.9 3.5 6.2 5.2 6.2 7.3V9.2C6.2 10.2 5.8 11.2 5.1 12L4.3 12.9H15.7L14.9 12C14.2 11.2 13.8 10.2 13.8 9.2V7.3C13.8 5.2 12.1 3.5 10 3.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M8.5 15.1C8.8 15.7 9.3 16 10 16C10.7 16 11.2 15.7 11.5 15.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </IconButton>
              <IconButton label="Settings">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                  <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M10 3.3V5M10 15V16.7M16.7 10H15M5 10H3.3M14.8 5.2L13.6 6.4M6.4 13.6L5.2 14.8M14.8 14.8L13.6 13.6M6.4 6.4L5.2 5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </IconButton>
            </div>

            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 md:hidden"
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" className="h-4 w-4">
                <path d="M4 6H16M4 10H16M4 14H16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>

            <div className="relative" ref={profileMenuRef}>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-xs font-semibold text-slate-700 transition hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                aria-label="Open user menu"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                onClick={() => setProfileMenuOpen((open) => !open)}
              >
                FV
              </button>

              {profileMenuOpen ? (
                <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-40 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg" role="menu">
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    role="menuitem"
                  >
                    Profile
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    role="menuitem"
                  >
                    Account
                  </button>
                  <button
                    type="button"
                    className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                    role="menuitem"
                  >
                    Logout
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {mobileMenuOpen ? (
          <nav className="border-t border-slate-200 pb-3 pt-2 md:hidden">
            <div className="grid gap-1">
              {navItems.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileMenuOpen(false)}
                    className={`rounded-lg px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                      active
                        ? "bg-slate-100 font-medium text-slate-900"
                        : "font-normal text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        ) : null}
      </div>
    </header>
  );
}
