import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, Wifi } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { AndroidDevice } from "@godmode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toastApiError } from "@/components/vault/vault-utils";
import { api } from "@/lib/api";
import { qk } from "@/lib/queryKeys";

/** "192.168.1.20:37099" pasted into the address field: host and port. */
function splitAddress(text: string): { host: string; port?: number } {
  const m = text.trim().match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
  if (m && !m[1]!.includes(":")) return { host: m[1]!, port: Number(m[2]) };
  return { host: text.trim() };
}

/** Wireless debugging: pair once with the six-digit code (Android 11+), then connect to the address shown. */
export function ConnectWifiDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["android", "common"]);
  const qc = useQueryClient();
  const [mode, setMode] = useState<"pair" | "connect">("pair");
  const [address, setAddress] = useState("");
  const [pairing, setPairing] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setCode("");
  }, [open]);

  const connect = useMutation({
    mutationFn: () => {
      const target = splitAddress(address);
      const pair = splitAddress(pairing);
      return api.android.connect({
        host: target.host || pair.host,
        port: target.port,
        ...(mode === "pair" ? { pairingCode: code.trim(), pairingPort: pair.port } : {}),
      });
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: qk.android });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      toast.success(t("wifi.connected"), { description: res.message });
      onOpenChange(false);
    },
    onError: (e) => toastApiError(e, t("wifi.connectFailed"), qc),
  });

  const pairReady = mode === "connect" || (/^\d{6}$/.test(code.trim()) && !!splitAddress(pairing).port);
  const ready = !!splitAddress(address).host && !!splitAddress(address).port && pairReady;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready && !connect.isPending) connect.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t("wifi.title")}</DialogTitle>
            <DialogDescription>{t("wifi.description")}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as "pair" | "connect")} className="w-full">
              <ToggleGroupItem value="pair" className="flex-1">
                {t("wifi.firstTime")}
              </ToggleGroupItem>
              <ToggleGroupItem value="connect" className="flex-1">
                {t("wifi.pairedBefore")}
              </ToggleGroupItem>
            </ToggleGroup>

            {mode === "pair" && (
              <div className="grid gap-3 rounded-lg border bg-paper-2 p-3">
                <p className="text-xs text-muted-foreground">{t("wifi.pairHint")}</p>
                <div className="grid grid-cols-[1fr_8rem] gap-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="adb-pair-address">{t("wifi.address")}</Label>
                    <Input id="adb-pair-address" value={pairing} onChange={(e) => setPairing(e.target.value)} placeholder="192.168.1.20:37099" autoComplete="off" spellCheck={false} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="adb-pair-code">{t("wifi.pairingCode")}</Label>
                    <Input
                      id="adb-pair-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="123456"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      className="font-mono tracking-[0.2em]"
                    />
                  </div>
                </div>
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="adb-address">{t("wifi.address")}</Label>
              <Input id="adb-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.20:41235" autoComplete="off" spellCheck={false} />
              <p className="text-xs text-muted-foreground">{t("wifi.addressHint")}</p>
            </div>

            {error && <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!ready || connect.isPending}>
              {connect.isPending ? <Spinner className="size-3.5" /> : <Wifi />} {mode === "pair" ? t("wifi.pairAndConnect") : t("wifi.connect")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Name and description: what agents read about the phone. */
export function EditPhoneDialog({ device, onClose }: { device: AndroidDevice | null; onClose: () => void }) {
  const { t } = useTranslation(["android", "common"]);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (!device) return;
    setName(device.name);
    setDescription(device.description);
  }, [device]);

  const save = useMutation({
    mutationFn: () => api.android.update(device!.id, { name: name.trim(), description: description.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.android });
      onClose();
    },
    onError: (e) => toastApiError(e, t("edit.saveFailed"), qc),
  });

  return (
    <Dialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("edit.title")}</DialogTitle>
            <DialogDescription>{t("edit.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="phone-name">{t("common:words.name")}</Label>
              <Input id="phone-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="phone-description">{t("edit.whatFor")}</Label>
              <Textarea
                id="phone-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={4000}
                rows={3}
                placeholder={t("edit.placeholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common:actions.cancel")}
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending && <Spinner className="size-3.5" />} {t("common:actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ForgetPhoneDialog({ device, onClose }: { device: AndroidDevice | null; onClose: () => void }) {
  const { t } = useTranslation(["android", "common"]);
  const qc = useQueryClient();
  const users = device?.assignments.length ?? 0;
  const forget = useMutation({
    mutationFn: (d: AndroidDevice) => api.android.forget(d.id),
    onSuccess: (_r, d) => {
      void qc.invalidateQueries({ queryKey: qk.android });
      toast.success(t("forget.toast", { name: d.name }));
    },
    onError: (e) => toastApiError(e, t("forget.failed"), qc),
  });
  return (
    <AlertDialog open={!!device} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("forget.title", { name: device?.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("forget.body")}
            {users === 1 &&
              ` ${device?.assignments[0]?.name ? t("forget.oneUser", { name: device.assignments[0].name }) : t("forget.oneUserFallback")}`}
            {users > 1 && ` ${t("forget.manyUsers", { n: users })}`} {t("forget.rest")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (device) forget.mutate(device);
              onClose();
            }}
          >
            <Trash2 /> {t("forget.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
