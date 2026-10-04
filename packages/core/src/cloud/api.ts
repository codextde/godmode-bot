/**
 * HTTP calls to the cloud: the link API (before this computer has a device id) and the device API (billing, unlink).
 * 10 s timeout, no redirects (the bearer token must not follow one), and errors are sentences a person can act on.
 */
import { CLOUD_DEVICE_API_PATH, cloudBearer, type CloudBilling } from "@godmode/shared";
import { HttpError } from "../util";
import { loadLink, readLinkSecret } from "./state";

const TIMEOUT_MS = 10_000;

export function cloudHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface CloudRequest {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  bearer?: string;
  /** What to say when the cloud can't be reached. */
  unreachable?: string;
}

export async function cloudRequest<T>(base: string, path: string, req: CloudRequest): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (req.body !== undefined) headers["content-type"] = "application/json";
  if (req.bearer) headers.authorization = `Bearer ${req.bearer}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new HttpError(502, req.unreachable ?? "Godmode Cloud can't be reached right now. Try again in a moment.", "cloud_unreachable");
  }
  const text = await res.text().catch(() => "");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const error = (data as { error?: unknown } | null)?.error;
    throw new HttpError(502, typeof error === "string" && error ? error.slice(0, 300) : `Godmode Cloud answered with an error (HTTP ${res.status}).`, "cloud_error");
  }
  if (!data || typeof data !== "object") throw new HttpError(502, "Godmode Cloud sent an answer this Godmode can't read.", "cloud_error");
  return data as T;
}

function linkedDevice(): { url: string; bearer: string } {
  const link = loadLink();
  const secret = readLinkSecret();
  if (!link || !secret) throw new HttpError(409, "This computer isn't linked to Godmode Cloud.", "not_linked");
  if (link.revoked) throw new HttpError(409, "Godmode Cloud no longer knows this computer. Link it again under Settings → Cloud.", "not_linked");
  return { url: link.url, bearer: cloudBearer(link.deviceId, secret) };
}

export function getCloudBilling(): Promise<CloudBilling> {
  const d = linkedDevice();
  return cloudRequest<CloudBilling>(d.url, `${CLOUD_DEVICE_API_PATH}/billing`, { method: "GET", bearer: d.bearer });
}

/** Cancel (at the end of the period) or resume the account's subscription; both can be undone. */
export function changeCloudSubscription(action: "cancel" | "resume"): Promise<CloudBilling> {
  const d = linkedDevice();
  return cloudRequest<CloudBilling>(d.url, `${CLOUD_DEVICE_API_PATH}/billing/${action}`, { method: "POST", bearer: d.bearer });
}

/** Tell the cloud this computer unlinked itself. */
export async function deleteCloudDevice(url: string, deviceId: string, secret: string): Promise<void> {
  await cloudRequest(url, `${CLOUD_DEVICE_API_PATH}/self`, { method: "DELETE", bearer: cloudBearer(deviceId, secret) });
}
