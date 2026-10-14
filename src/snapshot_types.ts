import type { ConsensusMessage } from "./consensus_messages.ts";
export type {
  SnapshotLifecycle,
  SnapshotOperationRecord,
  SnapshotRef,
  SnapshotRequest,
  SnapshotRestoreResult,
} from "../client/types.d.ts";
export { SnapshotOperationError } from "../client/mod.js";

export interface SavedState {
  schema: 2;
  nowMs: number;
  slot: number;
  headSlot: number;
  headBlockRoot: string;
  headStateRoot: string;
  executionBlockHash: string;
  executionBlockNumber: number;
  finalizedEpoch: number;
  finalizedRoot: string;
  replayMessages: ConsensusMessage[];
  databaseFiles: Record<"el" | "bn", FileInventory>;
  sharedFiles: Record<"metadata" | "jwt" | "validator-keys", FileInventory>;
}
export type FileInventory = Record<string, { hash: string; size: number }>;
export type CapturedState = Omit<SavedState, "databaseFiles" | "sharedFiles">;

export type { ControlError as SnapshotControlError } from "../client/types.d.ts";

/** Shared validation of the caller's durable operation identity. */
export function operationId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) {
    throw new Error("Snapshot operation requires a UUID operation ID");
  }
  return id;
}
