import type { Hono } from "hono";
import type { ChatFiles } from "@godmode/shared";
import { MAX_CHAT_FILE_REFS } from "@godmode/shared";
import { readChatImage, readChatMarkdown, readChatText, resolveChatFiles, revealInFileManager } from "../../services/chatFiles";
import { HttpError, badRequest } from "../../util";
import { isLocalRequest } from "../auth";
import { body, z } from "../validate";

const refs = z.array(z.string().max(1024)).max(MAX_CHAT_FILE_REFS);
export const chatFilesBody = z.object({ messages: z.array(refs).max(200) });

export function registerFileRoutes(app: Hono): void {
  app.post("/api/conversations/:id/files", async (c) => {
    const { messages } = await body(c, chatFilesBody);
    return c.json<ChatFiles>({ local: isLocalRequest(c), files: resolveChatFiles(c.req.param("id"), messages) });
  });

  app.get("/api/files/image", (c) => {
    const path = c.req.query("path");
    if (!path) throw badRequest("path is required");
    const { mime, data } = readChatImage(path);
    return c.body(new Uint8Array(data), 200, {
      "Content-Type": mime,
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
  });

  app.get("/api/files/markdown", (c) => {
    const path = c.req.query("path");
    if (!path) throw badRequest("path is required");
    return c.body(readChatMarkdown(path), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
  });

  app.get("/api/files/text", (c) => {
    const path = c.req.query("path");
    if (!path) throw badRequest("path is required");
    return c.body(readChatText(path), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
  });

  // The file manager opens on the core's machine: no use, and nobody's business, from anywhere else.
  app.post("/api/files/reveal", async (c) => {
    const { path } = await body(c, z.object({ path: z.string().min(1).max(4096) }));
    if (!isLocalRequest(c)) throw new HttpError(403, "Files can only be shown on the computer Godmode runs on", "not_local");
    revealInFileManager(path);
    return c.json({ ok: true as const });
  });
}
