import { Fragment } from "react";
import Link from "next/link";
import { Info, Megaphone, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/** Legal links from Settings → General; empty strings mean "not set". */
export interface LegalInfo {
  termsUrl: string;
  privacyUrl: string;
  imprintUrl: string;
  supportEmail: string;
}

export interface Announcement {
  text: string;
  tone: "info" | "warning";
}

/** Terms · Privacy · Imprint · Contact <supportEmail> — only the ones that are set. Renders nothing when none are. */
export function LegalLinks({ legal, className }: { legal: LegalInfo; className?: string }) {
  const links = [
    legal.termsUrl && { href: legal.termsUrl, label: "Terms" },
    legal.privacyUrl && { href: legal.privacyUrl, label: "Privacy" },
    legal.imprintUrl && { href: legal.imprintUrl, label: "Imprint" },
    legal.supportEmail && { href: `mailto:${legal.supportEmail}`, label: `Contact ${legal.supportEmail}` },
  ].filter((l): l is { href: string; label: string } => Boolean(l));
  if (links.length === 0) return null;
  return (
    <nav aria-label="Legal" className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted-foreground", className)}>
      {links.map((link, i) => (
        <Fragment key={link.label}>
          {i > 0 && (
            <span aria-hidden className="opacity-40">
              ·
            </span>
          )}
          <a
            href={link.href}
            {...(link.href.startsWith("mailto:") ? {} : { target: "_blank", rel: "noopener noreferrer" })}
            className="rounded-sm break-all underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {link.label}
          </a>
        </Fragment>
      ))}
    </nav>
  );
}

/** The admin's announcement (Settings → General) as a slim bar above the page; also on the sign-in page. */
export function AnnouncementBar({ announcement, className }: { announcement: Announcement; className?: string }) {
  const warning = announcement.tone === "warning";
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-start gap-2.5 border-b px-5 py-2.5 text-[13px] leading-snug",
        warning ? "border-warning/25 bg-warning/[0.08]" : "bg-paper-2",
        className,
      )}
    >
      {warning ? (
        <TriangleAlert aria-hidden className="mt-px size-4 shrink-0 text-warning" />
      ) : (
        <Megaphone aria-hidden className="mt-px size-4 shrink-0 text-muted-foreground" />
      )}
      <p className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">{announcement.text}</p>
    </div>
  );
}

/** Shown to people who may edit e-mail settings while sign-in links only go to the server log. */
export function EmailNoticeBar({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={cn("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/25 bg-warning/[0.08] px-5 py-2.5 text-[13px]", className)}
    >
      <span className="flex min-w-0 flex-1 basis-64 items-start gap-2.5 leading-snug">
        <Info aria-hidden className="mt-px size-4 shrink-0 text-warning" />
        <span>E-mail delivery is not set up. Sign-in links and invitations are written to the server log until it is.</span>
      </span>
      <Link
        href="/admin/settings/email"
        className="ml-6.5 shrink-0 rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        Set up e-mail
      </Link>
    </div>
  );
}
