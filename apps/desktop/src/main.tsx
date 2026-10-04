import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";
import { VaultGrantDialog } from "@/components/vault/grant";
import { installExternalLinks, installDropGuard } from "@/lib/desktop";
import { installErrorReporting, reactRootErrorHandlers, reportRequestError } from "@/lib/diagnostics";
import "./index.css";
import { App } from "./App";

installErrorReporting();
installExternalLinks();
installDropGuard();

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
        return count < 2;
      },
    },
  },
});

createRoot(document.getElementById("root")!, reactRootErrorHandlers).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={250}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
          <Toaster richColors position="bottom-right" />
          <VaultGrantDialog />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
