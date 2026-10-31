import type { Hono } from "hono";
import {
  cancelAccountLogin,
  claudeAccountsState,
  refreshClaudeUsage,
  removeClaudeAccount,
  setDefaultClaudeAccount,
  startAccountLogin,
  submitAccountLoginCode,
} from "../../services/claudeAccounts";
import { body, z } from "../validate";

/** Claude accounts: the list with usage, signing accounts in, the default, removing. */
export function registerClaudeAccountRoutes(app: Hono): void {
  app.get("/api/claude-accounts", (c) => c.json(claudeAccountsState()));
  app.post("/api/claude-accounts/refresh", async (c) => {
    await refreshClaudeUsage();
    return c.json(claudeAccountsState());
  });
  app.post("/api/claude-accounts/login", async (c) => {
    const { accountId } = await body(c, z.object({ accountId: z.string().trim().min(1).max(100).nullable().optional() }));
    return c.json(startAccountLogin(accountId ?? null));
  });
  app.post("/api/claude-accounts/login/code", async (c) => {
    const { code } = await body(c, z.object({ code: z.string().min(1).max(2000) }));
    return c.json(submitAccountLoginCode(code));
  });
  app.delete("/api/claude-accounts/login", (c) => c.json(cancelAccountLogin()));
  app.post("/api/claude-accounts/:id/default", (c) => c.json(setDefaultClaudeAccount(c.req.param("id"))));
  app.delete("/api/claude-accounts/:id", (c) => c.json(removeClaudeAccount(c.req.param("id"))));
}
