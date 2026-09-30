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
  characterPhase,
  defaultCharacter,
  MASCOT_CHARACTER,
  MASCOT_COLOR,
  renderCharacterSvg,
  type Agent,
  type AgentCharacter,
  type CharacterMood,
} from "@godmode/shared";
import { LiveDot } from "./ui";
import { useColors, useIsDark } from "@/lib/theme";

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
      .replace(/font-family="[^"]*"/, 'font-family="System"');
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

export function agentCharacter(agent: CharacterAgent): AgentCharacter {
  // A core from before characters doesn't send one: the agent gets the look a newer core would give it.
  return agent.character ?? (agent.isDefault ? MASCOT_CHARACTER : defaultCharacter(agent.id));
}

export function agentMood(agent: Pick<Agent, "enabled" | "status">, running?: boolean): CharacterMood {
  if (running) return "working";
  if (!agent.enabled) return "sleeping";
  return agent.status === "error" ? "error" : "idle";
}

/** A character, alive: it breathes, blinks, bobs while working and hops when happy. Under Reduce Motion it holds still. */
export const Character = memo(function Character({
  character,
  color,
  mood = "idle",
  size = 40,
  seed,
  style,
}: {
  character: AgentCharacter;
  color: string;
  mood?: CharacterMood;
  size?: number;
  /** Staggers the animations so a list of characters doesn't breathe and blink in unison. */
  seed?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReducedMotion();
  const outline = useIsDark() ? OUTLINE.dark : OUTLINE.light;
  const faceScale = size <= 28 ? 1.25 : 1;
  const open = drawing(character, color, mood, faceScale);
  const blinks = !reduceMotion && canBlink(character, mood);
  const closed = blinks ? drawing({ ...character, eyes: "lines" }, color, mood, faceScale) : null;
  const phase = characterPhase(seed) * 1000;

  const breath = useSharedValue(0);
  const move = useSharedValue(0);
  const blink = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    const slow = mood === "sleeping";
    breath.value = withDelay(
      phase % 1600,
      withRepeat(withTiming(1, { duration: slow ? 2600 : 1900, easing: Easing.inOut(Easing.sin) }), -1, true),
    );
    if (mood === "working") {
      move.value = withRepeat(withTiming(1, { duration: 420, easing: Easing.inOut(Easing.quad) }), -1, true);
    } else if (mood === "happy") {
      const hop = withSequence(
        withTiming(1, { duration: 170, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 230, easing: Easing.in(Easing.quad) }),
      );
      move.value = withRepeat(withSequence(hop, hop, withDelay(1800, withTiming(0, { duration: 0 }))), -1);
    } else if (mood === "thinking" || mood === "attention") {
      move.value = withRepeat(withTiming(1, { duration: mood === "attention" ? 700 : 1600, easing: Easing.inOut(Easing.sin) }), -1, true);
    }
    return () => {
      cancelAnimation(breath);
      cancelAnimation(move);
      breath.value = 0;
      move.value = 0;
    };
  }, [mood, reduceMotion, phase, breath, move]);

  useEffect(() => {
    if (!blinks) return;
    blink.value = withDelay(
      phase,
      withRepeat(
        withSequence(withDelay(3400, withTiming(1, { duration: 0 })), withDelay(120, withTiming(0, { duration: 0 }))),
        -1,
      ),
    );
    return () => {
      cancelAnimation(blink);
      blink.value = 0;
    };
  }, [blinks, phase, blink]);

  const body = useAnimatedStyle(() => {
    const b = breath.value;
    const m = move.value;
    const lift = mood === "working" ? m * size * 0.045 : mood === "happy" ? m * size * 0.14 : 0;
    const tilt = mood === "thinking" ? (m - 0.5) * 6 : mood === "attention" ? (m - 0.5) * 8 : 0;
    const squash = mood === "happy" ? m * 0.04 : 0;
    return {
      transform: [
        { translateY: -lift },
        { rotate: `${tilt}deg` },
        { scaleX: 1 - b * 0.015 - squash },
        { scaleY: 1 + b * 0.03 + squash },
      ],
    };
  });
  const openStyle = useAnimatedStyle(() => ({ opacity: 1 - blink.value }));
  const closedStyle = useAnimatedStyle(() => ({ opacity: blink.value }));

  const svgSize = { width: ((100 + PAD.left + PAD.right) * size) / 100, height: ((100 + PAD.top + PAD.bottom) * size) / 100 };
  const box: ViewStyle = { position: "absolute", left: (-PAD.left * size) / 100, top: (-PAD.top * size) / 100, ...svgSize };
  const svgProps = { ...svgSize, color: outline };

  return (
    <View style={[{ width: size, height: size }, style]} pointerEvents="none">
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
 * An agent's character. Running → working (it bobs; under Reduce Motion a live dot says so instead), paused → asleep,
 * last run failed → a worried face. Without an agent (still loading, or deleted) it's Godmode's mascot.
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
  return (
    <View style={style}>
      {agent ? (
        <Character character={agentCharacter(agent)} color={agent.color} mood={mood ?? agentMood(agent, running)} size={size} seed={agent.id} />
      ) : (
        <Character character={MASCOT_CHARACTER} color={MASCOT_COLOR} mood={mood ?? (running ? "working" : "idle")} size={size} />
      )}
      {running && reduceMotion ? (
        <View style={{ position: "absolute", right: -2, bottom: -2, borderWidth: 2, borderRadius: 8, borderColor: c.background }}>
          <LiveDot size={8} />
        </View>
      ) : null}
    </View>
  );
}
