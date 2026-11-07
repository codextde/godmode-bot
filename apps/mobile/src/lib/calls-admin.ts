import { useQuery } from "@tanstack/react-query";
import type { CallSetup, ImportCallNumberInput, OwnerPinStatus, PhoneCall } from "@godmode/shared";
import { request } from "./api";

/**
 * Phone calls set up like on the desktop (full-access phones only): the numbers and voices ElevenLabs has, a Twilio
 * number brought in, a test call, and the PIN that tells the owner apart on incoming calls. The PIN and the Twilio
 * token are write-only: the computer never sends them back.
 */
export const callsAdmin = {
  /** Asks ElevenLabs, so it can take a moment. */
  setup: () => request<CallSetup>("GET", "/api/calls/setup", undefined, 30_000),
  importNumber: (input: ImportCallNumberInput) => request<CallSetup>("POST", "/api/calls/numbers", input, 45_000),
  test: () => request<PhoneCall>("POST", "/api/calls/test", {}, 30_000),
  pin: () => request<OwnerPinStatus>("GET", "/api/calls/pin"),
  setPin: (pin: string) => request<OwnerPinStatus>("PUT", "/api/calls/pin", { pin }),
  removePin: () => request<OwnerPinStatus>("DELETE", "/api/calls/pin"),
};

/** The PIN's status is under ["calls"], so the computer's call events refresh it; the setup is asked for on its own. */
export const ck = {
  setup: ["call-setup"],
  pin: ["calls", "pin"],
} as const;

export const useCallSetup = (enabled = true) => useQuery({ queryKey: ck.setup, queryFn: callsAdmin.setup, staleTime: 60_000, retry: 1, enabled });
export const usePinStatus = (enabled = true) => useQuery({ queryKey: ck.pin, queryFn: callsAdmin.pin, enabled });
