import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Backdrop, Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiRequestError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Full-screen hero on paper: flat logo, display heading, and a hairline card for the form — used by login and unlock screens. */
export function AuthLayout({
  badge,
  title,
  description,
  children,
  footer,
  className,
}: {
  badge?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className="relative grid min-h-full place-items-center overflow-y-auto bg-background px-4 py-12">
      <Backdrop />
      <div className="absolute inset-x-0 top-0 h-8" data-tauri-drag-region />
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }}
        className={cn("relative w-full max-w-md", className)}
      >
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="relative">
            <Logo className="size-12" />
            {badge && (
              <div className="absolute -right-2 -bottom-2 grid size-6 place-items-center rounded-md border bg-card text-foreground shadow-card [&_svg]:size-3.5">
                {badge}
              </div>
            )}
          </div>
          <h1 className="heading-display mt-7 text-[32px] sm:text-[36px]">{title}</h1>
          {description && <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        <div className="rounded-2xl border bg-card p-6 shadow-float sm:p-7">{children}</div>
        {footer && <div className="mt-6 text-center text-xs text-muted-foreground">{footer}</div>}
      </motion.div>
    </div>
  );
}

/** Horizontal shake used for wrong password feedback. */
export const shake = {
  x: [0, -10, 10, -7, 7, -3, 3, 0],
  transition: { duration: 0.45 },
};

export function FormError({ message, id }: { message: string | null; id?: string }) {
  if (!message) return null;
  return (
    <motion.p
      id={id}
      role="alert"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive"
    >
      {message}
    </motion.p>
  );
}

/** Full-width primary (anthracite) submit button with spinner. */
export function SubmitButton({
  busy,
  disabled,
  children,
  className,
  type = "submit",
  onClick,
}: {
  busy: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  return (
    <Button
      type={type}
      size="lg"
      onClick={onClick}
      disabled={busy || disabled}
      className={cn("group w-full", className)}
    >
      {busy ? <Spinner /> : null}
      {children}
      {!busy && <ArrowRight className="transition-transform group-hover:translate-x-0.5" />}
    </Button>
  );
}

/** Friendly message for a failed vault unlock. */
export function unlockError(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return "Too many attempts — wait a minute and try again.";
    // Through Godmode Cloud the computer may refuse unlocking at all; its sentence says why.
    if (err.code === "cloud_forbidden") return err.message;
    if (err.status === 400 || err.status === 401 || err.status === 403) return "That passphrase isn't right.";
  }
  return errorMessage(err);
}
