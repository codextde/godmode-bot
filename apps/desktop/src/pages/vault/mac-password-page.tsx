import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, EyeOff, HardDrive, Laptop, ShieldCheck, SquareTerminal, AppWindow } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MacPasswordStatus } from "@godmode/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, PageBody } from "@/components/common";
import { ConfirmDeleteDialog } from "@/components/vault/confirm-dialog";
import { PasswordInput } from "@/components/vault/password-input";
import { PasswordsHeader } from "@/components/vault/passwords-header";
import { toastApiError } from "@/components/vault/vault-utils";
import { useLocale } from "@/i18n/language";
import { api, errorMessage } from "@/lib/api";
import { useVaultStatus } from "@/lib/hooks";
import { qk } from "@/lib/queryKeys";
import { toast } from "sonner";

function Fact({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3 [&_svg]:size-4 [&_svg]:text-muted-foreground">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{title}</p>
        <p className="text-[13px] leading-snug text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export default function MacPasswordPage() {
  const { t } = useTranslation("vault");
  const qc = useQueryClient();
  const { dateLocale } = useLocale();
  const { data: vault } = useVaultStatus();
  const status = useQuery({ queryKey: qk.macPassword, queryFn: api.macPassword.status });
  const [password, setPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const store = (next: MacPasswordStatus) => qc.setQueryData(qk.macPassword, next);
  const save = useMutation({
    mutationFn: () => api.macPassword.save(password),
    onSuccess: (next) => {
      store(next);
      setPassword("");
      setChanging(false);
      setError(null);
      toast.success(t("macPasswordPage.savedToast"));
    },
    onError: (e) => {
      setPassword("");
      setError(errorMessage(e) || t("macPasswordPage.saveFailed"));
    },
  });
  const remove = useMutation({
    mutationFn: api.macPassword.remove,
    onSuccess: (next) => {
      store(next);
      setRemoving(false);
      toast.success(t("macPasswordPage.removedToast"));
    },
    onError: (e) => toastApiError(e, t("macPasswordPage.removeFailed"), qc),
  });

  const data = status.data;
  const locked = vault?.unlocked === false;
  const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true, locale: dateLocale });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password && !save.isPending) save.mutate();
  };

  return (
    <div className="relative">
      <PasswordsHeader />
      <PageBody className="max-w-2xl space-y-5">
        {status.isLoading ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : !data?.supported ? (
          <EmptyState icon={<Laptop />} title={t("macPasswordPage.title")} description={t("macPasswordPage.unsupported")} />
        ) : (
          <>
            <section className="rounded-xl border bg-card p-5">
              <div className="flex items-start gap-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-5">
                  {data.saved ? <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" /> : <Laptop className="text-muted-foreground" />}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-medium">{data.saved ? t("macPasswordPage.saved", { user: data.username }) : t("macPasswordPage.title")}</h2>
                  <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
                    {data.saved
                      ? data.lastUsedAt
                        ? t("macPasswordPage.lastUsed", { when: ago(data.lastUsedAt) })
                        : t("macPasswordPage.neverUsed")
                      : t("macPasswordPage.intro")}
                  </p>
                </div>
                {data.saved && !changing && (
                  <div className="flex shrink-0 gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
                      {t("macPasswordPage.change")}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" onClick={() => setRemoving(true)}>
                      {t("macPasswordPage.remove")}
                    </Button>
                  </div>
                )}
              </div>

              {(!data.saved || changing) && (
                <form onSubmit={submit} className="mt-4 space-y-2 border-t pt-4">
                  <Label htmlFor="mac-password">{data.username ? t("macPasswordPage.label", { user: data.username }) : t("macPasswordPage.labelGeneric")}</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <PasswordInput
                      id="mac-password"
                      groupClassName="min-w-56 flex-1"
                      autoFocus={changing}
                      autoComplete="off"
                      placeholder={t("macPasswordPage.placeholder")}
                      value={password}
                      disabled={save.isPending || locked}
                      aria-invalid={!!error}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError(null);
                      }}
                    />
                    <Button type="submit" className="h-10" disabled={!password || save.isPending || locked}>
                      {save.isPending ? (
                        <>
                          <Spinner /> {t("macPasswordPage.checking")}
                        </>
                      ) : (
                        t("macPasswordPage.save")
                      )}
                    </Button>
                    {changing && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-10"
                        onClick={() => {
                          setChanging(false);
                          setPassword("");
                          setError(null);
                        }}
                      >
                        {t("macPasswordPage.cancel")}
                      </Button>
                    )}
                  </div>
                  {error && <p className="text-[13px] text-destructive">{error}</p>}
                  {locked && <p className="text-[13px] text-muted-foreground">{t("macPasswordPage.locked")}</p>}
                </form>
              )}
            </section>

            <section className="grid gap-4 px-1 @2xl:grid-cols-3">
              <Fact icon={<ShieldCheck />} title={t("macPasswordPage.approveTitle")} body={t("macPasswordPage.approveBody")} />
              <Fact icon={<EyeOff />} title={t("macPasswordPage.hiddenTitle")} body={t("macPasswordPage.hiddenBody")} />
              <Fact icon={<HardDrive />} title={t("macPasswordPage.localTitle")} body={t("macPasswordPage.localBody")} />
            </section>

            {data.recent.length > 0 && (
              <section>
                <h3 className="mb-2 px-1 text-[13px] font-medium text-muted-foreground">{t("macPasswordPage.recent")}</h3>
                <ul className="divide-y rounded-xl border bg-card">
                  {data.recent.map((use) => (
                    <li key={`${use.at}${use.what}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
                      {use.kind === "run" ? <SquareTerminal /> : <AppWindow />}
                      <div className="min-w-0 flex-1">
                        {use.kind === "run" ? (
                          <p className="truncate font-mono text-[12px]" title={use.what}>
                            {use.what}
                          </p>
                        ) : (
                          <p className="truncate">{t("macPasswordPage.filledDialog", { what: use.what })}</p>
                        )}
                        <p className="text-[12px] text-muted-foreground">
                          {[use.agent, ago(use.at), use.ok ? null : t("macPasswordPage.failed")].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </PageBody>

      <ConfirmDeleteDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("macPasswordPage.removeTitle")}
        description={t("macPasswordPage.removeBody")}
        confirmLabel={t("macPasswordPage.remove")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
