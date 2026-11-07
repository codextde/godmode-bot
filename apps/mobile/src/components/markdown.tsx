import { router } from "expo-router";
import { marked, type Token, type Tokens } from "marked";
import { memo, useMemo, type ReactNode } from "react";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { barePaths, linkedPath, parsePullRequestUrl, TASK_ATTACHMENT_PATH, type ChatFile } from "@godmode/shared";
import { ChatPicture, ChatPictures, openChatFile, useMessageFiles } from "./chat-files";
import { CodeBlock, PaymentCard, TableBlock, Text } from "./markdown-parts";
import { RemoteImage } from "./remote-image";
import { tap } from "./ui";
import { appHref } from "@/lib/chat-blocks";
import { t as translate } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { alpha, fonts, space, type, useColors, type Colors } from "@/lib/theme";

/** The files a message names, and the pictures already shown in its text. */
type Files = { byRef: ReadonlyMap<string, ChatFile>; agentId: string | null; shown: Set<string> } | null;

/**
 * Agent answers: Markdown rendered with native text (paragraphs, lists, code, quotes, tables, links, task pictures); every
 * block is selectable by range on iOS. Code and tables copy, ```payment blocks show the transfer, links to Godmode's
 * pages open the phone's screens, files a chat's message names open in the viewer and its pictures show.
 */
export const Markdown = memo(function Markdown({ text, color }: { text: string; color?: string }) {
  const c = useColors();
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);
  const named = useMessageFiles(text);
  const files: Files = named && { byRef: named.byRef, agentId: named.agentId, shown: new Set() };
  const rendered = blocks(tokens, c, color ?? c.text, files);
  const below = named?.pictures.filter((p) => !files?.shown.has(p.path)) ?? [];
  return (
    <View style={{ gap: 10 }}>
      {rendered}
      {below.length ? <ChatPictures pictures={below} agentId={named?.agentId ?? null} /> : null}
    </View>
  );
});

function blocks(tokens: Token[], c: Colors, color: string, files: Files): ReactNode[] {
  return tokens.map((t, i) => block(t, i, c, color, files)).filter(Boolean);
}

/** The picture a paragraph or list item names with nothing said around it. */
function solePicture(tokens: Token[] | undefined, files: Files): ChatFile | null {
  if (!files || !tokens) return null;
  const [only, ...rest] = tokens.filter((t) => t.type !== "space" && t.type !== "br" && !(t.type === "text" && !t.raw.trim()));
  if (!only || rest.length) return null;
  if (only.type === "strong" || only.type === "em" || only.type === "paragraph") return solePicture((only as Tokens.Strong).tokens, files);
  if (only.type === "text" && (only as Tokens.Text).tokens) return solePicture((only as Tokens.Text).tokens, files);
  const ref = only.type === "link" || only.type === "image" ? linkedPath((only as Tokens.Link).href) : only.type === "codespan" || only.type === "text" ? decode((only as Tokens.Text).text).trim() : "";
  const file = files.byRef.get(ref);
  return file?.image ? file : null;
}

function picture(file: ChatFile, key: number, files: NonNullable<Files>): ReactNode {
  files.shown.add(file.path);
  return <ChatPicture key={key} file={file} agentId={files.agentId} />;
}

