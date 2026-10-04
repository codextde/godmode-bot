import type { Context, Hono } from "hono";
import { bus } from "../../events/bus";
import { audit } from "../../services/audit";
import { changeCloudSubscription, getCloudBilling } from "../../cloud/api";
import { cancelLinking, cloudStatus, startLinking, unlink, updateCloudSettings } from "../../cloud/link";
import { usageSummary } from "../../cloud/usage";
import { HttpError, badRequest } from "../../util";
import { isCloudChannel, requestCloudUser, requestDevice } from "../auth";
import { body, z } from "../validate";

const MANAGED_HERE = "Linking and access switches are managed on the computer itself.";

/** Linking and the access switches are only changed on the computer itself, never by a phone or through the cloud. */
function onlyComputer(c: Context) {
  if (requestDevice(c)) throw new HttpError(403, "The phone app can't do this. Use Godmode on your computer.", "device_forbidden");
  if (isCloudChannel(c)) throw new HttpError(403, MANAGED_HERE, "cloud_forbidden");
}

/** Reads the computer and, through the cloud, its owner may make. */
function computerOrOwner(c: Context) {
  if (requestDevice(c)) throw new HttpError(403, "The phone app can't do this. Use Godmode on your computer.", "device_forbidden");
  if (isCloudChannel(c) && requestCloudUser(c)?.role !== "owner") throw new HttpError(403, "Only the owner of this computer can see this.", "cloud_forbidden");
}

export function registerCloudRoutes(app: Hono) {
  app.get("/api/cloud", (c) => {
    computerOrOwner(c);
    return c.json(cloudStatus());
  });

  app.put("/api/cloud", async (c) => {
    onlyComputer(c);
    const input = await body(
      c,
      z
        .object({ enabled: z.boolean(), browserAccess: z.boolean(), phoneAccess: z.boolean(), allowSecrets: z.boolean() })
        .partial()
        .strict(),
    );
    return c.json(updateCloudSettings(input));
  });

  /** Start linking to the cloud at `url`: the answer carries the code and the page to approve it on. */
  app.post("/api/cloud/link", async (c) => {
    onlyComputer(c);
    const { url } = await body(c, z.object({ url: z.string().trim().min(1).max(2048) }));
    return c.json(await startLinking(url));
  });

  /** Cancel a pending link, or unlink. */
  app.delete("/api/cloud/link", (c) => {
    onlyComputer(c);
    const status = cloudStatus();
    if (status.state === "linking") {
      cancelLinking();
      return c.json(cloudStatus());
    }
    return c.json(unlink());
  });

  app.get("/api/cloud/billing", async (c) => {
    computerOrOwner(c);
    return c.json(await getCloudBilling());
  });

  /** Cancel at the end of the period, or resume: both can be undone. */
  for (const action of ["cancel", "resume"] as const) {
    app.post(`/api/cloud/billing/${action}`, async (c) => {
      onlyComputer(c);
      const billing = await changeCloudSubscription(action);
      audit("user", `cloud.subscription_${action}`);
      bus.changed("cloud");
      return c.json(billing);
    });
  }

  /** What the agents on this computer used (from its run history). */
  app.get("/api/usage", (c) => {
    const raw = c.req.query("days") ?? "30";
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest("days must be a whole number between 1 and 365");
    return c.json(usageSummary(days));
  });
}
