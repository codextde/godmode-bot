"use client";

import { Fragment, useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export interface SectionNavItem {
  href: string;
  label: string;
  icon?: ReactNode;
  /** Heading shown above this item (wide layout) when it differs from the previous item's group. */
  group?: string;
}

/**
 * Section sub-navigation (house rule 2): below `@4xl` a horizontally scrolling strip with soft edges, above it a
 * vertical list with group labels. The active item carries a sliding pill (spring 420/36).
 */
export function SectionNav({ items, label, className }: { items: SectionNavItem[]; label: string; className?: string }) {
  const pathname = usePathname();
  const activeRef = useRef<HTMLAnchorElement>(null);
  const active = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;

  // Keep the active entry visible in the narrow strip.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  return (
    <nav aria-label={label} className={className}>
      <ul className="scroll-fade-x no-scrollbar -mx-5 flex gap-1 overflow-x-auto px-5 @2xl:-mx-8 @2xl:px-8 @4xl:mx-0 @4xl:flex-col @4xl:gap-0.5 @4xl:overflow-visible @4xl:px-0 @4xl:[mask-image:none] @4xl:[animation:none]">
        {items.map((item, i) => {
          const isActive = item.href === active;
          const showGroup = item.group && item.group !== items[i - 1]?.group;
          return (
            <Fragment key={item.href}>
              {showGroup && (
                <li aria-hidden className={cn("eyebrow hidden px-2.5 pb-1.5 text-[10.5px] @4xl:block", i > 0 && "pt-4")}>
                  {item.group}
                </li>
              )}
              <li className="shrink-0">
                <Link
                  ref={isActive ? activeRef : undefined}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative flex h-8 items-center gap-2 rounded-md px-2.5 text-[13.5px] whitespace-nowrap outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:shrink-0",
                    isActive ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId={`section-nav-pill-${label}`}
                      aria-hidden
                      className="absolute inset-0 rounded-md bg-card shadow-card ring-1 ring-border"
                      transition={{ type: "spring", stiffness: 420, damping: 36 }}
                    />
                  )}
                  <span className="relative flex items-center gap-2">
                    {item.icon}
                    {item.label}
                  </span>
                </Link>
              </li>
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}
