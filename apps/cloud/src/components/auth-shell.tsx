import type { ReactNode } from "react";
import Link from "next/link";
import type { CharacterMood } from "@godmode/shared";
import { Backdrop, Brand, Logo } from "@/components/brand";
import { Mascot } from "@/components/mascot";
import { AnnouncementBar, LegalLinks, type Announcement, type LegalInfo } from "@/components/shell-parts";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

/**
 * Full-screen frame for signed-out pages (sign in, verify, invite, setup claim, status pages): warm paper with the
 * dotted backdrop, the mascot above a display heading, the form in one floating card, then a footer line and the
 * legal links. Theme toggle in the corner. Viewport breakpoints are fine here (house rule 1).
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
  legal,
  announcement,
  appName,
  mascot = "idle",
  badge,
  wide = false,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** The card's content. Leave it out for a page without a card (e.g. a status message with actions in `footer`). */
  children?: ReactNode;
  /** A muted line under the card, e.g. "Only invited people can sign in." */
  footer?: ReactNode;
  legal?: LegalInfo;
  announcement?: Announcement | null;
  appName?: string;
  /** The mascot's mood, or false to show the logo instead. */
  mascot?: CharacterMood | false;
  /** A small icon chip on the logo (only with `mascot={false}`). */
  badge?: ReactNode;
  /** A wider card (max-w-lg) for pages with more content. */
  wide?: boolean;
  className?: string;
}) {
  return (
    <div className="relative flex min-h-svh flex-col bg-background">
      {announcement && announcement.text.trim() && <AnnouncementBar announcement={announcement} className="relative z-10" />}
      <Backdrop />
      <header className="relative z-10 flex items-center justify-between gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
        <Link href="/" className="min-w-0 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" aria-label="Home">
          <Brand appName={appName} />
        </Link>
        <ThemeToggle variant="icon" />
      </header>

      <main className="relative flex flex-1 items-center justify-center px-4 py-10 sm:py-14">
        <div className={cn("animate-enter w-full", wide ? "max-w-lg" : "max-w-md", className)}>
          <div className="mb-7 flex flex-col items-center text-center">
            {mascot === false ? (
              <div className="relative">
                <Logo className="size-12" />
                {badge && (
                  <div className="absolute -right-2 -bottom-2 grid size-6 place-items-center rounded-md border bg-card text-foreground shadow-card [&_svg]:size-3.5">
                    {badge}
                  </div>
                )}
              </div>
            ) : (
              <Mascot mood={mascot} size={76} />
            )}
            <h1 className="heading-display mt-6 text-[30px] sm:text-[34px]">{title}</h1>
            {description && <div className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted-foreground">{description}</div>}
          </div>
          {children && <div className="rounded-2xl border bg-card p-5 shadow-float sm:p-7">{children}</div>}
          {footer && <div className="mt-5 text-center text-[13px] leading-relaxed text-muted-foreground">{footer}</div>}
        </div>
      </main>

      {legal && (
        <footer className="relative flex justify-center px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <LegalLinks legal={legal} className="justify-center" />
        </footer>
      )}
    </div>
  );
}

/** A form-level error inside an AuthShell card (shake-free; the text is announced). */
export function AuthError({ message, id }: { message: string | null | undefined; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="animate-enter rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  );
}
