import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import type { Offer } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { Card, Hairline, Row, T, tap } from "./ui";
import { api, ApiError, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

const LONG = 140;

/**
 * What the main agent offers to take off the human's plate, spotted while it dreamt. "Do it" starts the chat that does
 * it; "No thanks" declines, and the next dream learns from both. Nothing shows on an older computer.
 */
export function OffersCard() {
  const c = useColors();
  const { t } = useTranslation("tabs");
  const { id: workspaceId } = useWorkspace();
  const { byId } = useAgents();
  const key = qk.offerList(workspaceId);
  const offers = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Offer[]> => {
      try {
        return await api.offers.list(workspaceId);
      } catch (err) {
        if (err instanceof ApiError && err.code === "device_forbidden") return [];
        throw err;
      }
    },
    staleTime: 60_000,
  });
  const [busy, setBusy] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: (id: string) => api.offers.accept(id),
    onMutate: (id) => setBusy(id),
    onSuccess: ({ offer, conversation }) => {
      queryClient.setQueryData<Offer[]>(key, (cur) => cur?.filter((o) => o.id !== offer.id));
      void queryClient.invalidateQueries({ queryKey: qk.offers });
      void queryClient.invalidateQueries({ queryKey: qk.conversations });
      router.push({ pathname: "/chat/[id]", params: { id: conversation.id } });
    },
    onError: (err) => {
      void queryClient.invalidateQueries({ queryKey: qk.offers });
      Alert.alert(t("home.offers.startError"), errorText(err));
    },
    onSettled: () => setBusy(null),
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => api.offers.dismiss(id),
    onMutate: (id) => {
      const before = queryClient.getQueryData<Offer[]>(key);
      queryClient.setQueryData<Offer[]>(key, (cur) => cur?.filter((o) => o.id !== id));
      return before;
    },
    onError: (err, _id, before) => {
      if (before) queryClient.setQueryData(key, before);
      Alert.alert(t("home.offers.declineError"), errorText(err));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.offers }),
  });

  const list = offers.data ?? [];
  if (!list.length) return null;
  const owner = byId.get(list[0]!.agentId);
  return (
    <Animated.View layout={LinearTransition} style={styles.section}>
      <Row style={styles.head}>
        {owner ? <CharacterAvatar agent={owner} size={18} /> : <Icon name="sparkles" size={13} color={c.textMuted} />}
        <T variant="eyebrow" muted numberOfLines={1} style={{ flexShrink: 1 }}>
          {owner ? t("home.offers.titleOwner", { name: owner.name }) : t("home.offers.title")}
        </T>
      </Row>
      <Card>
        {list.map((o, i) => (
          <Animated.View key={o.id} entering={FadeIn} exiting={FadeOut.duration(160)} layout={LinearTransition}>
            {i > 0 && <Hairline inset={space.lg} />}
            <OfferRow
              offer={o}
              pending={busy === o.id}
              disabled={busy !== null}
              onAccept={() => {
                tap();
                accept.mutate(o.id);
              }}
              onDismiss={() => {
                tap();
                dismiss.mutate(o.id);
              }}
            />
          </Animated.View>
        ))}
      </Card>
    </Animated.View>
  );
}

function OfferRow({ offer, pending, disabled, onAccept, onDismiss }: { offer: Offer; pending: boolean; disabled: boolean; onAccept: () => void; onDismiss: () => void }) {
  const c = useColors();
  const { t } = useTranslation("tabs");
  const [open, setOpen] = useState(false);
  const long = offer.prompt.length > LONG || offer.prompt.includes("\n");
  return (
    <View style={styles.row}>
      <View style={{ gap: 2 }}>
        <T variant="subhead" style={{ fontWeight: "600" }}>
          {offer.title}
        </T>
        {offer.why ? (
          <T variant="footnote" muted>
            {offer.why}
          </T>
        ) : null}
      </View>
      <Pressable
        disabled={!long}
        accessibilityRole={long ? "button" : undefined}
        accessibilityState={long ? { expanded: open } : undefined}
        onPress={() => setOpen((v) => !v)}
        style={[styles.prompt, { backgroundColor: c.sunken, borderLeftColor: c.borderStrong }]}
      >
        <T variant="footnote" numberOfLines={long && !open ? 2 : undefined}>
          {offer.prompt}
        </T>
      </Pressable>
      <Row style={{ gap: space.sm, justifyContent: "flex-end" }}>
        <Pressable
          accessibilityRole="button"
          disabled={disabled}
          hitSlop={6}
          onPress={onDismiss}
          style={({ pressed }) => [styles.action, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}
        >
          <T variant="footnote" muted style={{ fontWeight: "600" }}>
            {t("home.offers.decline")}
          </T>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("home.offers.accept")}
          accessibilityState={{ busy: pending, disabled }}
          disabled={disabled}
          onPress={onAccept}
          style={({ pressed }) => [styles.action, styles.accept, { backgroundColor: c.primary, opacity: disabled && !pending ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          <T variant="footnote" color={c.onPrimary} style={{ fontWeight: "600" }}>
            {t("home.offers.accept")}
          </T>
          {pending ? <ActivityIndicator size="small" color={c.onPrimary} /> : <Icon name="send" size={11} color={c.onPrimary} weight="bold" style={{ transform: [{ rotate: "90deg" }] }} />}
        </Pressable>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: space.sm,
  },
  head: {
    gap: space.sm,
    paddingHorizontal: 4,
    marginBottom: space.sm,
  },
  row: {
    gap: space.md,
    padding: space.lg,
  },
  prompt: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderLeftWidth: 2,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
  },
  accept: {
    paddingHorizontal: 14,
  },
});
