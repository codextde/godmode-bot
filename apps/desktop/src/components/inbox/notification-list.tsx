import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Bell, BellOff, Bot, CheckCheck, ChevronRight, CircleCheck, CircleX, Info, KeyRound, MessageCircleQuestion, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type { AppNotification, NotificationKind } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toastApiError } from "@/components/vault/vault-utils";
import { api, errorMessage } from "@/lib/api";
import { qk } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<NotificationKind, { icon: typeof Info; className: string }> = {
  info: { icon: Info, className: "border bg-card text-muted-foreground shadow-card" },
  success: { icon: CircleCheck, className: "bg-success/10 text-success" },
  warning: { icon: TriangleAlert, className: "bg-warning/12 text-warning" },
  error: { icon: CircleX, className: "bg-destructive/10 text-destructive" },
  missing_login: { icon: KeyRound, className: "bg-warning/12 text-warning" },
  run: { icon: Bot, className: "border bg-card text-foreground shadow-card" },
  question: { icon: MessageCircleQuestion, className: "bg-warning/12 text-warning" },
};

const PAGE = 30;

export function NotificationList({ className }: { className?: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [limit, setLimit] = useState(PAGE);
  const query = useQuery({ queryKey: qk.notifications, queryFn: api.notifications.list });
  const items = query.data ?? [];
  const unread = items.filter((n) => !n.read).length;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: qk.notifications });
    void qc.invalidateQueries({ queryKey: qk.bootstrap });
  };

  const markRead = useMutation({
    mutationFn: (ids: string[] | "all") => api.notifications.read(ids),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.notifications });
      const previous = qc.getQueryData<AppNotification[]>(qk.notifications);
      qc.setQueryData<AppNotification[]>(qk.notifications, (list) =>
        list?.map((n) => (ids === "all" || ids.includes(n.id) ? { ...n, read: true } : n)),
      );
      return { previous };
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.notifications, ctx.previous);
      toastApiError(e, "Could not mark as read", qc);
    },
    onSettled: invalidate,
  });

  const clear = useMutation({
    mutationFn: api.notifications.clear,
    onSuccess: () => {
      qc.setQueryData<AppNotification[]>(qk.notifications, []);
      toast.success("Notifications cleared");
    },
    onError: (e) => toastApiError(e, "Could not clear notifications", qc),
    onSettled: invalidate,
  });

  const open = (n: AppNotification) => {
    if (!n.read) markRead.mutate([n.id]);
    if (n.link) navigate(n.link);
  };

  return (
    <section className={cn("overflow-hidden rounded-xl border bg-card shadow-card", className)} aria-labelledby="notifications-title">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Bell className="size-4 text-muted-foreground" />
        <h2 id="notifications-title" className="text-sm font-medium">
          Notifications
        </h2>
        {unread > 0 && <span className="rounded-[5px] border bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-foreground tabular-nums">{unread} new</span>}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Mark all read" disabled={!unread || markRead.isPending} onClick={() => markRead.mutate("all")}>
                <CheckCheck />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Mark all read</TooltipContent>
          </Tooltip>
          <AlertDialog>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Clear notifications" disabled={!items.length || clear.isPending}>
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
              </TooltipTrigger>
              <TooltipContent>Clear all</TooltipContent>
            </Tooltip>
            <AlertDialogContent className="rounded-2xl">
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all notifications?</AlertDialogTitle>
                <AlertDialogDescription>This removes {items.length} notification{items.length === 1 ? "" : "s"}. Agent runs and their results are not affected.</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => clear.mutate()}>
                  Clear all
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {query.isLoading ? (
        <div className="space-y-1 p-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-lg" />
          ))}
        </div>
      ) : query.isError ? (
        <div className="p-6 text-center text-sm">
          <p className="font-medium">Couldn't load notifications</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(query.error)}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => query.refetch()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <div className="grid size-10 place-items-center rounded-lg border bg-card text-foreground shadow-card">
            <BellOff className="size-5" />
          </div>
          <p className="mt-3 text-sm font-medium">No notifications</p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">Agents post updates here when they finish work, need something, or hit a problem.</p>
        </div>
      ) : (
        <ul className="divide-y">
          <AnimatePresence initial={false}>
            {items.slice(0, limit).map((n, i) => (
              <motion.li
                key={n.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ delay: Math.min(i, 12) * 0.03 }}
              >
                <NotificationRow n={n} onOpen={() => open(n)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      {items.length > limit && (
        <div className="border-t p-2">
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => setLimit((l) => l + PAGE)}>
            Show {Math.min(PAGE, items.length - limit)} more
          </Button>
        </div>
      )}
    </section>
  );
}

function NotificationRow({ n, onOpen }: { n: AppNotification; onOpen: () => void }) {
  const meta = KIND_ICON[n.kind] ?? KIND_ICON.info;
  const Icon = meta.icon;
  const when = (() => {
    try {
      return formatDistanceToNow(new Date(n.createdAt), { addSuffix: true });
    } catch {
      return "";
    }
  })();
  const interactive = !!n.link || !n.read;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!interactive}
      className={cn(
        "group flex w-full items-start gap-3 px-4 py-3 text-left transition outline-none disabled:cursor-default",
        interactive && "hover:bg-accent/40 focus-visible:bg-accent/50",
        !n.read && "bg-paper-2/70",
      )}
      aria-label={`${n.read ? "" : "Unread: "}${n.title}`}
    >
      <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg", meta.className)}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-sm", n.read ? "text-foreground/80" : "font-medium text-foreground")}>{n.title}</span>
          {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-brand" aria-hidden />}
        </span>
        {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
        <span className="mt-1 block text-[11px] text-muted-foreground/80">{when}</span>
      </span>
      {n.link && <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />}
    </button>
  );
}
