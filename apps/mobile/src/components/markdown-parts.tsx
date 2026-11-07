import { Button as MenuButton, Host, Image as SwiftImage, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, contentShape, frame, shapes } from "@expo/ui/swift-ui/modifiers";
import { useRecyclingState } from "@shopify/flash-list";
import * as Clipboard from "expo-clipboard";
import { memo, useEffect, useState, type ReactNode } from "react";
import { UITextView } from "@bsky.app/react-native-uitextview";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View, type TextProps, type TextStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./icon";
import { QrCode } from "./qr-code";
import { T, tap } from "./ui";
import { epcPayload, formatIban, parsePayment, tableCsv, tableMarkdown, type Align } from "@/lib/chat-blocks";
import { currentLanguage, intlLocale } from "@/lib/i18n";
import { fonts, radius, scaledText, space, type, useColors, useFontScale, withFont } from "@/lib/theme";

/** Reading text: grows with Dynamic Type up to the limit, and wraps. */
export function Text({ style, ...props }: TextProps & { uiTextView?: boolean }) {
  const fontScale = useFontScale();
  const flat: TextStyle = StyleSheet.flatten(style) ?? {};
  return <UITextView {...props} allowFontScaling={false} style={scaledText(flat.fontFamily ? withFont(flat) : flat, fontScale)} />;
}

function copy(text: string) {
  void Clipboard.setStringAsync(text);
  tap();
}

/** True for a moment after `mark()`: a copy button shows its check. */
function useCopied(key: string): [boolean, () => void] {
  const [copied, setCopied] = useRecyclingState(false, [key]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied, setCopied]);
  return [copied, () => setCopied(true)];
}

/** A copy icon that turns into a check once it copied. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const c = useColors();
  const { t } = useTranslation("common");
  const [copied, mark] = useCopied(text);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? t("actions.copied") : label}
      hitSlop={8}
      onPress={() => {
        copy(text);
        mark();
      }}
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name={copied ? "check" : "copy"} size={14} color={copied ? c.success : c.textMuted} />
    </Pressable>
  );
}

/* Code */

const CODE_LINES = 24;

/** Fenced code: its language, Copy, and the first lines of a long snippet until it is opened. */
export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const lines = code.split("\n");
  const long = lines.length > CODE_LINES + 4;
  const [all, setAll] = useRecyclingState(false, [code]);
  const [copied, mark] = useCopied(code);
  return (
    <View style={[styles.code, { backgroundColor: c.sunken, borderColor: c.border }]}>
      <View style={[styles.codeHead, { borderBottomColor: c.border }]}>
        <Icon name="code" size={12} color={c.textFaint} />
        <T variant="caption" muted numberOfLines={1} style={{ flex: 1, fontFamily: fonts.mono, fontSize: 11.5 }}>
          {lang || "text"}
        </T>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? t("common:actions.copied") : t("markdown.copyCode")}
          hitSlop={8}
          onPress={() => {
            copy(code);
            mark();
          }}
          style={({ pressed }) => [styles.codeCopy, pressed && { backgroundColor: c.accent }]}
        >
          <Icon name={copied ? "check" : "copy"} size={12} color={copied ? c.success : c.textMuted} />
          <T variant="caption" color={copied ? c.success : c.textMuted} style={{ fontWeight: "500" }}>
            {copied ? t("common:actions.copied") : t("common:actions.copy")}
          </T>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.codeBody}>
        <Text selectable uiTextView style={[type.mono, { color: c.text, fontSize: 12.5, lineHeight: 19 }]}>
          {long && !all ? lines.slice(0, CODE_LINES).join("\n") : code}
        </Text>
      </ScrollView>
      {long ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: all }}
          onPress={() => {
            tap();
            setAll(!all);
          }}
          style={({ pressed }) => [styles.codeMore, { borderTopColor: c.border }, pressed && { backgroundColor: c.accent }]}
        >
          <T variant="caption" muted style={{ fontWeight: "500" }}>
            {all ? t("common:actions.showLess") : t("markdown.allLines", { count: lines.length })}
          </T>
          <Icon name={all ? "up" : "down"} size={10} color={c.textMuted} weight="semibold" />
        </Pressable>
      ) : null}
    </View>
  );
});

