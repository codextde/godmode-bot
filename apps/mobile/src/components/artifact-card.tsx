import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn } from "react-native-reanimated";
import type { MessageBlock } from "@godmode/shared";
import { Icon } from "./icon";
import { T, tap } from "./ui";
import { api } from "@/lib/api";
import { qk } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

type ToolUse = Extract<MessageBlock, { type: "tool_use" }>;

const bare = (name: string) => name.slice(name.lastIndexOf("__") + 2);

export const isArtifactTool = (block: MessageBlock): block is ToolUse =>
  block.type === "tool_use" && (bare(block.name) === "artifact_create" || bare(block.name) === "artifact_update");

/** The artifact a card's tool call made or changed. */
export function artifactIdOf(block: ToolUse): string | null {
  const input = (block.input ?? {}) as { id?: unknown };
  if (typeof input.id === "string" && input.id.startsWith("art_")) return input.id;
  return /\(id (art_[A-Za-z0-9_-]+)/.exec(block.result ?? "")?.[1] ?? null;
}

export function openArtifact(id: string) {
  tap();
  router.push({ pathname: "/artifact/[id]", params: { id } });
}

/** What an agent built or changed in the chat: opens the artifact full screen. */
export function ArtifactCard({ block, streaming }: { block: ToolUse; streaming: boolean }) {
  const c = useColors();
  const { t } = useTranslation("artifacts");
  const id = artifactIdOf(block);
  const { data: artifact } = useQuery({ queryKey: qk.artifact(id ?? ""), queryFn: () => api.artifacts.get(id!), enabled: !!id, staleTime: 30_000 });
  const input = (block.input ?? {}) as { title?: string; note?: string; html?: string; spec?: unknown; htmlPath?: string; edits?: unknown[]; data?: unknown; dataPath?: string; files?: unknown[] };
  const creating = bare(block.name) === "artifact_create";
  const pending = block.result === undefined && streaming && !block.isError;
  const failed = !!block.isError;
  const title = artifact?.title ?? input.title ?? t("card.artifact");
  const what = failed
    ? t("card.failed")
    : pending
      ? creating
        ? t("card.building")
        : t("card.updating")
      : creating
        ? t("card.built")
        : input.html || input.spec || input.htmlPath || input.edits
          ? input.note || t("card.changedCode")
          : input.data !== undefined || input.dataPath
            ? t("card.updatedData")
            : input.files?.length
              ? t("card.addedFiles", { count: input.files.length })
              : t("card.updated");
  const open = id && !failed ? () => openArtifact(id) : undefined;

  return (
    <Animated.View entering={FadeIn.duration(180)}>
      <Pressable
        accessibilityRole={open ? "button" : undefined}
        accessibilityLabel={title}
        disabled={!open}
        onPress={open}
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: c.surface, borderColor: failed ? c.danger : c.border },
          pressed && { backgroundColor: c.sunken },
        ]}
      >
        <View style={[styles.tile, { backgroundColor: c.brandSoft }]}>
          {pending ? <ActivityIndicator size="small" color={c.brandStrong} /> : <Icon name="artifact" size={19} color={c.brandStrong} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <T variant="headline" numberOfLines={1} style={{ fontSize: 15 }}>
            {title}
          </T>
          <T variant="footnote" color={failed ? c.danger : c.textMuted} numberOfLines={1}>
            {failed && block.result ? block.result : what}
          </T>
        </View>
        {open ? <Icon name="chevron" size={13} color={c.textFaint} /> : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: 10,
    paddingRight: space.md,
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  tile: {
    width: 44,
    height: 44,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
});
