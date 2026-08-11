import type { Hex } from "viem";

export type Direction = "ethereum-to-starknet" | "starknet-to-ethereum";
export type RelayAction = "verify" | "commit" | "execute";
export type JobPhase =
  | "discovered"
  | "verify_submitted"
  | "verified"
  | "commit_submitted"
  | "committed"
  | "execute_submitted"
  | "executed"
  | "failed";

export interface StoredPacket {
  version: number;
  nonce: string;
  srcEid: number;
  sender: Hex;
  dstEid: number;
  receiver: Hex;
  header: Hex;
  payloadHash: Hex;
  guid: Hex;
  message: Hex;
}

export interface RelayJob {
  id: string;
  direction: Direction;
  sourceTransactionHash: Hex;
  sourceBlock: string;
  packet: StoredPacket;
  confirmations: number;
  phase: JobPhase;
  failedAction?: RelayAction;
  verifyTransactionHash?: Hex;
  commitTransactionHash?: Hex;
  executeTransactionHash?: Hex;
  completionSource?: "mini-dvn" | "reconciled";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface DirectionSummary {
  direction: Direction;
  cursorBefore: string;
  cursorAfter: string;
  matureTip: string;
  discovered: number;
  processed: number;
  executed: number;
  errors: number;
}

export interface FundingStatus {
  ethereumWei: string;
  starknetFri: string;
  ethereumWarning: boolean;
  starknetWarning: boolean;
  checkedAt: string;
}

export interface RunHealth {
  status: "running" | "ok" | "degraded";
  runId: string;
  startedAt: string;
  completedAt?: string;
  lastSuccessAt?: string;
  lastErrorCategory?: string;
  summaries?: DirectionSummary[];
  funding?: FundingStatus;
}

export interface RelayPassResult {
  status: "completed" | "busy" | "disabled";
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  summaries?: DirectionSummary[];
}
