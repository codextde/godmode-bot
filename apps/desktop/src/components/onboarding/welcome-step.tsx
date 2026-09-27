import type { FormEvent } from "react";
import { motion } from "motion/react";
import { Bot, CalendarClock, KeyRound } from "lucide-react";
import { Logo } from "@/components/brand";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "./auth-layout";
import { StepCard, StepFooter } from "./step-kit";

const FEATURES = [
  {
    icon: <Bot />,
    title: "Works like a teammate",
    body: "Claude Code runs on your machine with its own memory, tools and a real browser.",
  },
  {
    icon: <KeyRound />,
    title: "Logs in for you",
    body: "Passwords and 2FA codes live in an encrypted vault. Agents use them without ever seeing them.",
  },
  {
    icon: <CalendarClock />,
    title: "Keeps going",
    body: "Routines run on a schedule, agents delegate to each other and only ping you when they need you.",
  },
];

export function WelcomeStep({ userName, onUserName, onNext }: { userName: string; onUserName: (v: string) => void; onNext: () => void }) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNext();
  };
  return (
    <StepCard>
      <form onSubmit={submit}>
        <div className="flex flex-col items-start">
          <motion.div initial={{ scale: 0.6, opacity: 0, rotate: -12 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 220, damping: 16 }}>
            <Logo className="size-14 drop-shadow-[0_12px_40px_rgba(139,92,246,0.5)]" />
          </motion.div>
          <h1 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">
            Meet your <span className="text-gradient">AI coworker</span>
          </h1>
          <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
            Godmode turns Claude into a teammate that can sign in, browse and get real work done across your tools — while you stay in
            control of every secret.
          </p>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 + i * 0.08 }}
              className="rounded-2xl border bg-card/60 p-4"
            >
              <div className="mb-3 grid size-9 place-items-center rounded-xl bg-primary/10 text-primary [&_svg]:size-[18px]">{f.icon}</div>
              <p className="text-sm font-medium">{f.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
            </motion.div>
          ))}
        </div>

        <div className="mt-8 space-y-2">
          <Label htmlFor="onboarding-name">What should your coworker call you?</Label>
          <Input
            id="onboarding-name"
            autoFocus
            autoComplete="given-name"
            value={userName}
            onChange={(e) => onUserName(e.target.value)}
            placeholder="Your first name"
            className="h-11 text-base"
            maxLength={60}
          />
        </div>

        <StepFooter>
          <SubmitButton busy={false} className="w-auto px-6">
            {userName.trim() ? `Let's go, ${userName.trim().split(/\s+/)[0]}` : "Get started"}
          </SubmitButton>
        </StepFooter>
      </form>
    </StepCard>
  );
}
