"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Everything a page needs around it: theme, tooltips, toasts. Motion follows the OS "reduce motion" setting. */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <MotionConfig reducedMotion="user">
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster richColors position="bottom-right" closeButton={false} />
        </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
