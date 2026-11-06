import { useQuery } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { usePathname, useRootNavigationState } from "expo-router";
import { useEffect, useRef } from "react";
import { api, ApiError } from "@/lib/api";
import { dismissFor, forgetPush, openFromNotification, refreshPush, setBadge, setOnScreen } from "@/lib/push";
import { qk } from "@/lib/query";

const OWN_SCREEN = /^\/(chat|task|human-task)\/[^/]+$/;

/** Push notifications on this phone: taps open their screen (from a cold start too), the badge counts what needs you. */
export function PushBridge({ paired }: { paired: boolean }) {
  const was = useRef(paired);
  useEffect(() => {
    if (was.current && !paired) void forgetPush();
    was.current = paired;
  }, [paired]);
  return paired ? <WhilePaired /> : null;
}

function WhilePaired() {
  const pathname = usePathname();
  // A tap that started the app waits until the screens are there to navigate to.
  const ready = !!useRootNavigationState()?.key;
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const push = me.data?.device.push === true;
  // Same query as lib/needs.ts useAttention, only while notifications are on.
  const count = useQuery({
    queryKey: qk.attention,
    queryFn: () => api.attention().catch((err: unknown) => (err instanceof ApiError && err.code === "device_forbidden" ? [] : Promise.reject(err))),
    enabled: push,
    select: (items) => items.length,
  }).data;

  useEffect(() => {
    setOnScreen(pathname);
    if (OWN_SCREEN.test(pathname)) void dismissFor(pathname);
  }, [pathname]);

  useEffect(() => {
    if (!ready) return;
    openFromNotification(Notifications.getLastNotificationResponse());
    const sub = Notifications.addNotificationResponseReceivedListener(openFromNotification);
    return () => sub.remove();
  }, [ready]);

  const refreshed = useRef(false);
  useEffect(() => {
    if (!push || refreshed.current) return;
    refreshed.current = true;
    void refreshPush().catch(() => undefined);
  }, [push]);

  useEffect(() => {
    if (push && count !== undefined) void setBadge(count);
  }, [push, count]);

  return null;
}
