import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { fileRefs, type ChatFile, type ChatFiles } from "@godmode/shared";
import { Icon } from "./icon";
import { RemoteImage } from "./remote-image";
import { tap } from "./ui";
import { request } from "@/lib/api";
import { t } from "@/lib/i18n";
import { fonts, radius, space, type, useColors } from "@/lib/theme";

const ChatScope = createContext<{ conversationId: string | null; runnerId: string | null }>({ conversationId: null, runnerId: null });

/** The chat whose messages are shown below: the paths they name are looked up where its agent works. */
export function ChatFilesScope({ conversationId, runnerId, children }: { conversationId: string | null | undefined; runnerId?: string | null; children: ReactNode }) {
  const scope = useMemo(() => ({ conversationId: conversationId ?? null, runnerId: runnerId ?? null }), [conversationId, runnerId]);
  return <ChatScope.Provider value={scope}>{children}</ChatScope.Provider>;
}

type Answer = { agentId: string | null; files: ChatFile[] };
type Ask = { refs: string[]; done: (answer: Answer) => void; fail: (err: unknown) => void };

const asks = new Map<string, Ask[]>();
let flushing: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushing = null;
  const waiting = [...asks];
  asks.clear();
  for (const [conversationId, list] of waiting) {
    for (let i = 0; i < list.length; i += 100) {
      const chunk = list.slice(i, i + 100);
      request<ChatFiles>("POST", `/api/conversations/${encodeURIComponent(conversationId)}/files`, { messages: chunk.map((a) => a.refs) }).then(
        (res) => chunk.forEach((a, n) => a.done({ agentId: res.agentId ?? null, files: res.files[n] ?? [] })),
        (err) => chunk.forEach((a) => a.fail(err)),
      );
    }
  }
}

/** One request for all the messages that ask within a moment: a chat opens with many. */
function resolveFiles(conversationId: string, refs: string[]): Promise<Answer> {
  return new Promise((done, fail) => {
    asks.set(conversationId, [...(asks.get(conversationId) ?? []), { refs, done, fail }]);
    flushing ??= setTimeout(flush, 20);
  });
}

export interface MessageFiles {
  byRef: ReadonlyMap<string, ChatFile>;
  /** The pictures among them, each once. */
  pictures: ChatFile[];
  agentId: string | null;
}

const onRunner = (url: string, runnerId: string) => `${url}${url.includes("?") ? "&" : "?"}runner=${encodeURIComponent(runnerId)}`;

/** The files and folders a message names that exist; null outside a chat and while nothing is found. */
export function useMessageFiles(markdown: string): MessageFiles | null {
  const { conversationId, runnerId } = useContext(ChatScope);
  const refs = useMemo(() => (conversationId ? fileRefs(markdown).join("\n") : ""), [conversationId, markdown]);
  // A message that is still being written names a longer path with every word.
  const [asked, setAsked] = useState(refs);
  // Another message in this recycled row asks right away.
  if (asked !== refs && !refs.startsWith(asked)) setAsked(refs);
  useEffect(() => {
    const timer = setTimeout(() => setAsked(refs), 300);
    return () => clearTimeout(timer);
  }, [refs]);
  const { data } = useQuery({
    queryKey: ["chat-files", conversationId ?? "", asked],
    queryFn: () => resolveFiles(conversationId!, asked.split("\n")),
    enabled: !!conversationId && asked !== "",
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  return useMemo(() => {
    const named = new Set(refs.split("\n"));
    const found = data?.files.filter((f) => named.has(f.ref));
    if (!data || !found?.length) return null;
    const files = runnerId
      ? found.map((f) =>
          f.remote
            ? { ...f, image: f.image && onRunner(f.image, runnerId), markdown: f.markdown ? onRunner(f.markdown, runnerId) : null, text: f.text ? onRunner(f.text, runnerId) : null, pdf: f.pdf ? onRunner(f.pdf, runnerId) : null }
            : f,
        )
      : found;
    const pictures = new Map(files.filter((f) => f.image).map((f) => [f.path, f]));
    return { byRef: new Map(files.map((f) => [f.ref, f])), pictures: [...pictures.values()], agentId: data.agentId };
  }, [data, refs, runnerId]);
}

/** What the computer serves of a file outside the agent's folder, for the viewer; null when it serves nothing. */
function served(file: ChatFile): { kind: "image" | "markdown" | "text" | "pdf"; url: string } | null {
  if (file.image) return { kind: "image", url: file.image };
  if (file.pdf) return { kind: "pdf", url: file.pdf };
  if (file.markdown) return { kind: "markdown", url: file.markdown };
  if (file.text) return { kind: "text", url: file.text };
  return null;
}

/**
 * A file in the folder of the chat's agent opens in the phone's viewer, a folder in its file list. Elsewhere on the
 * computer what it serves opens too (only a phone with full access gets those); the rest copies the path, like the
 * desktop from another computer.
 */
export function openChatFile(file: ChatFile, agentId: string | null) {
  tap();
  if (agentId && !file.remote && file.agentPath !== undefined) {
    if (file.kind === "folder") return router.push({ pathname: "/settings/files/[agent]", params: { agent: agentId, path: file.agentPath } });
    return router.push({ pathname: "/chat-file", params: { agent: agentId, path: file.agentPath } });
  }
  const shown = served(file);
  if (shown) return router.push({ pathname: "/chat-file", params: { ...shown, name: file.name } });
  void Clipboard.setStringAsync(file.path);
  Alert.alert(t("chat:files.pathCopied"), file.path);
}

/** A picture a message names, right in the chat: a tap opens it, with sharing and zoom. */
export function ChatPicture({ file, agentId }: { file: ChatFile; agentId: string | null }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={t("chat:files.openNamed", { name: file.name })}
      onPress={() => openChatFile(file, agentId)}
      style={({ pressed }) => [styles.tile, { borderColor: c.border, backgroundColor: c.surface }, pressed && { opacity: 0.8 }]}
    >
      <RemoteImage path={file.image!} alt={file.name} style={styles.picture} />
      <View style={[styles.name, { borderTopColor: c.border }]}>
        <Text numberOfLines={1} ellipsizeMode="middle" maxFontSizeMultiplier={1.3} style={[type.caption, { flex: 1, fontFamily: fonts.mono, color: c.textMuted }]}>
          {file.name}
        </Text>
        <Icon name="expand" size={13} color={c.textFaint} />
      </View>
    </Pressable>
  );
}

export function ChatPictures({ pictures, agentId }: { pictures: ChatFile[]; agentId: string | null }) {
  return (
    <View style={styles.pictures}>
      {pictures.map((p) => (
        <ChatPicture key={p.path} file={p} agentId={agentId} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pictures: {
    gap: space.sm,
  },
  tile: {
    overflow: "hidden",
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  picture: {
    alignSelf: "center",
    borderRadius: 0,
  },
  name: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
