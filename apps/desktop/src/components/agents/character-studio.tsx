import { useEffect, useRef, useState } from "react";
import { Dices } from "lucide-react";
import type { AgentCharacter, CharacterMood } from "@godmode/shared";
import {
  AGENT_COLORS,
  CHARACTER_BODIES,
  CHARACTER_EYES,
  CHARACTER_FACES,
  CHARACTER_LABELS,
  CHARACTER_MOUTHS,
  CHARACTER_NECKS,
  CHARACTER_TOPS,
  PERSONALITY_PRESETS,
  characterGreeting,
  personalityPreset,
  randomCharacter,
} from "@godmode/shared";
import { Character, SpeechBubble } from "@/components/character";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Part = keyof AgentCharacter;

const PARTS: { part: Part; label: string; options: readonly string[]; zoom?: number }[] = [
  { part: "body", label: "Body", options: CHARACTER_BODIES },
  { part: "eyes", label: "Eyes", options: CHARACTER_EYES, zoom: 1.3 },
  { part: "mouth", label: "Mouth", options: CHARACTER_MOUTHS, zoom: 1.3 },
  { part: "top", label: "Hat", options: CHARACTER_TOPS },
  { part: "face", label: "Face", options: CHARACTER_FACES, zoom: 1.15 },
  { part: "neck", label: "Neck", options: CHARACTER_NECKS },
];

/** Moods the preview runs through while hovered — a quick look at how the agent will act. */
const SHOWREEL: CharacterMood[] = ["happy", "thinking", "working", "attention", "sleeping"];

/** A fresh look for a new agent: random character and colour. */
export function randomLook(): { character: AgentCharacter; color: string } {
  return { character: randomCharacter(), color: AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)]! };
}

/** The live preview: the character follows the pointer, says hello in its voice and hops when it changes. */
export function CharacterStage({
  character,
  color,
  name,
  personality,
  human,
  onSurprise,
  className,
}: {
  character: AgentCharacter;
  color: string;
  name: string;
  personality: string;
  human?: string | null;
  onSurprise?: () => void;
  className?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [reel, setReel] = useState(0);
  const [cheer, setCheer] = useState(false);
  const look = `${JSON.stringify(character)}:${color}`;
  const firstLook = useRef(look);

  // A little hop whenever the look changes (not on first render).
  useEffect(() => {
    if (look === firstLook.current) return;
    firstLook.current = look;
    setCheer(true);
    const t = setTimeout(() => setCheer(false), 1100);
    return () => clearTimeout(t);
  }, [look]);

  useEffect(() => {
    if (!hovered) return;
    setReel(0);
    const t = setInterval(() => setReel((i) => (i + 1) % SHOWREEL.length), 1400);
    return () => clearInterval(t);
  }, [hovered]);

  const mood: CharacterMood = cheer ? "happy" : hovered ? SHOWREEL[reel]! : "idle";
  const greeting = characterGreeting({ name: name.trim() || "Your agent", personality, human, seed: "studio" });

  return (
    <div
      className={cn("relative flex flex-col items-center justify-end overflow-hidden rounded-xl border bg-paper-2 bg-dots px-4 pt-4 pb-3", className)}
    >
      <SpeechBubble key={personality} tail="bottom" delay={0} className="max-w-60 text-center text-[13px] text-balance">
        {greeting}
      </SpeechBubble>
      <div onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)} className="mt-3">
        <Character character={character} color={color} mood={mood} size={112} follow title={name.trim() || undefined} />
      </div>
      {onSurprise && (
        <Button type="button" variant="outline" size="xs" onClick={onSurprise} className="mt-3 bg-card">
          <Dices /> Surprise me
        </Button>
      )}
    </div>
  );
}

/** Body, eyes, mouth, hat, face and neck — every option is a thumbnail of this character wearing it. */
export function CharacterPartsPicker({
  character,
  color,
  onChange,
}: {
  character: AgentCharacter;
  color: string;
  onChange: (character: AgentCharacter) => void;
}) {
  return (
    <Tabs defaultValue="body">
      <TabsList variant="line" className="w-full justify-start overflow-x-auto">
        {PARTS.map((p) => (
          <TabsTrigger key={p.part} value={p.part} className="flex-none px-2.5">
            {p.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {PARTS.map(({ part, label, options, zoom }) => (
        <TabsContent key={part} value={part} className="pt-2">
          <div role="radiogroup" aria-label={label} className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-2">
            {options.map((option) => {
              const selected = character[part] === option;
              const optionLabel = (CHARACTER_LABELS[part] as Record<string, string>)[option] ?? option;
              return (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => onChange({ ...character, [part]: option })}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-lg border bg-card px-1 pt-2 pb-1.5 text-[11px] text-muted-foreground transition hover:border-foreground/20 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
                    selected && "border-foreground/40 bg-secondary text-foreground ring-1 ring-foreground/25 ring-inset",
                  )}
                >
                  <Character character={{ ...character, [part]: option }} color={color} size={44} faceScale={zoom} still />
                  <span className="max-w-full truncate">{optionLabel}</span>
                </button>
              );
            })}
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

/** How the agent talks: a preset voice, none, or the human's own words. Stored as the preset id or the custom text. */
export function PersonalityPicker({ value, onChange }: { value: string; onChange: (personality: string) => void }) {
  const isCustom = !!value.trim() && !personalityPreset(value);
  const [custom, setCustom] = useState(isCustom);
  const lastCustom = useRef(isCustom ? value : "");
  if (isCustom) lastCustom.current = value;
  const customOn = custom || isCustom;

  const card = (selected: boolean) =>
    cn(
      "flex flex-col items-start rounded-lg border bg-card px-3 py-2.5 text-left transition hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
      selected && "border-foreground/40 bg-secondary ring-1 ring-foreground/25 ring-inset",
    );

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="Personality" className="grid grid-cols-1 gap-2 @md:grid-cols-2 @3xl:grid-cols-3">
        {PERSONALITY_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={!customOn && value === p.id}
            onClick={() => {
              setCustom(false);
              onChange(p.id);
            }}
            className={card(!customOn && value === p.id)}
          >
            <span className="text-sm font-medium">{p.label}</span>
            <span className="text-xs text-muted-foreground">{p.blurb}</span>
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={!customOn && !value.trim()}
          onClick={() => {
            setCustom(false);
            onChange("");
          }}
          className={card(!customOn && !value.trim())}
        >
          <span className="text-sm font-medium">Neutral</span>
          <span className="text-xs text-muted-foreground">No particular voice — plain and helpful</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={customOn}
          onClick={() => {
            setCustom(true);
            onChange(lastCustom.current);
          }}
          className={card(customOn)}
        >
          <span className="text-sm font-medium">Custom…</span>
          <span className="text-xs text-muted-foreground">Describe the voice in your own words</span>
        </button>
      </div>
      {customOn && (
        <Textarea
          autoFocus={!isCustom}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Warm and a bit nerdy. Explains things with food metaphors, keeps replies short and always ends with the next step."
          aria-label="Custom personality"
          maxLength={600}
          className="min-h-20 resize-y text-sm"
        />
      )}
    </div>
  );
}