function block(t: Token, key: number, c: Colors, color: string, files: Files): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "text": {
      const text = t as Tokens.Text;
      return (
        <Text key={key} style={[type.body, { color }]} selectable uiTextView>
          {text.tokens ? inline(text.tokens, c, color, files) : decode(text.text)}
        </Text>
      );
    }
    case "paragraph": {
      const tokens = (t as Tokens.Paragraph).tokens;
      const alone = solePicture(tokens, files);
      if (alone && files && !files.shown.has(alone.path)) return picture(alone, key, files);
      const pictures = tokens.filter(isTaskPicture);
      if (pictures.length && tokens.every((p) => isTaskPicture(p) || p.type === "br" || (p.type === "text" && !p.raw.trim()))) {
        return (
          <View key={key} style={{ gap: 8 }}>
            {pictures.map((p, i) => (
              <RemoteImage key={i} path={p.href} alt={p.text} />
            ))}
          </View>
        );
      }
      return (
        <Text key={key} style={[type.body, { color }]} selectable uiTextView>
          {inline(tokens, c, color, files)}
        </Text>
      );
    }
    case "heading": {
      const h = t as Tokens.Heading;
      const size = h.depth <= 1 ? 22 : h.depth === 2 ? 19 : 17;
      return (
        <Text key={key} selectable uiTextView style={{ color, fontSize: size, lineHeight: size * 1.3, fontFamily: fonts.semibold, letterSpacing: -0.3, marginTop: 4 }}>
          {inline(h.tokens, c, color, files)}
        </Text>
      );
    }
    case "list": {
      const list = t as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      // A list of nothing but pictures is a gallery.
      const gallery = list.items.map((item) => solePicture(item.tokens, files));
      if (files && !list.ordered && gallery.every((f) => f && !files.shown.has(f.path)) && new Set(gallery.map((f) => f?.path)).size === gallery.length) {
        return (
          <View key={key} style={{ gap: 8 }}>
            {gallery.map((f, i) => picture(f!, i, files))}
          </View>
        );
      }
      return (
        <View key={key} style={{ gap: 6 }}>
          {list.items.map((item, i) => (
            <View key={i} style={styles.listItem}>
              {item.task ? (
                <View
                  accessibilityLabel={item.checked ? translate("components:markdown.done") : translate("components:markdown.notDone")}
                  style={[styles.check, item.checked ? { backgroundColor: c.text, borderColor: c.text } : { borderColor: alpha(c.textMuted, 0.6) }]}
                >
                  {item.checked ? <View style={[styles.tick, { borderColor: c.background }]} /> : null}
                </View>
              ) : (
                <Text style={[type.body, { color: c.textMuted, minWidth: list.ordered ? 22 : 14, fontVariant: ["tabular-nums"] }]}>{list.ordered ? `${start + i}.` : "•"}</Text>
              )}
              <View style={{ flex: 1, gap: 6 }}>{blocks(item.tokens, c, color, files)}</View>
            </View>
          ))}
        </View>
      );
    }
    case "code": {
      const code = t as Tokens.Code;
      const lang = (code.lang ?? "").trim().split(/\s/)[0] ?? "";
      if (lang === "payment") return <PaymentCard key={key} source={code.text} />;
      return <CodeBlock key={key} code={code.text} lang={lang} />;
    }
    case "blockquote":
      return (
        <View key={key} style={[styles.quote, { borderLeftColor: c.borderStrong }]}>
          {blocks((t as Tokens.Blockquote).tokens, c, c.textMuted, files)}
        </View>
      );
    case "hr":
      return <View key={key} style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.borderStrong, marginVertical: 4 }} />;
    case "table": {
      const table = t as Tokens.Table;
      const rows = [table.header, ...table.rows];
      const cells = rows.map((row, r) =>
        row.map((cell, ci) => (
          <Text key={ci} selectable uiTextView style={[type.subhead, { color, fontFamily: r === 0 ? fonts.semibold : fonts.regular }]}>
            {inline(cell.tokens, c, color, files)}
          </Text>
        )),
      );
      return <TableBlock key={key} cells={cells} plain={rows.map((row) => row.map((cell) => plain(cell.tokens).replace(/\s+/g, " ").trim()))} align={table.align} />;
    }
    default:
      return "text" in t && t.text ? (
        <Text key={key} style={[type.body, { color }]} selectable uiTextView>
          {t.text}
        </Text>
      ) : null;
  }
}

/** A file a message names, in its text: `code` keeps the look of code. */
function fileLink(file: ChatFile, key: number, c: Colors, files: NonNullable<Files>, children: ReactNode, code = false) {
  return (
    <Text
      key={key}
      accessibilityRole="link"
      style={[{ color: c.brandStrong, textDecorationLine: "underline" }, code && [type.mono, { fontSize: 14, backgroundColor: c.sunken }]]}
      onPress={() => openChatFile(file, files.agentId)}
    >
      {children}
    </Text>
  );
}

