import type { Hono } from "hono";
import { body, z } from "../validate";
import { callSetup, getCall, importNumber, listCalls, ownerCallRefusal, placeCall } from "../../calls/calls";
import { callAudio } from "../../calls/elevenlabs";
import { HttpError } from "../../util";

const placeSchema = z.object({
  to: z.string().min(5).max(40),
  goal: z.string().min(1).max(2000),
  context: z.string().max(8000).optional(),
  contactName: z.string().max(120).optional(),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
});

const importSchema = z.object({
  number: z.string().min(5).max(40),
  label: z.string().max(100).optional(),
  sid: z.string().min(1).max(200),
  token: z.string().min(1).max(500),
});

export function registerCallRoutes(app: Hono): void {
  app.get("/api/calls", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    return c.json(listCalls({ limit: Number.isFinite(limit) ? limit : 100 }));
  });

  app.post("/api/calls", async (c) => {
    const input = await body(c, placeSchema);
    return c.json(await placeCall({ ...input, purpose: "task" }), 201);
  });

  app.get("/api/calls/setup", async (c) => c.json(await callSetup()));

  app.post("/api/calls/numbers", async (c) => {
    await importNumber(await body(c, importSchema));
    return c.json(await callSetup());
  });

  app.post("/api/calls/test", async (c) => {
    const refused = ownerCallRefusal();
    if (refused) throw new HttpError(409, `Can't call you: ${refused}`, "calls_refused");
    return c.json(
      await placeCall({
        to: "",
        purpose: "inform",
        goal: "This is a test call from Godmode, to check that calls reach you.",
        context: "Nothing else to tell. Say the test worked, ask whether they can hear you well, and say goodbye.",
      }),
      201,
    );
  });

  app.get("/api/calls/:id", (c) => c.json(getCall(c.req.param("id"))));

  app.get("/api/calls/:id/audio", async (c) => {
    const call = getCall(c.req.param("id"));
    if (!call.providerCallId || !call.hasAudio) throw new HttpError(404, "This call has no recording", "not_found");
    const res = await callAudio(call.providerCallId);
    return new Response(res.body, { headers: { "content-type": res.headers.get("content-type") ?? "audio/mpeg", "cache-control": "private, max-age=3600" } });
  });
}
