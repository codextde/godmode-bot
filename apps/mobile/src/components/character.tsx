import { useQuery } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { memo, useEffect } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { parse, SvgAst, type JsxAST } from "react-native-svg";
import {
  agentPresence,
  characterPhase,
  defaultCharacter,
  MASCOT_CHARACTER,
  MASCOT_COLOR,
  renderCharacterSvg,
  type Agent,
  type AgentCharacter,
  type AgentPresence,
  type CharacterMood,
} from "@godmode/shared";
import { LiveDot } from "./ui";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { qk } from "@/lib/query";
import { fonts, useColors, useIsDark } from "@/lib/theme";

/**
 * The drawing can reach past its 100×100 box (hats, antennas, sparkles, z's). SVG views clip to their bounds, so the
 * markup is drawn into a slightly bigger box that hangs over the avatar's own box, at the same scale.
 */
const PAD = { left: 6, top: 14, right: 6, bottom: 2 };
const VIEWBOX = `viewBox="${-PAD.left} ${-PAD.top} ${100 + PAD.left + PAD.right} ${100 + PAD.top + PAD.bottom}"`;

/** Parsed drawings, shared by every avatar with the same look (list rows re-mount a lot). */
const drawings = new Map<string, JsxAST | null>();

/** What `currentColor` resolves to: the parts that stick out past the body (hats, sparkles, z's) must read on the background. */
const OUTLINE = { light: "#24211d", dark: "#ece8e0" };

function drawing(character: AgentCharacter, color: string, mood: CharacterMood, faceScale: number): JsxAST | null {
  const key = `${character.body}|${character.eyes}|${character.mouth}|${character.top}|${character.face}|${character.neck}|${color}|${mood}|${faceScale}`;
  let ast = drawings.get(key);
  if (ast === undefined) {
    const svg = renderCharacterSvg(character, { color, mood, faceScale })
      .replace('viewBox="0 0 100 100"', VIEWBOX)
      .replace(/font-family="[^"]*"(\s*font-weight="[^"]*")?/, `font-family="${fonts.semibold}"`);
    try {
      ast = parse(svg);
    } catch {
      ast = null;
    }
    if (drawings.size > 300) drawings.clear();
    drawings.set(key, ast);
  }
  return ast;
}

/** Moods whose eyes are open dots or rings and can blink (the others are already closed, arcs, crosses or hidden). */
function canBlink(character: AgentCharacter, mood: CharacterMood): boolean {
  if (character.face === "shades") return false;
  if (mood === "idle") return character.eyes === "dots" || character.eyes === "wide" || character.eyes === "wink";
  return mood === "working" || mood === "thinking" ? character.eyes !== "lines" : false;
}

type CharacterAgent = Pick<Agent, "id" | "color" | "enabled" | "status"> & { isDefault?: boolean; character?: AgentCharacter | null };

/** The agent's look; a core from before characters sends none, so it gets the stable look its id gives it, like on the desktop. */
export function agentCharacter(agent: CharacterAgent): AgentCharacter {
  return agent.character ?? defaultCharacter(agent.id);
}

/** The desktop's avatar mood: working while a run is live, asleep while switched off. */
export function agentMood(agent: Pick<Agent, "enabled" | "status">, running?: boolean): CharacterMood {
  if (running) return "working";
  return agent.enabled ? "idle" : "sleeping";
}

type PresenceAgent = Pick<Agent, "id" | "enabled" | "status" | "pausedRuns" | "openQuestions" | "failedRunId">;

/** What the agent is doing right now, from the shared rules the desktop uses, a missing login included. */
export function useAgentPresence(agent: PresenceAgent, live: { running?: number; queued?: number } = {}): AgentPresence {
  const { data: needsLogin = false } = useQuery({
    queryKey: qk.missingLogins,
    queryFn: api.missingLogins.open,
    select: (list) => list.some((m) => m.agentId === agent.id),
  });
  return agentPresence(agent, { ...live, needsLogin });
}

