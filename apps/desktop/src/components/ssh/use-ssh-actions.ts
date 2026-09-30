import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { SshAssignmentKind, SshServer, SshTestResult } from "@godmode/shared";
import { copyText } from "@/components/chat/copy-button";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** Why a test failed, for a toast: the host key mismatch gets a way out. */
export function testFailure(res: SshTestResult): string | undefined {
  if (res.hostKeyChanged) return "The server presented a different host key than the pinned one. If it was reinstalled, forget the host key (⋯ menu) and test again.";
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
        toast.success(`Signed in to ${server.name}`, {
          description: [res.latencyMs !== null ? `${res.latencyMs} ms` : null, res.os].filter(Boolean).join(" · ") || undefined,
        });
      } else toast.error(`Couldn't sign in to ${server.name}`, { description: testFailure(res) });
    },
    onError: (e, { server, silent }) => {
      if (!silent) toastApiError(e, `Couldn't test “${server.name}”`, qc);
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
      toast.success("Host key forgotten", { description: "The next connection pins the key the server presents." });
    },
    onError: (e) => toastApiError(e, "Couldn't forget the host key", qc),
  });

  const remove = useMutation({
    mutationFn: (server: SshServer) => api.ssh.delete(server.id),
    onSuccess: (_res, server) => {
      qc.setQueryData<SshServer[]>(qk.sshServers, (old) => old?.filter((s) => s.id !== server.id));
      void qc.invalidateQueries({ queryKey: qk.agents });
      toast.success(`${server.name} deleted`, { description: "Its saved password and key were removed from the vault." });
    },
    onError: (e, server) => toastApiError(e, `Couldn't delete “${server.name}”`, qc),
  });

  const assign = useMutation({
    mutationFn: ({ server, kind, id, assigned }: { server: SshServer; kind: SshAssignmentKind; id: string; name: string; assigned: boolean }) =>
      api.ssh.assign(server.id, { kind, id, assigned }),
    onSuccess: (next, { kind, id, name, assigned }) => {
      put(next);
      void qc.invalidateQueries({ queryKey: kind === "agent" ? qk.agents : qk.conversation(id) });
      if (assigned)
        toast.success(`${name} can use ${next.name}`, {
          description: kind === "agent" ? "Every run of the agent can sign in to it." : "Runs in the chat can sign in to it.",
        });
      else
        toast.success(`${name} no longer uses ${next.name}`, {
          description: kind === "agent" ? "Chats that picked the server themselves keep it." : "Runs in the chat can't sign in to it anymore, unless its agent has it.",
        });
    },
    onError: (e) => toastApiError(e, "Couldn't change the assignment", qc),
  });

  const copyPublicKey = async (server: SshServer) => {
    if (!server.key) return;
    if (await copyText(server.key.publicKey)) toast.success("Public key copied", { description: "Add it to ~/.ssh/authorized_keys on the server." });
    else toast.error("Couldn't copy the public key");
  };

  return { test, testing, forgetHostKey, remove, assign, copyPublicKey, put };
}

export type SshActions = ReturnType<typeof useSshActions>;
