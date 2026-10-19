import { useState } from "react";
import { useNavigate } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, CircleCheck, Globe, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "godmode.integrations.noConnectorsNote";

const STEPS = [
  { icon: Globe, label: "Opens the site" },
  { icon: KeyRound, label: "Fills your login" },
  { icon: ShieldCheck, label: "Adds the 2FA code" },
  { icon: CircleCheck, label: "Signed in as you" },
];

function dismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Integrations are optional: agents sign in to websites with vault logins and 2FA, so apps need no MCP connector. */
export function NoConnectorsNote() {
  const navigate = useNavigate();
  const [hidden, setHidden] = useState(dismissed);

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setHidden(true);
  };

  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.section
          key="note"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.2 }}
          className="mb-6 overflow-hidden rounded-xl border border-brand/25 bg-card shadow-card"
          aria-label="No connectors needed"
        >
          <div className="grid grid-cols-1 gap-6 p-5 @4xl:grid-cols-[1fr_minmax(0,280px)] @4xl:items-center @2xl:p-6">
            <div className="flex items-start gap-4">
              <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-brand/25 bg-brand-soft text-brand-strong">
                <ShieldCheck className="size-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-[15px] leading-snug font-medium tracking-[-0.01em]">Your apps don't need a connector</h2>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                  Godmode signs in to websites the way you do: with the username, password and 2FA code saved in your Vault. It types them
                  into the login page itself, so the AI never sees them. Gmail, your CRM, a supplier portal: if it opens in a browser, your
                  agents can use it, without an MCP connector.
                </p>
                <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  Connect an app here only when an automation should start the moment something arrives, like a new email, or for an API
                  without a website.
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => navigate("/vault/logins")}>
                    Save a login <ArrowRight />
                  </Button>
                  <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={dismiss}>
                    Got it
                  </Button>
                </div>
              </div>
            </div>
            <ol className="hidden rounded-lg border bg-paper-2 p-3 @4xl:block" aria-hidden>
              {STEPS.map((s, i) => (
                <motion.li
                  key={s.label}
                  initial={{ opacity: 0, x: 6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.08 + i * 0.06, duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                  className="relative flex items-center gap-2.5 py-1.5 text-xs"
                >
                  <span
                    className={
                      i === STEPS.length - 1
                        ? "grid size-6 place-items-center rounded-md border border-brand/25 bg-brand-soft text-brand-strong"
                        : "grid size-6 place-items-center rounded-md border bg-card text-foreground"
                    }
                  >
                    <s.icon className="size-3.5" />
                  </span>
                  <span className={i === STEPS.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"}>{s.label}</span>
                </motion.li>
              ))}
            </ol>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
