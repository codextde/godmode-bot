import type { Context, Hono } from "hono";
import type { ClaudeAccountsState } from "@godmode/shared";
import {
  cancelAccountLogin,
  claudeAccountsState,
  refreshClaudeUsage,
  removeClaudeAccount,
  setDefaultClaudeAccount,
  startAccountLogin,
  submitAccountLoginCode,
} from "../../services/claudeAccounts";
import { isPhoneRequest } from "../auth";
import { body, z } from "../validate";

/** A phone sees the accounts, never a sign-in link: signing in happens on the computer. */
const forPhone = (c: Context, state: ClaudeAccountsState): ClaudeAccountsState => (isPhoneRequest(c) ? { ...state, login: { ...state.login, url: null } } : state);

/** Claude accounts: the list with usage, signing accounts in, the default, removing. */
export function registerClaudeAccountRoutes(app: Hono): void {
  app.get("/api/claude-accounts", (c) => c.json(forPhone(c, claudeAccountsState())));
  app.post("/api/claude-accounts/refresh", async (c) => {
    await refreshClaudeUsage();
    return c.json(forPhone(c, claudeAccountsState()));
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
