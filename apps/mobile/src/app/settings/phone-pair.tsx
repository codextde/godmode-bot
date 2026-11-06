import * as Clipboard from "expo-clipboard";
import { router, Stack } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Share, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { MobileDevice, MobilePairingOffer } from "@godmode/shared";
import { confirmWithBiometrics, FullAccessGate, isRefused, NeedsFullAccess } from "@/components/admin";
import { Group, LinkRow } from "@/components/form";
import { Icon } from "@/components/icon";
import { QrCode } from "@/components/qr-code";
import { Button, Card, EmptyState, ErrorState, Skeleton, T, tap } from "@/components/ui";
import { adminApi, ak } from "@/lib/admin";
import { errorText } from "@/lib/api";
import { useNow } from "@/lib/hooks";
import { queryClient } from "@/lib/query";
import { radius, space, useColors } from "@/lib/theme";

const QR_SIZE = 236;
const POLL_MS = 2000;

/** Pairs another phone from this one: Face ID, then a one-time code as a QR code and a link to share. */
export default function PhonePair() {
  const { t } = useTranslation("admin");
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: t("pair.title"), headerLargeTitleEnabled: false }} />
      <FullAccessGate>
        <Pairing />
      </FullAccessGate>
    </ScrollView>
  );
}

function Pairing() {
  const c = useColors();
  const { t } = useTranslation(["admin", "common"]);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [offer, setOffer] = useState<MobilePairingOffer | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [paired, setPaired] = useState<MobileDevice | null>(null);
  const known = useRef<Set<string> | null>(null);
  const now = useNow(1000);

  const creating = useRef(false);
  const create = useCallback(async () => {
    if (creating.current) return;
    creating.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!known.current) known.current = new Set((await adminApi.phones.status()).devices.map((d) => d.id));
      setOffer(await adminApi.phones.pairing());
    } catch (err) {
      setError(err);
    } finally {
      creating.current = false;
      setBusy(false);
    }
  }, []);

  // A pairing code lets a phone in: Face ID first, every time this screen opens.
  const ask = useCallback(async () => {
    const ok = await confirmWithBiometrics(t("pair.faceId"));
    setAllowed(ok);
    if (ok) await create();
  }, [create, t]);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void ask();
  }, [ask]);

  // The code stops working when the screen closes.
  useEffect(() => () => void adminApi.phones.cancelPairing().catch(() => undefined), []);

  // A new phone in the list: it took the code. A code that ran out is replaced.
  useEffect(() => {
    if (!offer || paired) return;
    const timer = setInterval(async () => {
      if (Date.parse(offer.expiresAt) <= Date.now()) return void create();
      const status = await adminApi.phones.status().catch(() => null);
      const fresh = status?.devices.find((d) => !known.current?.has(d.id));
      if (!fresh || !status) return;
      queryClient.setQueryData(ak.phones, status);
      tap();
      setPaired(fresh);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [offer, paired, create]);

  const remaining = offer ? Math.max(0, Math.round((Date.parse(offer.expiresAt) - now) / 1000)) : 0;

  if (allowed === false) {
    return <EmptyState icon="faceid" title={t("pair.locked")} action={<Button title={t("pair.unlock")} variant="outline" onPress={() => void ask()} />} />;
  }
  if (paired) {
    return (
      <EmptyState
        icon="checkCircle"
        title={t("pair.connected", { name: paired.name })}
        body={t("pair.connectedBody")}
        action={<Button title={t("common:actions.done")} onPress={() => router.back()} />}
      />
    );
  }
  if (isRefused(error)) return <NeedsFullAccess />;
  if (error && !offer) return <ErrorState title={t("pair.noCode")} error={errorText(error)} onRetry={() => void create()} />;

  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <>
      <Card style={styles.card}>
        <View style={[styles.qr, { width: QR_SIZE + 24, height: QR_SIZE + 24, borderColor: c.border }]}>
          {offer ? (
            <View style={{ opacity: busy ? 0.3 : 1 }}>
              <QrCode value={offer.link} size={QR_SIZE} label={t("pair.qrLabel")} />
            </View>
          ) : (
            <Skeleton width={QR_SIZE} height={QR_SIZE} radius={radius.md} />
          )}
        </View>
        <T variant="subhead" style={{ textAlign: "center" }}>
          {t("pair.scan")}
        </T>
        {offer ? (
          <View style={styles.expiry}>
            <Icon name="clock" size={12} color={c.textMuted} />
            <T variant="footnote" muted style={{ fontVariant: ["tabular-nums"] }}>
              {t("pair.expires", { time })}
            </T>
          </View>
        ) : null}
      </Card>

      <Group footer={offer?.urls[0] ? t("pair.waitingOn", { address: offer.urls[0].replace(/^https?:\/\//, "") }) : undefined}>
        <LinkRow icon="share" title={t("pair.share")} chevron={false} onPress={() => offer && void Share.share({ message: offer.link })} />
        <LinkRow icon="copy" title={t("pair.copy")} chevron={false} onPress={() => offer && void Clipboard.setStringAsync(offer.link)} />
        <LinkRow icon="refresh" title={t("pair.newCode")} chevron={false} onPress={() => void create()} />
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: space.lg,
    paddingBottom: 60,
    gap: space.xl,
  },
  card: {
    alignItems: "center",
    gap: space.md,
    padding: space.xl,
  },
  qr: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.xl,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    backgroundColor: "#ffffff",
  },
  expiry: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});
