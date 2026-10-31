import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SshAssignmentKind, SshServer, SshTestResult } from "@godmode/shared";
import { copyText } from "@/components/chat/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** Why a test failed, for a toast: the host key mismatch gets a way out. */
export function testFailure(res: SshTestResult): string | undefined {
  if (res.hostKeyChanged) return t("ssh:toast.hostKeyChanged");
  return res.error ?? undefined;
}

/**
 * Test, forget host key, delete, copy public key and assignment for SSH servers — with toasts, and the answer patched
 * into the cached list right away (realtime `entity.changed` keeps it current afterwards).
 */
export function useSshActions() {
  const qc = useQueryClient();
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());

  const put = (server: SshServer) => {
    qc.setQueryData<SshServer[]>(qk.sshServers, (old) =>
      old ? (old.some((s) => s.id === server.id) ? old.map((s) => (s.id === server.id ? server : s)) : [...old, server]) : old,
    );
  };

  const test = useMutation({
    mutationFn: ({ server }: { server: SshServer; silent?: boolean }) => api.ssh.test(server.id),
    onMutate: ({ server }) => setTesting((s) => new Set(s).add(server.id)),
    onSuccess: (res, { server, silent }) => {
      if (silent) return;
      if (res.ok) {
        toast.success(t("ssh:toast.signedIn", { name: server.name }), {
          description: [res.latencyMs !== null ? `${res.latencyMs} ms` : null, res.os].filter(Boolean).join(" · ") || undefined,
        });
      } else toast.error(t("ssh:toast.signInFailed", { name: server.name }), { description: testFailure(res) });
    },
    onError: (e, { server, silent }) => {
      if (!silent) toastApiError(e, t("ssh:toast.testFailed", { name: server.name }), qc);
    },
    onSettled: (_res, _e, { server }) => {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(server.id);
        return next;
      });
      void qc.invalidateQueries({ queryKey: qk.sshServers });
    },
  });

  const forgetHostKey = useMutation({
    mutationFn: (server: SshServer) => api.ssh.update(server.id, { hostKey: null }),
    onSuccess: (next) => {
      put(next);
      toast.success(t("ssh:toast.hostKeyForgotten"), { description: t("ssh:toast.hostKeyForgottenDescription") });
    },
    onError: (e) => toastApiError(e, t("ssh:toast.forgetHostKeyFailed"), qc),
  });

  const remove = useMutation({
    mutationFn: (server: SshServer) => api.ssh.delete(server.id),
    onSuccess: (_res, server) => {
      qc.setQueryData<SshServer[]>(qk.sshServers, (old) => old?.filter((s) => s.id !== server.id));
      void qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(t("ssh:toast.deleted", { name: server.name }), { description: t("ssh:toast.deletedDescription") });
    },
    onError: (e, server) => toastApiError(e, t("ssh:toast.deleteFailed", { name: server.name }), qc),
  });

  const assign = useMutation({
    mutationFn: ({ server, kind, id, assigned }: { server: SshServer; kind: SshAssignmentKind; id: string; name: string; assigned: boolean }) =>
      api.ssh.assign(server.id, { kind, id, assigned }),
    onSuccess: (next, { kind, id, name, assigned }) => {
      put(next);
      void qc.invalidateQueries({ queryKey: kind === "agent" ? qk.agents : qk.conversation(id) });
      if (assigned)
        toast.success(t("ssh:toast.assigned", { name, server: next.name }), {
          description: kind === "agent" ? t("ssh:toast.assignedAgent") : t("ssh:toast.assignedChat"),
        });
      else
        toast.success(t("ssh:toast.unassigned", { name, server: next.name }), {
          description: kind === "agent" ? t("ssh:toast.unassignedAgent") : t("ssh:toast.unassignedChat"),
        });
    },
    onError: (e) => toastApiError(e, t("ssh:toast.assignFailed"), qc),
  });

  const copyPublicKey = async (server: SshServer) => {
    if (!server.key) return;
    if (await copyText(server.key.publicKey)) toast.success(t("ssh:toast.publicKeyCopied"), { description: t("ssh:toast.publicKeyCopiedDescription") });
    else toast.error(t("ssh:toast.copyPublicKeyFailed"));
  };

  return { test, testing, forgetHostKey, remove, assign, copyPublicKey, put };
}

export type SshActions = ReturnType<typeof useSshActions>;