/* Tables */

/** Copy a table as Markdown or CSV: the system menu on iOS, a choice dialog on Android. */
function CopyTableMenu({ plain, align }: { plain: string[][]; align: Align[] }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const asMarkdown = () => copy(tableMarkdown(plain, align));
  const asCsv = () => copy(tableCsv(plain));
  if (process.env.EXPO_OS === "ios") {
    return (
      <Host style={styles.menuHost}>
        <Menu
          label={<SwiftImage systemName="doc.on.doc" size={14} color={c.textMuted} modifiers={[frame({ width: 34, height: 30 }), contentShape(shapes.rectangle())]} />}
          modifiers={[accessibilityLabel(t("markdown.table.copy"))]}
        >
          <MenuButton label={t("markdown.table.copyMarkdown")} systemImage="text.alignleft" onPress={asMarkdown} />
          <MenuButton label={t("markdown.table.copyCsv")} systemImage="tablecells" onPress={asCsv} />
        </Menu>
      </Host>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("markdown.table.copy")}
      hitSlop={6}
      onPress={() =>
        Alert.alert(t("markdown.table.copy"), undefined, [
          { text: t("markdown.table.copyMarkdown"), onPress: asMarkdown },
          { text: t("markdown.table.copyCsv"), onPress: asCsv },
        ], { cancelable: true })
      }
      style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: c.sunken }]}
    >
      <Icon name="copy" size={14} color={c.textMuted} />
    </Pressable>
  );
}

/**
 * Every row lays its cells out on its own, so the columns get one width each from their longest text (wrapping past a
 * cap) and share what room is left alike.
 */
function columnWidths(plain: string[][], wide: boolean): number[] {
  const count = Math.max(...plain.map((r) => r.length));
  const [min, max] = wide ? [88, 320] : [72, 220];
  return Array.from({ length: count }, (_, i) => {
    const longest = Math.max(0, ...plain.map((r) => (r[i] ?? "").length));
    return Math.round(Math.min(max, Math.max(min, longest * 7.1 + 22)));
  });
}

function Grid({ cells, plain, wide = false }: { cells: ReactNode[][]; plain: string[][]; wide?: boolean }) {
  const c = useColors();
  const widths = columnWidths(plain, wide);
  return (
    <View style={{ minWidth: "100%" }}>
      {cells.map((row, r) => (
        <View key={r} style={[styles.tableRow, { backgroundColor: r === 0 ? c.sunken : "transparent", borderColor: c.border }, r === cells.length - 1 && { borderBottomWidth: 0 }]}>
          {widths.map((w, ci) => (
            <View key={ci} style={[styles.cell, { width: w, flexGrow: w }]}>
              {row[ci] ?? null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/** A table in a reply: scrolls sideways; copied as Markdown or CSV, or opened full screen to read it whole. */
export const TableBlock = memo(function TableBlock({ cells, plain, align }: { cells: ReactNode[][]; plain: string[][]; align: Align[] }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.table, { borderColor: c.border, backgroundColor: c.surface }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: "100%" }}>
        <Grid cells={cells} plain={plain} />
      </ScrollView>
      <View style={[styles.tableBar, { borderTopColor: c.border }]}>
        <CopyTableMenu plain={plain} align={align} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("markdown.table.fullScreen")}
          hitSlop={6}
          onPress={() => {
            tap();
            setOpen(true);
          }}
          style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: c.sunken }]}
        >
          <Icon name="expand" size={13} color={c.textMuted} />
        </Pressable>
      </View>
      {open ? <TableSheet cells={cells} plain={plain} align={align} onClose={() => setOpen(false)} /> : null}
    </View>
  );
});

/** The same table on a sheet of its own, scrolling both ways with room for every column. */
function TableSheet({ cells, plain, align, onClose }: { cells: ReactNode[][]; plain: string[][]; align: Align[]; onClose: () => void }) {
  const c = useColors();
  const { t } = useTranslation(["components", "common"]);
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <View style={[styles.sheetHead, { borderBottomColor: c.border }]}>
          <T variant="headline" style={{ flex: 1 }}>
            {t("markdown.table.title")}
          </T>
          <CopyTableMenu plain={plain} align={align} />
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.done, pressed && { opacity: 0.6 }]}>
            <T variant="callout" color={c.brandStrong} style={{ fontWeight: "600" }}>
              {t("common:actions.done")}
            </T>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + space.xl }}>
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ minWidth: "100%" }}>
            <View style={[styles.table, { borderColor: c.border, backgroundColor: c.surface, minWidth: "100%" }]}>
              <Grid cells={cells} plain={plain} wide />
            </View>
          </ScrollView>
        </ScrollView>
      </View>
    </Modal>
  );
}

