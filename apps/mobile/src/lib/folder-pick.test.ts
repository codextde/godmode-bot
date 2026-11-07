import { describe, expect, test } from "bun:test";
import "./test-natives.test";

const { folderRequest, pickFolder, settleFolder } = await import("./folder-pick");

const first = { title: "First", action: "Use" };
const second = { title: "Second", action: "Use" };

describe("the folder sheet", () => {
  test("an old sheet leaving doesn't answer for the newer one", async () => {
    const old = pickFolder(first);
    const asked = folderRequest();
    const newer = pickFolder(second);
    expect(await old).toBeNull();

    settleFolder(null, asked);
    expect(folderRequest()).toBe(second);

    settleFolder("/srv/app", second);
    expect(await newer).toBe("/srv/app");
    expect(folderRequest()).toBeNull();
  });

  test("a sheet opened without a request settles nothing", async () => {
    const open = pickFolder(first);
    settleFolder(null, null);
    expect(folderRequest()).toBe(first);
    settleFolder(null);
    expect(await open).toBeNull();
  });
});
