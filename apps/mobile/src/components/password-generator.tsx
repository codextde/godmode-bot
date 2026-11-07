import { Host, Slider } from "@expo/ui";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn } from "react-native-reanimated";
import { Group, SwitchRow } from "./form";
import { CopyButton, IconButton } from "./secret-parts";
import { Button, Row, T } from "./ui";
import { errorText } from "@/lib/api";
import { useAppActive } from "@/lib/app-active";
import { DEFAULT_GENERATOR, generatePassword, loadGeneratorOptions, MAX_LENGTH, MIN_LENGTH, passwordStrength, saveGeneratorOptions, type GeneratorOptions } from "@/lib/password";
import { copySecret } from "@/lib/secrets";
import { fonts, space, useColors, type Colors } from "@/lib/theme";

const LABELS = ["strength.tooWeak", "strength.weak", "strength.fair", "strength.strong", "strength.excellent"] as const;

function scoreColor(c: Colors, score: number) {
  return score <= 1 ? c.danger : score === 2 ? c.warning : c.success;
}

/** Five segments and a word for how hard a password is to guess, like the desktop's meter. */
export function StrengthBar({ password, userInputs }: { password: string; userInputs?: string[] }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  const score = passwordStrength(password, userInputs);
  const color = scoreColor(c, score);
  return (
    <View accessible accessibilityLabel={`${t("strength.label")}: ${t(LABELS[score])}`} style={styles.strength}>
      <Row style={{ gap: 4, flex: 1 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View key={i} style={[styles.segment, { backgroundColor: i <= score ? color : c.sunken }]} />
        ))}
      </Row>
      <T variant="caption" color={color} style={styles.strengthLabel}>
        {t(LABELS[score])}
      </T>
    </View>
  );
}

/**
 * The desktop's generator as a panel under the password field: a strong password with the chosen length, numbers and
 * symbols, made again on every change; "Use this password" puts it in the field.
 */
export function PasswordGenerator({ onUse }: { onUse: (password: string) => void }) {
  const c = useColors();
  const { t } = useTranslation(["vault", "common"]);
  const [opts, setOpts] = useState<GeneratorOptions | null>(null);
  const [round, setRound] = useState(0);
  // The last answer and what it was made for: only a password for the current options can be used.
  const want = opts ? `${opts.length}|${opts.numbers}|${opts.symbols}|${round}` : "";
  const [made, setMade] = useState<{ key: string; password: string | null; error: string | null }>({ key: "", password: null, error: null });
  const [shown, setShown] = useState("");
  const current = made.key === want;
  const busy = !!opts && !current;
  const error = current ? made.error : null;
  const password = current ? (made.password ?? "") : "";
  const active = useAppActive();

  useEffect(() => {
    let live = true;
    void loadGeneratorOptions().then((saved) => live && setOpts(saved));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!opts) return;
    let live = true;
    const timer = setTimeout(() => {
      saveGeneratorOptions(opts);
      generatePassword(opts).then(
        (next) => {
          if (!live) return;
          setShown(next);
          setMade({ key: want, password: next, error: null });
        },
        (err: unknown) => {
          if (!live) return;
          setMade({ key: want, password: null, error: errorText(err) });
        },
      );
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [opts, want]);

  const set = (patch: Partial<GeneratorOptions>) => setOpts((o) => ({ ...(o ?? DEFAULT_GENERATOR), ...patch }));
  const length = opts?.length ?? DEFAULT_GENERATOR.length;

  return (
    <Animated.View entering={FadeIn.duration(180)} style={{ gap: space.md }}>
      <Group>
        <View style={styles.block}>
          <Row style={{ gap: space.md, alignItems: "flex-start" }}>
            <View style={{ flex: 1, minHeight: 44, justifyContent: "center" }}>
              {error ? (
                <T variant="footnote" color={c.danger}>
                  {error}
                </T>
              ) : shown ? (
                <T selectable={active} style={[styles.password, { color: c.text, opacity: busy ? 0.45 : 1 }]}>
                  {active ? shown : "•".repeat(Math.min(shown.length, 24))}
                </T>
              ) : (
                <ActivityIndicator size="small" color={c.textMuted} style={{ alignSelf: "flex-start" }} />
              )}
            </View>
            <IconButton icon="refresh" label={t("generator.regenerate")} busy={busy && !!shown} onPress={() => setRound((r) => r + 1)} />
            <CopyButton label={t("common:actions.copy")} disabled={!password} copy={() => copySecret(password)} />
          </Row>
          {shown && !error ? <StrengthBar password={shown} /> : null}
        </View>
        <View style={styles.block}>
          <Row style={{ justifyContent: "space-between" }}>
            <T variant="callout" style={{ fontWeight: "500" }}>
              {t("generator.length")}
            </T>
            <T variant="callout" muted style={{ fontVariant: ["tabular-nums"] }}>
              {length}
            </T>
          </Row>
          <Host seedColor={c.brand} style={styles.sliderHost}>
            <Slider value={length} min={MIN_LENGTH} max={MAX_LENGTH} step={1} onValueChange={(v) => Math.round(v) !== length && set({ length: Math.round(v) })} />
          </Host>
        </View>
        <SwitchRow title={t("generator.numbers")} value={opts?.numbers ?? true} onChange={(numbers) => set({ numbers })} />
        <SwitchRow title={t("generator.symbols")} value={opts?.symbols ?? true} onChange={(symbols) => set({ symbols })} />
      </Group>
      <Button title={t("generator.use")} icon="check" disabled={!password} onPress={() => onUse(password)} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  block: {
    paddingHorizontal: space.lg,
    paddingVertical: 12,
    gap: space.sm,
  },
  password: {
    fontFamily: fonts.mono,
    fontSize: 17,
    lineHeight: 24,
    letterSpacing: 0.3,
  },
  strength: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  segment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
  },
  strengthLabel: {
    fontWeight: "600",
    minWidth: 64,
    textAlign: "right",
  },
  sliderHost: {
    height: 32,
  },
});
