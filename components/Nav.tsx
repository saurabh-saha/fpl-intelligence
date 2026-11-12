"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/my-team", label: "My Team" },
  { href: "/team-builder", label: "New squad" },
  { href: "/strategies/balanced-plus", label: "Balanced Plus" },
  { href: "/players", label: "Players" },
  { href: "/dashboard", label: "Dashboard" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 bg-gradient-to-r from-fpl-purple to-fpl-purple-2 text-white shadow-md">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-3 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-extrabold tracking-tight">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-fpl-green text-fpl-purple">⚽</span>
          <span className="hidden sm:inline">FPL Intelligence</span>
        </Link>
        <nav className="ml-auto flex gap-1 text-sm font-semibold">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-full px-3 py-1.5 transition ${path.startsWith(l.href) ? "bg-fpl-green text-fpl-purple" : "hover:bg-white/15"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
