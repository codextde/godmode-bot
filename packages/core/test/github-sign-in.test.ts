import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setSignInForTests, approveOnPage, ensureSignIn, githubLogin, signInEnd, type DevicePage, type DeviceState } from "../src/github/signIn";

const dirs: string[] = [];

/** A gh that fails `auth status` until the login ran; the login waits for the `approved` file. */
function fakeGh(opts: { loginExit?: number; noClipboardFlag?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  dirs.push(dir);
  const bin = join(dir, "gh");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "auth status")
    if [ -f "${dir}/signed-in" ]; then echo "  Logged in to github.com account new-account (keyring)"; exit 0; fi
    echo "  X Failed to log in to github.com account old-account (keyring)"; exit 1 ;;
  "auth setup-git") exit 0 ;;
  "auth login")
    ${opts.noClipboardFlag ? `case "$*" in *--clipboard*) echo "unknown flag: --clipboard" >&2; exit 1 ;; esac` : ""}
    echo "! First copy your one-time code: AB12-CD34" >&2
    i=0
    while [ ! -f "${dir}/approved" ] && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done
    if [ ${opts.loginExit ?? 0} = 0 ]; then touch "${dir}/signed-in"; fi
    exit ${opts.loginExit ?? 0} ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, approve: () => writeFileSync(join(dir, "approved"), ""), calls: () => readFileSync(join(dir, "calls"), "utf8") };
}

const blank: DeviceState = {
  host: "github.com",
  url: "https://github.com/login/device",
  boxes: 0,
  password: false,
  otp: false,
  success: false,
  codeRejected: false,
  authorize: null,
  authenticator: null,
  proceed: null,
  text: "",
};

/** Plays a list of page states; clicks and typing move on to the next one. */
function fakePage(states: Partial<DeviceState>[]) {
  const typed: string[] = [];
  const clicks: [number, number][] = [];
  let at = 0;
  const page: DevicePage = {
    send: async () => undefined,
    evaluate: async <T,>(expression: string) => (expression.includes(".focus()") && !expression.includes("codeRejected") ? (undefined as T) : ({ ...blank, ...states[at] } as T)),
    insertText: async (text) => void typed.push(text),
    click: async (x, y) => {
      clicks.push([x, y]);
      at = Math.min(at + 1, states.length - 1);
    },
  };
  return { page, typed, clicks };
}

afterEach(() => {
  __setSignInForTests(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the GitHub sign-in", () => {
  const fast = { pageMs: 300, stuckMs: 60, approvedMs: 3000, tickMs: 5 };

  test("reads the account from a broken login", async () => {
    __setSignInForTests({ gh: fakeGh().bin, timing: fast });
    expect(await githubLogin()).toEqual({ ok: false, account: "old-account", known: true });
  });

  test("runs gh with the printed code, then repairs git and reports the new account", async () => {
    const gh = fakeGh();
    __setSignInForTests({ gh: gh.bin, timing: fast });
    const flow = await ensureSignIn("run_1", "old-account");
    expect(flow?.code).toBe("AB12-CD34");
    gh.approve();
    expect(await signInEnd(flow!)).toEqual({ ok: true, account: "new-account" });
    expect(gh.calls()).toContain("--clipboard=false");
    expect(gh.calls()).toContain("auth setup-git --hostname github.com");
  });

  test("a gh without the clipboard flag still signs in", async () => {
    const gh = fakeGh({ noClipboardFlag: true });
    __setSignInForTests({ gh: gh.bin, timing: fast });
    const flow = await ensureSignIn("run_1", null);
    expect(flow?.code).toBe("AB12-CD34");
    gh.approve();
    expect((await signInEnd(flow!))?.ok).toBe(true);
  });

  test("a sign-in gh gave up on is a failure", async () => {
    const gh = fakeGh({ loginExit: 1 });
    __setSignInForTests({ gh: gh.bin, timing: fast });
    const flow = await ensureSignIn("run_1", null);
    gh.approve();
    expect((await signInEnd(flow!))?.ok).toBe(false);
  });

  test("one sign-in at a time: the same run keeps its own, another run waits", async () => {
    __setSignInForTests({ gh: fakeGh().bin, timing: fast });
    const flow = await ensureSignIn("run_1", null);
    expect(await ensureSignIn("run_1", null)).toBe(flow);
    expect(await ensureSignIn("run_2", null)).toBeNull();
  });

  test("the page: enters the code box by box, continues and authorizes once the button is enabled", async () => {
    __setSignInForTests({ timing: fast });
    const { page, typed, clicks } = fakePage([
      { boxes: 8, proceed: { x: 1, y: 1 } },
      { url: "https://github.com/login/device/select", authorize: { x: 2, y: 2, disabled: false } },
      { success: true },
    ]);
    expect(await approveOnPage(page, "AB12-CD34", () => false)).toEqual({ step: "approved" });
    expect(typed.join("")).toBe("AB12CD34");
    expect(clicks).toEqual([[1, 1], [2, 2]]);
  });

  test("the page: waits for a disabled Authorize instead of clicking it", async () => {
    __setSignInForTests({ timing: fast });
    const { page, clicks } = fakePage([{ authorize: { x: 2, y: 2, disabled: true } }]);
    expect((await approveOnPage(page, "AB12-CD34", () => false)).step).toBe("stuck");
    expect(clicks).toEqual([]);
  });

  test("the page: hands password and 2FA back to the agent, opening the authenticator form first", async () => {
    __setSignInForTests({ timing: fast });
    expect((await approveOnPage(fakePage([{ password: true }]).page, "AB12-CD34", () => false)).step).toBe("password");
    const { page, clicks } = fakePage([{ authenticator: { x: 3, y: 3 } }, { otp: true }]);
    expect((await approveOnPage(page, "AB12-CD34", () => false)).step).toBe("otp");
    expect(clicks).toEqual([[3, 3]]);
  });

  test("the page: never types the code anywhere but github.com", async () => {
    __setSignInForTests({ timing: fast });
    const { page, typed } = fakePage([{ host: "github.com.evil.example", boxes: 8 }]);
    expect((await approveOnPage(page, "AB12-CD34", () => false)).step).toBe("wrong-site");
    expect(typed).toEqual([]);
  });

  test("the page: a code GitHub keeps refusing isn't typed forever", async () => {
    __setSignInForTests({ timing: fast });
    const { page, typed } = fakePage([{ boxes: 8, codeRejected: true }]);
    expect((await approveOnPage(page, "AB12-CD34", () => false)).step).toBe("code-rejected");
    expect(typed).toEqual([]);
  });
});
