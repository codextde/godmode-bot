import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { VaultGrantDialog } from "@/components/vault/grant";
import { MacPermissionsGuide } from "@/components/permissions/mac-permissions";
import { isCloudError } from "@/lib/api";
import { cloudContext } from "@/lib/core";
import { installExternalLinks, installDropGuard } from "@/lib/desktop";
import { installErrorReporting, reactRootErrorHandlers, reportRequestError } from "@/lib/diagnostics";
import { startMotionRest } from "@/lib/motion-rest";
import "./index.css";
import { App } from "./App";

installErrorReporting();
installExternalLinks();
installDropGuard();
startMotionRest();

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (err, query) => reportRequestError(err, query.queryKey.slice(0, 2).join(".")) }),
  mutationCache: new MutationCache({ onError: (err) => reportRequestError(err, "mutation") }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        const status = (err as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        // The cloud's own answers (computer offline, link lost) don't change by asking again right away.
        if (isCloudError(err)) return false;
        return count < 2;
      },
    },
  },
});

createRoot(document.getElementById("root")!, reactRootErrorHandlers).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <TooltipProvider delayDuration={250}>
            <BrowserRouter basename={cloudContext?.base}>
              <App />
            </BrowserRouter>
            <Toaster richColors position="bottom-right" />
            <VaultGrantDialog />
            <MacPermissionsGuide />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
