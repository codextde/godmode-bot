import type { Hono } from "hono";
import { body, z } from "../validate";
import { exportBackup, importBackup, MAX_BACKUP_BYTES } from "../../backup/backup";
import { badRequest, HttpError } from "../../util";

const exportSchema = z.object({
  passphrase: z.string().min(8, "Backup passphrase must be at least 8 characters").max(1024),
  includeAgentRepos: z.boolean().optional().default(true),
  includeBrowserProfiles: z.boolean().optional().default(false),
});

const tooLarge = () => new HttpError(413, "The backup file is larger than 2 GB", "too_large");

export function registerBackupRoutes(app: Hono): void {
  app.post("/api/backup/export", async (c) => {
    const input = await body(c, exportSchema);
    const { data, filename } = await exportBackup(input);
    return new Response(new Blob([data as Uint8Array<ArrayBuffer>]), {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-length": String(data.byteLength),
        "cache-control": "no-store",
      },
    });
  });

  app.post("/api/backup/import", async (c) => {
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_BACKUP_BYTES + 1024 * 1024) throw tooLarge();
    if (!(c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      throw badRequest("Upload the backup as multipart/form-data with fields `file` and `passphrase`");
    }
    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      throw badRequest("Could not read the uploaded backup");
    }
    const file = form.get("file");
    const passphrase = form.get("passphrase");
    if (!(file instanceof Blob)) throw badRequest("Choose a backup file to restore");
    if (typeof passphrase !== "string" || !passphrase) throw badRequest("Enter the passphrase of the backup");
    if (file.size > MAX_BACKUP_BYTES) throw tooLarge();
    const data = new Uint8Array(await file.arrayBuffer());
    return c.json(await importBackup(data, passphrase));
  });
}
