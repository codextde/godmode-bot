import { marked, type Token, type Tokens } from "marked";
import { memo, useMemo, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { TASK_ATTACHMENT_PATH } from "@godmode/shared";
import { RemoteImage } from "./remote-image";
import { alpha, fonts, radius, space, type, useColors, type Colors } from "@/lib/theme";

/** Agent answers: Markdown rendered with native text (paragraphs, lists, code, quotes, tables, links, task pictures). */
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
        <Text key={key} style={[type.body, { color }]} selectable>
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
        <Text key={key} style={[type.body, { color }]} selectable>
          {inline(tokens, c, color)}
        </Text>
      );
    }
    case "heading": {
      const h = t as Tokens.Heading;
      const size = h.depth <= 1 ? 22 : h.depth === 2 ? 19 : 17;
      return (
        <Text key={key} style={{ color, fontSize: size, lineHeight: size * 1.3, fontFamily: fonts.semibold, letterSpacing: -0.3, marginTop: 4 }}>
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
                  accessibilityLabel={item.checked ? "Done" : "Not done"}
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
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: c.sunken }]}>
          <Text selectable style={[type.mono, { color, lineHeight: 19 }]}>
            {code.text}
          </Text>
        </ScrollView>
      );
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
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: "100%" }}>
          <View style={[styles.table, { borderColor: c.border, minWidth: "100%" }]}>
            {[table.header, ...table.rows].map((row, r) => (
              <View key={r} style={[styles.tableRow, { backgroundColor: r === 0 ? c.sunken : "transparent", borderColor: c.border }]}>
                {row.map((cell, ci) => (
                  <Text key={ci} style={[type.subhead, styles.cell, { color, fontFamily: r === 0 ? fonts.semibold : fonts.regular }]}>
                    {inline(cell.tokens, c, color)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    default:
      return "text" in t && t.text ? (
        <Text key={key} style={[type.body, { color }]} selectable>
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
          <Text key={i} style={{ color: c.brandStrong, textDecorationLine: "underline" }} onPress={() => /^(https?|mailto):/i.test(link.href) && void Linking.openURL(link.href)}>
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
  code: {
    borderRadius: radius.sm,
    borderCurve: "continuous",
    padding: space.md,
    flexGrow: 0,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: space.md,
    gap: 8,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cell: {
    flex: 1,
    minWidth: 84,
    maxWidth: 220,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
});
