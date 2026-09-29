import { describe, expect, test } from "bun:test";
import { browserUseConfig } from "../src/browser/browserUse";
import { judgeBotSignals, type BotHeaders, type BotSignals } from "../src/browser/botCheck";
import { headlessScreen, stealthArgs, windowedUserAgent, withoutHeadless } from "../src/browser/stealth";
import { DEFAULT_SETTINGS } from "../src/services/settings";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function signals(patch: Partial<BotSignals> = {}): BotSignals {
  return {
    webdriver: false,
    userAgent: UA,
    brands: [
      { brand: "Chromium", version: "154" },
      { brand: "Google Chrome", version: "154" },
      { brand: "Not A(Brand", version: "99" },
    ],
    fullVersionList: 3,
    languages: ["en-US", "en"],
    language: "en-US",
    plugins: 5,
    pdfViewer: true,
    chrome: true,
    notification: "default",
    notificationQuery: "prompt",
    webgl: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro, Unspecified Version)",
    window: { outerWidth: 1280, outerHeight: 900, innerWidth: 1280, innerHeight: 813 },
    screen: { width: 1920, height: 1080 },
    worker: { userAgent: UA, webdriver: false },
    ...patch,
  };
}

const HEADERS: BotHeaders = { userAgent: UA, secChUa: '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"', acceptLanguage: "en-US,en;q=0.9" };

function statuses(s: BotSignals, h: BotHeaders = HEADERS) {
  return Object.fromEntries(judgeBotSignals(s, h).map((c) => [c.id, c.status]));
}

describe("stealth launch", () => {
  test("a visible browser only hides the automation flag", () => {
    expect(stealthArgs({ headless: false, userAgent: UA })).toEqual(["--disable-blink-features=AutomationControlled"]);
  });

  test("headless gets the windowed user agent and a desktop screen", () => {
    const args = stealthArgs({ headless: true, userAgent: UA, platform: "darwin" });
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain(`--user-agent=${UA}`);
    expect(args).toContain("--screen-info={1920x1080 workAreaTop=25}");
    expect(stealthArgs({ headless: true, userAgent: null, platform: "linux" })).toEqual([
      "--disable-blink-features=AutomationControlled",
      "--screen-info={1920x1080}",
    ]);
    expect(headlessScreen("win32")).toBe("{1920x1080 workAreaBottom=48}");
  });

  test("drops only the Headless product (Edge keeps Edg/)", () => {
    expect(withoutHeadless(UA.replace("Chrome/", "HeadlessChrome/"))).toBe(UA);
    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0";
    expect(withoutHeadless(edge)).toBe(edge.replace("HeadlessChrome/", "Chrome/"));
  });

  test("learns the windowed user agent once per executable; failures aren't cached and never throw", async () => {
    let launches = 0;
    const ok = async () => {
      launches++;
      return { userAgent: UA.replace("Chrome/", "HeadlessChrome/"), kill: () => {}, exited: Promise.resolve(0) };
    };
    expect(await windowedUserAgent("/nonexistent/ok-chrome", ok)).toBe(UA);
    expect(await windowedUserAgent("/nonexistent/ok-chrome", ok)).toBe(UA);
    expect(launches).toBe(1);

    let failures = 0;
    const broken = async (): Promise<never> => {
      failures++;
      throw new Error("Chromium exited during startup");
    };
    expect(await windowedUserAgent("/nonexistent/broken-chrome", broken)).toBeNull();
    expect(await windowedUserAgent("/nonexistent/broken-chrome", broken)).toBeNull();
    expect(failures).toBe(2);
  });

  test("is on by default", () => {
    expect(DEFAULT_SETTINGS.browser.stealth).toBe(true);
  });

  test("browser-use doesn't emulate a viewport over a hardened headless browser", () => {
    const input = { configDir: "/cfg", cdpUrl: "http://127.0.0.1:9222", headless: true, userDataDir: "/data/p", downloadsPath: "/d", fileSystemPath: "/f" };
    const headless = (cfg: ReturnType<typeof browserUseConfig>) => Object.values(cfg.browser_profile)[0]!.headless;
    expect(headless(browserUseConfig({ ...input, stealth: true }, "id", "now"))).toBe(false);
    expect(headless(browserUseConfig(input, "id", "now"))).toBe(true);
  });
});

describe("bot check verdicts", () => {
  test("a regular Chrome passes everything", () => {
    const checks = judgeBotSignals(signals(), HEADERS);
    expect(checks).toHaveLength(10);
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
  });

  test("headless tells fail", () => {
    const headless = UA.replace("Chrome/", "HeadlessChrome/");
    expect(statuses(signals({ userAgent: headless, worker: { userAgent: headless, webdriver: false } })).userAgent).toBe("fail");
    expect(statuses(signals(), { ...HEADERS, userAgent: headless }).userAgent).toBe("fail");
    expect(statuses(signals({ webdriver: true })).webdriver).toBe("fail");
    expect(statuses(signals({ worker: { userAgent: UA, webdriver: true } })).webdriver).toBe("fail");
    expect(statuses(signals({ screen: { width: 800, height: 600 } })).window).toBe("fail");
    expect(statuses(signals({ window: { outerWidth: 1280, outerHeight: 900, innerWidth: 1920, innerHeight: 1080 } })).window).toBe("fail");
    expect(statuses(signals({ worker: { userAgent: UA.replace("Chrome/", "HeadlessChrome/"), webdriver: false } })).worker).toBe("fail");
    expect(statuses(signals({ notification: "denied", notificationQuery: "prompt" })).permissions).toBe("fail");
    expect(statuses(signals({ chrome: false })).chrome).toBe("fail");
  });

  test("client hints: missing or mismatched fail, withheld details warn", () => {
    expect(statuses(signals({ brands: null })).clientHints).toBe("fail");
    expect(statuses(signals(), { ...HEADERS, secChUa: null }).clientHints).toBe("fail");
    expect(statuses(signals({ brands: [{ brand: "Chromium", version: "150" }] })).clientHints).toBe("fail");
    expect(statuses(signals({ fullVersionList: 0 })).clientHints).toBe("warn");
  });

  test("softer signals only warn", () => {
    const s = statuses(signals({ webgl: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", plugins: 0, worker: null }), {
      ...HEADERS,
      acceptLanguage: "de-DE,de;q=0.9",
    });
    expect(s).toMatchObject({ webgl: "warn", plugins: "warn", worker: "warn", languages: "warn" });
  });
});
