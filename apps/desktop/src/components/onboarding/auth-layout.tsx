import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { Backdrop, Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ApiRequestError, errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Full-screen centered glass card over the aurora — used by login and unlock screens. */
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
      <div
        aria-hidden
        className="bg-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_70%)]"
      />
      <div className="absolute inset-x-0 top-0 h-8" data-tauri-drag-region />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 26 }}
        className={cn("relative w-full max-w-md", className)}
      >
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="relative">
            <Logo className="size-16 animate-float drop-shadow-[0_12px_40px_rgba(139,92,246,0.45)]" />
            {badge && (
              <div className="absolute -right-2 -bottom-2 grid size-7 place-items-center rounded-full border-2 border-background bg-card text-primary shadow-md [&_svg]:size-3.5">
                {badge}
              </div>
            )}
          </div>
          <h1 className="mt-6 text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-2 max-w-sm text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="glass noise rounded-3xl p-6 shadow-2xl shadow-black/20 sm:p-7">{children}</div>
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
      className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </motion.p>
  );
}

/** Full-width gradient submit button with spinner. */
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
      className={cn("group h-11 w-full rounded-xl bg-gradient-brand text-white shadow-md shadow-glow-a/25 hover:opacity-95", className)}
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
    if (err.status === 400 || err.status === 401 || err.status === 403) return "That passphrase isn't right.";
  }
  return errorMessage(err);
}
