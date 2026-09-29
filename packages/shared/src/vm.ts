/**
 * macOS virtual machines: isolated macOS instances (Apple Virtualization.framework, run by Tart) that agents work in.
 * A VM is assigned to an agent, a chat or a workspace — a run uses its chat's VM, else its agent's, else its
 * workspace's. VM disks live in Godmode's data directory and are kept across restarts until the VM is deleted or reset;
 * every VM also has a shared folder on the host that the guest sees as a mounted volume.
 */
import type { ID, ISODate } from "./models";

/** Lifecycle of a VM. `creating` = its image is being downloaded or cloned (see `progress`). */
export type VmState = "creating" | "stopped" | "starting" | "running" | "suspended" | "stopping" | "error";

export interface VmProgress {
  phase: "download" | "clone" | "boot" | "setup";
  /** e.g. "Downloading macOS Tahoe (27.3 GB)" */
  label: string;
  /** 0–100, null = unknown. */
  percent: number | null;
}

/** What a VM is assigned to. */
export type VmAssignmentKind = "agent" | "conversation" | "workspace";

export interface VmAssignment {
  kind: VmAssignmentKind;
  id: ID;
  name: string;
}

export interface Vm {
  id: ID;
  name: string;
  /** Tart image the VM was created from (OCI reference, e.g. "ghcr.io/cirruslabs/macos-tahoe-base:latest"). */
  image: string;
  cpu: number;
  memoryMb: number;
  /** Size of the VM's disk in GB (it can only grow). */
  diskGb: number;
  /** Screen size in points, e.g. "1440x900". */
  display: string;
  state: VmState;
  progress: VmProgress | null;
  /** Last failure (creating, starting or setting up the VM). */
  error: string | null;
  /** Guest IP address while running. */
  ip: string | null;
  /** Folder on the host that is mounted in the guest (kept when the VM is reset). */
  sharedDir: string;
  /** Where the guest sees `sharedDir`. */
  guestSharedDir: string;
  /** Guest user account (the Godmode images log in automatically). */
  guestUser: string;
  /** Space the VM's disk takes on the host, in bytes (null = unknown). */
  diskUsageBytes: number | null;
  /** Agents, chats and workspaces that use this VM. */
  assignments: VmAssignment[];
  lastStartedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** A ready-made macOS image offered when creating a VM. */
export interface VmImagePreset {
  id: string;
  name: string;
  /** Tart image reference. */
  image: string;
  description: string;
  /** Approximate download size (compressed) in GB. */
  downloadGb: number;
  /** Size of the image's disk in GB. */
  diskGb: number;
  recommended: boolean;
  /** Already downloaded: new VMs from it are created in seconds. */
  downloaded: boolean;
}

/** GET /api/vms/status */
export interface VmStatus {
  /** VMs can run on this machine (a Mac with Apple silicon). */
  supported: boolean;
  /** Why not, when `supported` is false. */
  reason: string | null;
  tart: {
    installed: boolean;
    version: string | null;
    path: string | null;
    /** Installed by Godmode into its data directory (vs. found on the system). */
    managed: boolean;
    /** The version Godmode installs. */
    bundledVersion: string;
  };
  images: VmImagePreset[];
  /** macOS allows at most two macOS VMs to run at the same time on one Mac. */
  maxRunning: number;
  running: number;
  host: { cpus: number; memoryMb: number; freeDiskGb: number | null };
  /** Where VM disks and shared folders are stored. */
  storageDir: string;
  /** Background image downloads (image reference → percent, null = unknown). */
  downloads: Record<string, number | null>;
}

export interface VmInput {
  name: string;
  /** Image reference or preset id; default: the recommended preset. */
  image?: string;
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  display?: string;
  /** Start the VM once it is created. */
  start?: boolean;
}

export interface VmPatch {
  name?: string;
  /** CPU, memory and display changes apply on the next start. */
  cpu?: number;
  memoryMb?: number;
  diskGb?: number;
  display?: string;
}

/** POST /api/vms/:id/exec */
export interface VmExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** POST /api/vms/:id/assign */
export interface VmAssignInput {
  kind: VmAssignmentKind;
  id: ID;
  /** false = remove the assignment. */
  assigned: boolean;
}
