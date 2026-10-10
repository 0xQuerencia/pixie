"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  IconHome,
  IconGrid,
  IconKey,
  IconChat,
  IconDoc,
  IconGaps,
  IconUsers,
  IconPeople,
  IconMacro,
  IconBars,
  IconGauge,
  IconRadar,
  IconSiren,
  IconLog,
  IconHourglass,
  IconGear,
} from "./icons";

// Small client island so the sidebar can show which route is active without
// making the whole shell a client component. Just links + usePathname — no
// state, no effects.
//
// Every item gets its own sprite, all from the onboarding's 1-bit pixel pack:
// the nav is the one place a product shows all of them at once, so repeated
// icons read as a bug rather than as restraint.

type IconComponent = ComponentType<{ size?: number; className?: string }>;
type Item = [slug: string, label: string, Icon: IconComponent];

const MAIN: Item[] = [
  ["tickets", "Tickets", IconChat],
  ["knowledge", "Knowledge", IconDoc],
  ["gaps", "FAQ gaps", IconGaps],
  ["helpers", "Helpers", IconUsers],
  ["people", "People", IconPeople],
  ["macros", "Macros", IconMacro],
  ["answer-inspector", "Answer Inspector", IconGauge],
  ["analytics", "Analytics", IconBars],
  ["usage", "Quota & usage", IconGauge],
  ["radar", "Support radar", IconRadar],
  ["incidents", "Incidents", IconSiren],
];

const SECONDARY: Item[] = [
  ["audit", "Audit", IconLog],
  ["retention", "Retention", IconHourglass],
  ["settings", "Settings", IconGear],
];

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  href,
  label,
  exact,
  muted,
  Icon,
}: {
  href: string;
  label: string;
  exact: boolean;
  muted?: boolean;
  Icon: IconComponent;
}) {
  const pathname = usePathname();
  const active = isActive(pathname ?? "", href, exact);
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={`relative flex items-center gap-2.5 rounded-[3px] py-[7px] pl-3 pr-2 text-[13px] transition-colors ${
        active
          ? "bg-brand/10 text-text"
          : `${muted ? "text-text-dim" : "text-text-muted"} hover:bg-panel-2 hover:text-text`
      }`}
    >
      {/* The active step's lime outline, in miniature: a 2px lime bar down the
          left edge, with the icon carrying the same lime. `pixie-mark-bg` so
          the bar is the day theme's mark colour rather than lime on cream. */}
      {active && <span className="pixie-mark-bg absolute inset-y-[3px] left-0 w-[2px]" aria-hidden="true" />}
      <Icon size={16} className={`shrink-0 ${active ? "text-lime" : ""}`} />
      {label}
    </Link>
  );
}

export function WorkspaceNav() {
  return (
    <nav className="mt-2.5 space-y-px">
      <NavLink href="/overview" label="Overview" exact Icon={IconHome} />
      <NavLink href="/programs" label="Programs" exact Icon={IconGrid} />
      <NavLink href="/people" label="People & access" exact Icon={IconKey} />
    </nav>
  );
}

function MobileNavLink({ href, label, exact }: { href: string; label: string; exact: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname ?? "", href, exact);
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap border-b-2 pb-1.5 text-[13px] transition-colors ${
        active ? "border-brand text-text" : "border-transparent text-text-muted"
      }`}
    >
      {label}
    </Link>
  );
}

// Shown in the header on narrow viewports where the sidebar is hidden.
export function MobileProgramNav({ programId }: { programId: string }) {
  const base = `/programs/${programId}`;
  return (
    <nav className="pixie-mobile-nav flex w-full gap-4 overflow-x-auto pr-3 pb-px lg:hidden">
      <MobileNavLink href={base} label="Overview" exact />
      {[...MAIN, ...SECONDARY].map(([slug, label]) => (
        <MobileNavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} />
      ))}
    </nav>
  );
}

export function ProgramNav({ programId }: { programId: string }) {
  const base = `/programs/${programId}`;
  return (
    <>
      <nav className="mt-2.5 space-y-px">
        <NavLink href={base} label="Overview" exact Icon={IconHome} />
        {MAIN.map(([slug, label, Icon]) => (
          <NavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} Icon={Icon} />
        ))}
      </nav>
      <nav className="mt-3 space-y-px">
        {SECONDARY.map(([slug, label, Icon]) => (
          <NavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} Icon={Icon} muted />
        ))}
      </nav>
    </>
  );
}
