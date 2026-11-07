import { StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import { parseOtpUri, type OtpReview, type TotpImportResult } from "@godmode/shared";
import { Group } from "./form";
import { Icon } from "./icon";
import { IconButton } from "./secret-parts";
import { Badge, Card, Row, T } from "./ui";
import { space, useColors } from "@/lib/theme";

/** What an import would add, before it does: each code can be removed, and what can't work is said here. */
export function OtpReviewList({ review, onRemove }: { review: OtpReview; onRemove: (uri: string) => void }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  if (!review.parsed.length) return null;
  const counter = review.parsed.some((p) => (p.kind === "otpauth" ? p.preview.type === "hotp" : p.preview.accounts.some((a) => a.type === "hotp")));
  return (
    <View style={{ gap: space.md }}>
      {review.incomplete.map((b, i) => (
        <Card key={i} style={[styles.warn, { backgroundColor: c.warningSoft, borderColor: "transparent" }]}>
          <Icon name="warning" size={15} color={c.warning} />
          <T variant="footnote" style={{ flex: 1 }}>
            {t("otpPreview.incomplete", { size: b.size, count: b.missing })}
          </T>
        </Card>
      ))}
      <Group title={`${t("otpPreview.ready")} · ${t("otpPreview.accounts", { count: review.accountCount })}`} footer={counter ? t("otpPreview.hotpHint") : undefined}>
        {review.parsed.flatMap((p) =>
          p.kind === "otpauth"
            ? [
                <Account
                  key={p.uri}
                  issuer={p.preview.issuer}
                  account={p.preview.account}
                  type={p.preview.type}
                  algorithm={p.preview.algorithm}
                  digits={p.preview.digits}
                  period={p.preview.period}
                  invalid={!p.preview.validSecret}
                  onRemove={() => onRemove(p.uri)}
                />,
              ]
            : [
                <Row key={p.uri} style={styles.row}>
                  <Icon name="layers" size={15} color={c.textMuted} />
                  <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                    <T variant="subhead" numberOfLines={1} style={{ fontWeight: "600" }}>
                      {t("otpPreview.googleExport")}
                    </T>
                    {p.preview.batchSize > 1 ? (
                      <T variant="footnote" muted numberOfLines={1}>
                        {t("otpPreview.qrPart", { index: p.preview.batchIndex + 1, total: p.preview.batchSize })}
                      </T>
                    ) : null}
                  </View>
                  <IconButton icon="minus" label={t("otpPreview.removeExport")} onPress={() => onRemove(p.uri)} />
                </Row>,
                ...p.preview.accounts.map((a, i) => <Account key={`${p.uri}-${i}`} issuer={a.issuer} account={a.account} type={a.type} algorithm={a.algorithm} digits={a.digits} />),
              ],
        )}
      </Group>
    </View>
  );
}

function Account({
  issuer,
  account,
  type,
  algorithm,
  digits,
  period,
  invalid,
  onRemove,
}: {
  issuer: string;
  account: string;
  type: string;
  algorithm: string;
  digits: number;
  period?: number;
  invalid?: boolean;
  onRemove?: () => void;
}) {
  const { t } = useTranslation("vault");
  const flags = [
    invalid ? <Badge key="invalid" label={t("otpPreview.invalidSecret")} tone="danger" dot={false} /> : null,
    type === "hotp" ? <Badge key="hotp" label={t("otpPreview.hotp")} tone="warning" dot={false} /> : null,
    algorithm !== "SHA1" ? <Badge key="algorithm" label={algorithm} dot={false} /> : null,
    digits !== 6 ? <Badge key="digits" label={t("otpPreview.digits", { digits })} dot={false} /> : null,
    period && period !== 30 ? <Badge key="period" label={`${period} s`} dot={false} /> : null,
  ].filter(Boolean);
  return (
    <Row style={styles.row}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
          {issuer}
        </T>
        {account ? (
          <T variant="footnote" muted numberOfLines={1}>
            {account}
          </T>
        ) : null}
        {flags.length ? <View style={styles.flags}>{flags}</View> : null}
      </View>
      {onRemove ? <IconButton icon="minus" label={t("otpPreview.remove", { name: issuer })} onPress={onRemove} /> : null}
    </Row>
  );
}

/** "GitHub · dan@x.de", the link's own name when the computer gave none. */
function skippedName(item: TotpImportResult["skipped"][number], unknown: string, exportName: string): string {
  if (item.label) return item.label;
  const p = parseOtpUri(item.uri);
  if (p.kind === "otpauth") return p.preview.account ? `${p.preview.issuer} · ${p.preview.account}` : p.preview.issuer;
  return p.kind === "migration" ? exportName : unknown;
}

/** What came of an import that left something out: what was added, then each code that wasn't and why. */
export function OtpImportResult({ result }: { result: TotpImportResult }) {
  const c = useColors();
  const { t } = useTranslation("vault");
  return (
    <View style={{ gap: space.xl }}>
      <View style={styles.summary}>
        <Icon name={result.imported.length ? "checkCircle" : "warning"} size={32} color={result.imported.length ? c.success : c.warning} />
        <T variant="headline" style={{ textAlign: "center" }}>
          {result.imported.length ? t("totpLinks.added", { count: result.imported.length }) : t("totpImport.nothing")}
        </T>
      </View>
      {result.imported.length ? (
        <Group>
          {result.imported.map((e) => (
            <Row key={e.id} style={styles.row}>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                  {e.issuer}
                </T>
                {e.accountName ? (
                  <T variant="footnote" muted numberOfLines={1}>
                    {e.accountName}
                  </T>
                ) : null}
              </View>
              <Icon name="check" size={14} color={c.success} weight="semibold" />
            </Row>
          ))}
        </Group>
      ) : null}
      {result.skipped.length ? (
        <Group title={t("totpLinks.skipped", { count: result.skipped.length })}>
          {result.skipped.map((s, i) => (
            <View key={`${s.uri}-${i}`} style={[styles.row, { flexDirection: "column", alignItems: "stretch", gap: 2 }]}>
              <T variant="callout" numberOfLines={1} style={{ fontWeight: "500" }}>
                {skippedName(s, t("totpImport.unknownCode"), t("otpPreview.googleExport"))}
              </T>
              <T variant="footnote" muted>
                {s.reason}
              </T>
            </View>
          ))}
        </Group>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  warn: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    padding: space.md,
  },
  row: {
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    minHeight: 48,
  },
  flags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    paddingTop: 2,
  },
  summary: {
    alignItems: "center",
    gap: space.sm,
    paddingTop: space.md,
  },
});
