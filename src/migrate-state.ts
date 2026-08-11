import * as fs from "node:fs";
import { serviceConfig } from "./config";
import { RedisRestStore, type StateStore } from "./store";
import type { Direction, JobPhase, RelayAction, RelayJob } from "./types";
import { createDirectionWorkers, type DirectionWorker } from "./workers";

interface LegacyRecord {
  status: "verified" | "committed" | "executed" | "failed";
  sourceTransactionHash: string;
  verifyTransactionHash?: string;
  destinationTransactionHash?: string;
  commitTransactionHash?: string;
  executeTransactionHash?: string;
  error?: string;
  updatedAt?: string;
}

export interface LegacyState {
  lastScannedBlock: string;
  jobs: Record<string, LegacyRecord>;
}

export interface MigrationResult {
  direction: Direction;
  targetCursor: string;
  discovered: number;
  imported: number;
  unmatchedSourceTransactions: string[];
}

function readLegacy(filePath: string): LegacyState {
  const state = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyState;
  if (!state.lastScannedBlock || !state.jobs || typeof state.jobs !== "object") {
    throw new Error(`Invalid legacy state file ${filePath}`);
  }
  return state;
}

function failedAction(record: LegacyRecord): RelayAction {
  const verifyHash = record.verifyTransactionHash ?? record.destinationTransactionHash;
  if (!verifyHash) return "verify";
  if (!record.commitTransactionHash) return "commit";
  return "execute";
}

function legacyPhase(record: LegacyRecord): { phase: JobPhase; failedAction?: RelayAction } {
  if (record.status === "executed") return { phase: "executed" };
  if (record.status === "committed") return { phase: "committed" };
  if (record.status === "verified") return { phase: "verified" };
  return { phase: "failed", failedAction: failedAction(record) };
}

const PHASE_RANK: Record<JobPhase, number> = {
  discovered: 0,
  failed: 0,
  verify_submitted: 1,
  verified: 2,
  commit_submitted: 3,
  committed: 4,
  execute_submitted: 5,
  executed: 6,
};

function applyLegacy(candidate: RelayJob, record: LegacyRecord): RelayJob {
  const legacy = legacyPhase(record);
  return {
    ...candidate,
    phase: legacy.phase,
    failedAction: legacy.failedAction,
    verifyTransactionHash: (record.verifyTransactionHash ?? record.destinationTransactionHash) as RelayJob["verifyTransactionHash"],
    commitTransactionHash: record.commitTransactionHash as RelayJob["commitTransactionHash"],
    executeTransactionHash: record.executeTransactionHash as RelayJob["executeTransactionHash"],
    completionSource: legacy.phase === "executed" ? "mini-dvn" : undefined,
    attempts: 1,
    updatedAt: record.updatedAt ?? candidate.updatedAt,
    lastError: record.error,
  };
}

export async function migrateLegacyDirection(
  store: StateStore,
  worker: DirectionWorker,
  legacy: LegacyState,
): Promise<MigrationResult> {
  const targetCursor = BigInt(legacy.lastScannedBlock);
  let cursor = worker.initialCursor;
  let discovered = 0;
  let imported = 0;
  const matchedTransactions = new Set<string>();
  const legacyByTransaction = new Map(
    Object.values(legacy.jobs).map((record) => [record.sourceTransactionHash.toLowerCase(), record]),
  );

  while (cursor < targetCursor) {
    const discovery = await worker.discover(cursor, targetCursor, { skipIncompatible: true });
    if (discovery.cursorAfter <= cursor) {
      throw new Error(`Unable to reach legacy cursor ${targetCursor} for ${worker.direction}`);
    }
    for (const candidate of discovery.jobs) {
      discovered += 1;
      const legacyRecord = legacyByTransaction.get(candidate.sourceTransactionHash.toLowerCase());
      if (legacyRecord) matchedTransactions.add(candidate.sourceTransactionHash.toLowerCase());
      const importedJob = legacyRecord ? applyLegacy(candidate, legacyRecord) : candidate;
      const existing = await store.getJob(candidate.id);
      if (!existing || PHASE_RANK[importedJob.phase] > PHASE_RANK[existing.phase]) {
        await store.upsertJob(importedJob);
        if (legacyRecord) imported += 1;
      }
    }
    cursor = discovery.cursorAfter;
    await store.setCursor(worker.direction, cursor);
  }

  for (const [sourceTransactionHash, legacyRecord] of legacyByTransaction) {
    if (matchedTransactions.has(sourceTransactionHash)) continue;
    const candidate = await worker.hydrate(legacyRecord.sourceTransactionHash as `0x${string}`);
    const importedJob = applyLegacy(candidate, legacyRecord);
    const existing = await store.getJob(candidate.id);
    if (!existing || PHASE_RANK[importedJob.phase] > PHASE_RANK[existing.phase]) {
      await store.upsertJob(importedJob);
      imported += 1;
    }
    matchedTransactions.add(sourceTransactionHash);
  }

  const unmatchedSourceTransactions = [...legacyByTransaction.keys()].filter((hash) => !matchedTransactions.has(hash));
  return {
    direction: worker.direction,
    targetCursor: targetCursor.toString(),
    discovered,
    imported,
    unmatchedSourceTransactions,
  };
}

export async function migrateLegacyStates(forward: LegacyState, reverse: LegacyState): Promise<MigrationResult[]> {
  const config = serviceConfig();
  const store = new RedisRestStore(config.namespace);
  const { workers } = createDirectionWorkers();
  const states: Record<Direction, LegacyState> = {
    "ethereum-to-starknet": forward,
    "starknet-to-ethereum": reverse,
  };
  const results: MigrationResult[] = [];
  for (const worker of workers) {
    results.push(await migrateLegacyDirection(store, worker, states[worker.direction]));
  }
  await store.flushCommandEstimate();
  const unmatched = results.flatMap((result) => result.unmatchedSourceTransactions);
  if (unmatched.length > 0) {
    throw new Error(`Migration could not reconstruct ${unmatched.length} legacy job(s): ${unmatched.join(", ")}`);
  }
  return results;
}

export async function migrateLegacyState(forwardPath: string, reversePath: string): Promise<MigrationResult[]> {
  return migrateLegacyStates(readLegacy(forwardPath), readLegacy(reversePath));
}