/** Plain text with the paths it writes out that exist as links. */
function linkBarePaths(value: string, c: Colors, files: NonNullable<Files>): ReactNode {
  const out: ReactNode[] = [];
  let at = 0;
  for (const { path, index } of barePaths(value)) {
    const file = files.byRef.get(path);
    if (!file) continue;
    if (index > at) out.push(value.slice(at, index));
    out.push(fileLink(file, index, c, files, path));
    at = index + path.length;
  }
  if (!out.length) return value;
  if (at < value.length) out.push(value.slice(at));
  return out;
}

function inline(tokens: Token[] | undefined, c: Colors, color: string, files: Files): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} style={{ fontFamily: fonts.semibold }}>
            {inline((t as Tokens.Strong).tokens, c, color, files)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            {inline((t as Tokens.Em).tokens, c, color, files)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through" }}>
            {inline((t as Tokens.Del).tokens, c, color, files)}
          </Text>
        );
      case "codespan": {
        const named = files?.byRef.get(decode((t as Tokens.Codespan).text).trim());
        // Padded with no-break spaces: a plain one stays alone on the line above when the code wraps.
        const code = `\u00A0${decode((t as Tokens.Codespan).text)}\u00A0`;
        if (named && files) return fileLink(named, i, c, files, code, true);
        return (
          <Text key={i} style={[type.mono, { fontSize: 14, backgroundColor: c.sunken, color }]}>
            {code}
          </Text>
        );
      }
      case "link": {
        const link = t as Tokens.Link;
        const named = files?.byRef.get(linkedPath(link.href));
        if (named && files) return fileLink(named, i, c, files, inline(link.tokens, c, color, files));
        return (
          <Text key={i} style={{ color: c.brandStrong, textDecorationLine: "underline" }} onPress={() => openLink(link.href)}>
            {inline(link.tokens, c, color, files)}
          </Text>
        );
      }
      case "image": {
        const image = t as Tokens.Image;
        const named = files?.byRef.get(linkedPath(image.href));
        return named && files ? fileLink(named, i, c, files, decode(image.text) || named.name) : decode(image.text);
      }
      case "br":
        return "\n";
      case "text": {
        const text = t as Tokens.Text;
        if (text.tokens) return <Text key={i}>{inline(text.tokens, c, color, files)}</Text>;
        return files ? <Text key={i}>{linkBarePaths(decode(text.text), c, files)}</Text> : decode(text.text);
      }
      default:
        return "text" in t ? decode(String(t.text)) : "";
    }
  });
}

/** Pages of Godmode open the phone's screen for them; the web and mail open outside. */
function openLink(href: string) {
  // A pull request opens its screen (checks, merge) on a phone with full access, like the desktop's side panel.
  if (parsePullRequestUrl(href) && (queryClient.getQueryData(qk.me) as { fullAccess?: boolean } | undefined)?.fullAccess === true) {
    tap();
    return void router.push({ pathname: "/pull-request", params: { url: href } });
  }
  if (/^(https?|mailto|tel):/i.test(href)) return void Linking.openURL(href);
  const to = appHref(href);
  if (to) {
    tap();
    router.push(to);
  } else if (href.startsWith("/") && !href.startsWith("//")) Alert.alert(translate("components:markdown.onComputer"));
}

/** A cell's text as the reader sees it, for copying. */
function plain(tokens: Token[] | undefined): string {
  return (tokens ?? [])
    .map((t) => {
      if (t.type === "br") return " ";
      if ("tokens" in t && t.tokens?.length) return plain(t.tokens);
      return "text" in t ? decode(String(t.text)) : "";
    })
    .join("");
}

function isTaskPicture(t: Token): t is Tokens.Image {
  return t.type === "image" && (t as Tokens.Image).href.startsWith(TASK_ATTACHMENT_PATH) && !(t as Tokens.Image).href.includes("..");
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const styles = StyleSheet.create({
  listItem: {
    flexDirection: "row",
    gap: 6,
  },
  check: {
    width: 15,
    height: 15,
    marginTop: 4,
    marginRight: 2,
    borderRadius: 4,
    borderWidth: 1.25,
    alignItems: "center",
    justifyContent: "center",
  },
  tick: {
    width: 7,
    height: 4,
    marginTop: -2,
    borderLeftWidth: 1.6,
    borderBottomWidth: 1.6,
    transform: [{ rotate: "-45deg" }],
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: space.md,
    gap: 8,
  },
});
