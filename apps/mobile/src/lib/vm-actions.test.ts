import { beforeEach, describe, expect, test } from "bun:test";
import type { Vm } from "@godmode/shared";
import { phone } from "./test-natives.test";

const { api, ApiError } = await import("./api");
const { machinesApi } = await import("./machines");
const { duplicateVm, showVmMenu } = await import("./vm-actions");

const vm = { id: "vm_1", name: "Design Mac", state: "running" } as Vm;
const other = { id: "vm_other", name: "Other" } as Vm;
const copy = { id: "vm_2", name: "Design Mac copy" } as Vm;
const INTERRUPTS = "Restarting or stopping interrupts agents working in it.";

describe("a VM's actions", () => {
  beforeEach(() => {
    phone.reset();
    process.env.EXPO_OS = "ios";
  });

  test("the copy comes back from the computer", async () => {
    machinesApi.vms.duplicate = async () => copy;
    expect((await duplicateVm(vm, [vm])).id).toBe("vm_2");
    expect(phone.awake).toEqual(["on vm-duplicate-vm_1", "off vm-duplicate-vm_1"]);
  });

  test("a lost answer finds the copy in the list, a refused one doesn't look", async () => {
    machinesApi.vms.duplicate = () => Promise.reject(new ApiError(0, "No answer", "timeout"));
    api.vms.list = async () => [vm, other, copy];
    expect((await duplicateVm(vm, [vm, other])).id).toBe("vm_2");
    api.vms.list = async () => [vm];
    await expect(duplicateVm(vm, [vm])).rejects.toThrow("No answer");
    machinesApi.vms.duplicate = () => Promise.reject(new ApiError(409, "Stop it first", "conflict"));
    api.vms.list = () => Promise.reject(new Error("not asked"));
    await expect(duplicateVm(vm, [vm])).rejects.toThrow("Stop it first");
  });

  test("one action of a running VM still says what it interrupts", () => {
    showVmMenu(vm, undefined, "suspend");
    expect(phone.sheets[0]!.message).toBe(INTERRUPTS);
    expect(phone.sheets[0]!.options).toHaveLength(2);
    showVmMenu(vm);
    expect(phone.sheets[1]!.options).toHaveLength(4);
  });

  test("Android gets a way out next to a single action, and stays within three buttons in the full menu", () => {
    process.env.EXPO_OS = "android";
    showVmMenu(vm, undefined, "stop");
    expect(phone.alerts[0]!.message).toBe(INTERRUPTS);
    expect(phone.alerts[0]!.buttons!.map((b) => b.style)).toEqual(["cancel", "destructive"]);
    showVmMenu(vm);
    expect(phone.alerts[1]!.buttons).toHaveLength(3);
  });
});