/** The character mood outside a chat, like the desktop's: busy while it works, waving while it needs the human. */
export function moodOf(presence: AgentPresence): CharacterMood {
  switch (presence.state) {
    case "working":
      return "working";
    case "off":
      return "sleeping";
    case "waiting":
      return "attention";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

/** What the agent is doing right now in words, the desktop's (presenceLabel) in the app language. */
export function presenceText(p: AgentPresence): string {
  switch (p.state) {
    case "off":
      return t("components:character.presence.off");
    case "working":
      return p.running > 1 ? t("components:character.presence.workingInChats", { count: p.running }) : t("components:character.presence.working");
    case "waiting":
      if (!p.waiting) return t("components:character.presence.needsLogin");
      return p.waiting > 1 ? t("components:character.presence.needsYouQuestions", { count: p.waiting }) : t("components:character.presence.needsAnswer");
    case "failed":
      return t("components:character.presence.failed");
    case "paused":
      return p.paused > 1 ? t("components:character.presence.pausedChats", { count: p.paused }) : t("components:character.presence.paused");
    case "queued":
      return p.queued > 1 ? t("components:character.presence.queuedCount", { count: p.queued }) : t("components:character.presence.queued");
    default:
      return t("components:character.presence.idle");
  }
}

export function useAgentMood(agent: PresenceAgent, live: { running?: number; queued?: number } = {}): CharacterMood {
  return moodOf(useAgentPresence(agent, live));
}

/** Idle breathing and blinking only from this size up: a list of small avatars that all breathe keeps the phone busy. */
const LIVELY_SIZE = 60;

const ease = Easing.inOut(Easing.sin);
const instant = { duration: 0 };

/**
 * A character, alive, with the desktop's timings (packages/shared/src/character.css): it breathes and blinks, bobs while
 * working, hops when happy, wiggles when it needs you and shudders after an error. Small ones skip the idle breathing but
 * keep their mood, and every one holds still while its screen is behind another (tabs stay mounted) or under Reduce Motion.
 */
export const Character = memo(function Character({
  character,
  color,
  mood = "idle",
  size = 40,
  seed,
  faceScale: scaleOverride,
  style,
}: {
  character: AgentCharacter;
  color: string;
  mood?: CharacterMood;
  size?: number;
  faceScale?: number;
  /** Staggers the animations so a list of characters doesn't breathe and blink in unison. */
  seed?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const focused = useIsFocused();
  const still = reduceMotion || !focused;
  const lively = size >= LIVELY_SIZE;
  const outline = useIsDark() ? OUTLINE.dark : OUTLINE.light;
  const faceScale = scaleOverride ?? (size <= 28 ? 1.25 : size <= 44 ? 1.1 : 1);
  const open = drawing(character, color, mood, faceScale);
  const blinks = lively && !still && canBlink(character, mood);
  const closed = blinks ? drawing({ ...character, eyes: "lines" }, color, mood, faceScale) : null;
  const phase = characterPhase(seed) * 1000;

  const breath = useSharedValue(0);
  const y = useSharedValue(0);
  const x = useSharedValue(0);
  const r = useSharedValue(0);
  const sq = useSharedValue(0);
  const blink = useSharedValue(0);

  useEffect(() => {
    if (still) return;
    const stagger = (cycle: number, anim: number) => withDelay(phase % cycle, anim);
    if (lively && mood !== "happy" && mood !== "attention") {
      const half = mood === "sleeping" ? 3000 : 2100;
      breath.value = stagger(half * 2, withRepeat(withTiming(1, { duration: half, easing: ease }), -1, true));
    }
    if (mood === "working") {
      y.value = stagger(900, withRepeat(withTiming(-1.5, { duration: 450, easing: ease }), -1, true));
      sq.value = stagger(900, withRepeat(withTiming(-0.01, { duration: 450, easing: ease }), -1, true));
    } else if (mood === "happy") {
      const curve = Easing.bezier(0.3, 0, 0.3, 1);
      y.value = stagger(
        1600,
        withRepeat(withSequence(withDelay(160, withTiming(-9, { duration: 288, easing: curve })), withTiming(0, { duration: 288, easing: curve }), withDelay(864, withTiming(0, instant))), -1),
      );
      sq.value = stagger(
        1600,
        withRepeat(
          withSequence(
            withTiming(0.07, { duration: 160, easing: curve }),
            withTiming(-0.045, { duration: 288, easing: curve }),
            withTiming(0.045, { duration: 288, easing: curve }),
            withTiming(0, { duration: 224, easing: curve }),
            withDelay(640, withTiming(0, instant)),
          ),
          -1,
        ),
      );
    } else if (mood === "attention") {
      r.value = stagger(
        2400,
        withRepeat(
          withSequence(
            withDelay(1320, withTiming(-6, { duration: 168, easing: ease })),
            withTiming(5, { duration: 192, easing: ease }),
            withTiming(-3, { duration: 192, easing: ease }),
            withTiming(1, { duration: 192, easing: ease }),
            withTiming(0, { duration: 336, easing: ease }),
          ),
          -1,
        ),
      );
    } else if (mood === "error") {
      x.value = stagger(
        3000,
        withRepeat(
          withSequence(
            withTiming(-1.5, { duration: 90 }),
            withTiming(1.5, { duration: 90 }),
            withTiming(-1, { duration: 90 }),
            withTiming(0, { duration: 90 }),
            withDelay(2640, withTiming(0, instant)),
          ),
          -1,
        ),
      );
    } else if (mood === "thinking") {
      r.value = stagger(3200, withRepeat(withSequence(withTiming(2.5, { duration: 1600, easing: ease }), withTiming(-2, { duration: 1600, easing: ease })), -1));
    }
    return () => {
      for (const v of [breath, y, x, r, sq]) {
        cancelAnimation(v);
        v.value = 0;
      }
    };
  }, [mood, still, lively, phase, breath, y, x, r, sq]);

  useEffect(() => {
    if (!blinks) return;
    blink.value = withDelay(
      (phase * 1.7) % 5200,
      withRepeat(withSequence(withDelay(4900, withTiming(1, instant)), withDelay(150, withTiming(0, instant))), -1),
    );
    return () => {
      cancelAnimation(blink);
      blink.value = 0;
    };
  }, [blinks, phase, blink]);

  const unit = size / 100;
  const body = useAnimatedStyle(() => {
    const b = breath.value;
    return {
      transform: [
        { translateX: x.value * unit },
        { translateY: y.value * unit },
        { rotate: `${r.value}deg` },
        { scaleX: 1 + b * 0.018 + sq.value },
        { scaleY: 1 - b * 0.015 - sq.value },
      ],
    };
  });
  const openStyle = useAnimatedStyle(() => ({ opacity: 1 - blink.value }));
  const closedStyle = useAnimatedStyle(() => ({ opacity: blink.value }));

  const svgSize = { width: ((100 + PAD.left + PAD.right) * size) / 100, height: ((100 + PAD.top + PAD.bottom) * size) / 100 };
  const box: ViewStyle = { position: "absolute", left: (-PAD.left * size) / 100, top: (-PAD.top * size) / 100, ...svgSize };
  const svgProps = { ...svgSize, color: outline };

  return (
    <View style={[{ width: size, height: size }, mood === "sleeping" && { opacity: 0.8 }, style]} pointerEvents="none">
      <Animated.View style={[{ width: size, height: size, transformOrigin: "50% 94%" }, body]}>
        <Animated.View style={[box, openStyle]}>
          <SvgAst ast={open} override={svgProps} />
        </Animated.View>
        {closed ? (
          <Animated.View style={[box, closedStyle]}>
            <SvgAst ast={closed} override={svgProps} />
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  );
});

/**
 * An agent's character. Running → working (it bobs; under Reduce Motion a live dot says so instead), switched off →
 * asleep; `mood` overrides both (useAgentMood for an agent's own row or page). Without an agent (still loading, or
 * deleted) it's Godmode's mascot.
 */
export function CharacterAvatar({
  agent,
  size = 40,
  mood,
  running,
  style,
}: {
  agent: CharacterAgent | undefined;
  size?: number;
  mood?: CharacterMood;
  running?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const reduceMotion = useReducedMotion();
  const working = running || mood === "working";
  return (
    <View style={style}>
      {agent ? (
        <Character character={agentCharacter(agent)} color={agent.color} mood={mood ?? agentMood(agent, running)} size={size} seed={agent.id} />
      ) : (
        <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} mood={mood ?? (running ? "working" : "idle")} size={size} />
      )}
      {working && reduceMotion ? (
        <View style={{ position: "absolute", right: -2, bottom: -2, borderWidth: 2, borderRadius: 8, borderColor: c.background }}>
          <LiveDot size={8} />
        </View>
      ) : null}
    </View>
  );
}
