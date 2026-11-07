import { useMutation, useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import type { Agent, Offer } from "@godmode/shared";
import { CharacterAvatar } from "./character";
import { Icon } from "./icon";
import { Card, Hairline, Row, T, tap } from "./ui";
import { api, ApiError, errorText } from "@/lib/api";
import { useAgents } from "@/lib/hooks";
import { qk, queryClient } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { radius, space, useColors } from "@/lib/theme";

/**
 * What the main agent offers to take off the human's plate, spotted while it dreamt: a line each on Home. "Do it" starts
 * the chat that does it; "No thanks" declines, and the next dream learns from both. Nothing shows on an older computer.
 */
export function OffersCard() {
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
  return (
    <Animated.View layout={LinearTransition}>
      <Card>
        {list.map((o, i) => (
          <Animated.View key={o.id} entering={FadeIn} exiting={FadeOut.duration(160)} layout={LinearTransition}>
            {i > 0 && <Hairline inset={space.lg} />}
            <OfferRow
              offer={o}
              owner={byId.get(o.agentId)}
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

/** One line: who offers what, No thanks and Do it. A tap shows why and the words it would start with. */
function OfferRow({ offer, owner, pending, disabled, onAccept, onDismiss }: { offer: Offer; owner?: Agent; pending: boolean; disabled: boolean; onAccept: () => void; onDismiss: () => void }) {
  const c = useColors();
  const { t } = useTranslation("tabs");
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Row style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${owner ? t("home.offers.titleOwner", { name: owner.name }) : t("home.offers.title")}: ${offer.title}`}
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((v) => !v)}
          style={({ pressed }) => [styles.main, { opacity: pressed ? 0.6 : 1 }]}
        >
          {owner ? <CharacterAvatar agent={owner} size={24} /> : <Icon name="sparkles" size={15} color={c.textMuted} />}
          <T variant="subhead" numberOfLines={open ? undefined : 1} style={{ flex: 1, fontWeight: "600" }}>
            {offer.title}
          </T>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("home.offers.decline")}
          disabled={disabled}
          hitSlop={8}
          onPress={onDismiss}
          style={({ pressed }) => [styles.decline, { opacity: disabled ? 0.4 : pressed ? 0.5 : 1 }]}
        >
          <Icon name="close" size={12} color={c.textMuted} weight="semibold" />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("home.offers.accept")}
          accessibilityState={{ busy: pending, disabled }}
          disabled={disabled}
          onPress={onAccept}
          style={({ pressed }) => [styles.accept, { backgroundColor: c.primary, opacity: disabled && !pending ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          {pending ? <ActivityIndicator size="small" color={c.onPrimary} /> : null}
          <T variant="footnote" color={c.onPrimary} style={{ fontWeight: "600" }}>
            {t("home.offers.accept")}
          </T>
        </Pressable>
      </Row>
      {open ? (
        <View style={styles.more}>
          {offer.why ? (
            <T variant="footnote" muted>
              {offer.why}
            </T>
          ) : null}
          <View style={[styles.prompt, { backgroundColor: c.sunken, borderLeftColor: c.borderStrong }]}>
            <T variant="footnote">{offer.prompt}</T>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.md,
    minHeight: 52,
  },
  main: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
  },
  decline: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  accept: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
  },
  more: {
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  prompt: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderCurve: "continuous",
    borderLeftWidth: 2,
  },
});
