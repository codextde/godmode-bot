import { router } from "expo-router";
import { marked, type Token, type Tokens } from "marked";
import { memo, useMemo, type ReactNode } from "react";
import { UITextView as Text } from "@bsky.app/react-native-uitextview";
import { Alert, Linking, StyleSheet, View } from "react-native";
import { parsePullRequestUrl, TASK_ATTACHMENT_PATH } from "@godmode/shared";
import { CodeBlock, PaymentCard, TableBlock } from "./markdown-parts";
import { RemoteImage } from "./remote-image";
import { tap } from "./ui";
import { appHref } from "@/lib/chat-blocks";
import { t as translate } from "@/lib/i18n";
import { qk, queryClient } from "@/lib/query";
import { alpha, fonts, space, type, useColors, type Colors } from "@/lib/theme";

/**
 * Agent answers: Markdown rendered with native text (paragraphs, lists, code, quotes, tables, links, task pictures); every
 * block is selectable by range on iOS. Code and tables copy, ```payment blocks show the transfer, links to Godmode's
 * pages open the phone's screens.
 */
export const Markdown = memo(function Markdown({ text, color }: { text: string; color?: string }) {
  const c = useColors();
  const tokens = useMemo(() => marked.lexer(text, { gfm: true }), [text]);
  return <View style={{ gap: 10 }}>{blocks(tokens, c, color ?? c.text)}</View>;
});

function blocks(tokens: Token[], c: Colors, color: string): ReactNode[] {
  return tokens.map((t, i) => block(t, i, c, color)).filter(Boolean);
}

function block(t: Token, key: number, c: Colors, color: string): ReactNode {
  switch (t.type) {
    case "space":
      return null;
    case "text": {
      const text = t as Tokens.Text;
      return (
        <Text key={key} style={[type.body, { color }]} selectable uiTextView>
          {text.tokens ? inline(text.tokens, c, color) : decode(text.text)}
        </Text>
      );
    }
    case "paragraph": {
      const tokens = (t as Tokens.Paragraph).tokens;
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
          {inline(tokens, c, color)}
        </Text>
      );
    }
    case "heading": {
      const h = t as Tokens.Heading;
      const size = h.depth <= 1 ? 22 : h.depth === 2 ? 19 : 17;
      return (
        <Text key={key} selectable uiTextView style={{ color, fontSize: size, lineHeight: size * 1.3, fontFamily: fonts.semibold, letterSpacing: -0.3, marginTop: 4 }}>
          {inline(h.tokens, c, color)}
        </Text>
      );
    }
    case "list": {
      const list = t as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
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
              <View style={{ flex: 1, gap: 6 }}>{blocks(item.tokens, c, color)}</View>
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
          {blocks((t as Tokens.Blockquote).tokens, c, c.textMuted)}
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
            {inline(cell.tokens, c, color)}
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

function inline(tokens: Token[] | undefined, c: Colors, color: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    switch (t.type) {
      case "strong":
        return (
          <Text key={i} style={{ fontFamily: fonts.semibold }}>
            {inline((t as Tokens.Strong).tokens, c, color)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} style={{ fontStyle: "italic" }}>
            {inline((t as Tokens.Em).tokens, c, color)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} style={{ textDecorationLine: "line-through" }}>
            {inline((t as Tokens.Del).tokens, c, color)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} style={[type.mono, { fontSize: 14, backgroundColor: c.sunken, color }]}>
            {` ${decode((t as Tokens.Codespan).text)} `}
          </Text>
        );
      case "link": {
        const link = t as Tokens.Link;
        return (
          <Text key={i} style={{ color: c.brandStrong, textDecorationLine: "underline" }} onPress={() => openLink(link.href)}>
            {inline(link.tokens, c, color)}
          </Text>
        );
      }
      case "br":
        return "\n";
      case "text": {
        const text = t as Tokens.Text;
        return text.tokens ? <Text key={i}>{inline(text.tokens, c, color)}</Text> : decode(text.text);
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
