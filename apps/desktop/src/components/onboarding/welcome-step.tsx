import type { FormEvent } from "react";
import { motion } from "motion/react";
import { Bot, KeyRound, Workflow } from "lucide-react";
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
    icon: <Workflow />,
    title: "Keeps going",
    body: "Automations start work on a schedule or when something happens, agents delegate to each other and only ping you when they need you.",
  },
];

export function WelcomeStep({ userName, onUserName, onNext }: { userName: string; onUserName: (v: string) => void; onNext: () => void }) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNext();
  };
  return (
    <form onSubmit={submit}>
      <div className="mb-8 flex flex-col items-start">
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}>
          <Logo className="size-11" />
        </motion.div>
        <p className="eyebrow mt-7">Setup · about a minute</p>
        <h1 className="heading-display mt-3 text-[40px] sm:text-[48px]">
          Welcome to Godmode.
          <span className="block text-foreground/35">Your AI coworker, set up in a minute.</span>
        </h1>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-muted-foreground">
          Godmode turns Claude into a teammate that can sign in, browse and get real work done across your tools — while you stay in
          control of every secret.
        </p>
      </div>

      <StepCard>
        <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.06 }}
              className="bg-paper-2 p-4"
            >
              <div className="mb-3 grid size-8 place-items-center rounded-lg border bg-card text-foreground shadow-card [&_svg]:size-4">{f.icon}</div>
              <p className="text-sm font-medium tracking-[-0.01em]">{f.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{f.body}</p>
            </motion.div>
          ))}
        </div>

        <div className="mt-7 space-y-2">
          <Label htmlFor="onboarding-name">What should your coworker call you?</Label>
          <Input
            id="onboarding-name"
            autoFocus
            autoComplete="given-name"
            value={userName}
            onChange={(e) => onUserName(e.target.value)}
            placeholder="Your first name"
            className="h-10 text-[15px]"
            maxLength={60}
          />
        </div>

        <StepFooter>
          <SubmitButton busy={false} className="w-auto px-6">
            {userName.trim() ? `Let's go, ${userName.trim().split(/\s+/)[0]}` : "Get started"}
          </SubmitButton>
        </StepFooter>
      </StepCard>
    </form>
  );
}
