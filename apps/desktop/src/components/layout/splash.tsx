import { motion } from "motion/react";
import { Aurora, Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";

export function SplashScreen({ error }: { error?: string }) {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-background">
      <Aurora />
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative flex flex-col items-center gap-5 text-center"
      >
        <Logo className="size-16 animate-float drop-shadow-[0_10px_40px_rgba(139,92,246,0.45)]" />
        {error ? (
          <>
            <div>
              <h1 className="text-lg font-semibold">Something went wrong</h1>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </>
        ) : (
          <p className="text-shimmer text-sm font-medium">Waking up your coworker…</p>
        )}
      </motion.div>
    </div>
  );
}