/* Payments */

function PaymentRow({ label, value, copyText, first }: { label: string; value: string; copyText?: string; first?: boolean }) {
  const c = useColors();
  return (
    <View style={[styles.payRow, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <T variant="caption" muted>
          {label}
        </T>
        <T variant="subhead" selectable style={{ fontVariant: ["tabular-nums"] }}>
          {value}
        </T>
      </View>
      <CopyButton text={copyText ?? value} label={label} />
    </View>
  );
}

/** A ```payment block: recipient, IBAN, amount and reference, each copied with a tap for the banking app. */
export const PaymentCard = memo(function PaymentCard({ source }: { source: string }) {
  const c = useColors();
  const { t } = useTranslation("components");
  const parsed = parsePayment(source);
  if (!parsed.ok) {
    return (
      <View style={[styles.payError, { backgroundColor: c.dangerSoft }]}>
        <Icon name="warning" size={14} color={c.danger} />
        <T variant="footnote" color={c.danger} style={{ flex: 1 }}>
          {t(`markdown.payment.invalid.${parsed.error}`)}
        </T>
      </View>
    );
  }
  const p = parsed.payment;
  const amount = p.amount == null ? null : new Intl.NumberFormat(intlLocale(), { style: "currency", currency: "EUR" }).format(p.amount);
  const reference = p.reference || p.purpose;
  return (
    <View style={[styles.pay, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.payHead}>
        <View style={[styles.payIcon, { backgroundColor: c.brandSoft }]}>
          <Icon name="creditCard" size={16} color={c.brandStrong} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="caption" muted>
            {t("markdown.payment.transfer")}
          </T>
          {amount ? (
            <T variant="title" style={{ fontVariant: ["tabular-nums"] }}>
              {amount}
            </T>
          ) : (
            <T variant="headline" numberOfLines={1}>
              {p.name}
            </T>
          )}
        </View>
        {amount ? <CopyButton text={p.amount!.toFixed(2).replace(".", currentLanguage() === "de" ? "," : ".")} label={t("markdown.payment.amount")} /> : null}
      </View>
      <View style={[styles.payRows, { borderTopColor: c.border }]}>
        <PaymentRow first label={t("markdown.payment.recipient")} value={p.name} />
        <PaymentRow label="IBAN" value={formatIban(p.iban)} copyText={p.iban} />
        {p.bic ? <PaymentRow label="BIC" value={p.bic} /> : null}
        {reference ? <PaymentRow label={t("markdown.payment.reference")} value={reference} /> : null}
      </View>
      <View style={[styles.payQr, { borderTopColor: c.border }]}>
        <QrCode value={epcPayload(p)} size={168} label={t("markdown.payment.qrLabel")} />
        <T variant="caption" muted>
          {t("markdown.payment.scan")}
        </T>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  iconButton: {
    width: 34,
    height: 30,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  menuHost: {
    width: 34,
    height: 30,
  },
  code: {
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  codeHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingLeft: space.md,
    paddingRight: 4,
    height: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  codeCopy: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    height: 26,
    borderRadius: radius.sm,
  },
  codeBody: {
    paddingHorizontal: space.md,
    paddingVertical: 10,
  },
  codeMore: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 34,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cell: {
    flexShrink: 0,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  tableBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    height: 32,
    paddingHorizontal: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  done: {
    paddingHorizontal: space.sm,
    paddingVertical: 6,
  },
  pay: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  payHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
  },
  payIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  payRows: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingLeft: space.md,
  },
  payQr: {
    alignItems: "center",
    gap: space.sm,
    padding: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  payRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 9,
    paddingRight: 6,
  },
  payError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: space.md,
    borderRadius: radius.sm,
    borderCurve: "continuous",
  },
});
