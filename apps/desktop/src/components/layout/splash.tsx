import { motion } from "motion/react";
import { Backdrop, Logo } from "@/components/brand";
import { Orb } from "@/components/aicss/Orb";
import { Button } from "@/components/ui/button";

export function SplashScreen({ error }: { error?: string }) {
  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-background">
      <Backdrop />
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative flex flex-col items-center gap-6 text-center"
      >
        <Logo className="size-12" />
        {error ? (
          <>
            <div>
              <h1 className="text-lg font-medium tracking-[-0.02em]">Something went wrong</h1>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">{error}</p>
            </div>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-full border bg-card py-1.5 pr-3.5 pl-2.5 shadow-card" role="status">
            <span aria-hidden className="inline-flex">
              <Orb variant="S3" size={16} label="Starting Godmode…" />
            </span>
            <span className="text-shimmer text-[13px] font-medium">Starting Godmode…</span>
          </span>
        )}
      </motion.div>
    </div>
  );
}
