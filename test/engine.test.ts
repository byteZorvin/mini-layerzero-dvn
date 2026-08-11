import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { processRelayJob, runRelayPass } from "../src/engine";
import { MemoryStateStore } from "../src/store";
import type { RelayJob } from "../src/types";
import type { DirectionWorker } from "../src/workers";

const TX = `0x${"11".repeat(32)}` as Hex;
const TX2 = `0x${"22".repeat(32)}` as Hex;

function job(): RelayJob {
  return {
    id: `ethereum-to-starknet:0x${"aa".repeat(32)}`,
    direction: "ethereum-to-starknet",
    sourceTransactionHash: TX,
    sourceBlock: "10",
    packet: {
      version: 1,
      nonce: "1",
      srcEid: 40161,
      sender: `0x${"00".repeat(12)}1b94c5fcdbA4d2a3e9e6cb3f3684cbb6b846cf52`.toLowerCase() as Hex,
      dstEid: 40500,
      receiver: `0x${BigInt("0x3b6609179f6236ffb37e20658e8f69db9611d5c568d41fba8a156f7d18f371").toString(16).padStart(64, "0")}` as Hex,
      header: `0x${"00".repeat(81)}` as Hex,
      payloadHash: `0x${"aa".repeat(32)}` as Hex,
      guid: `0x${"bb".repeat(32)}` as Hex,
      message: "0x" as Hex,
    },
    confirmations: 1,
    phase: "discovered",
    attempts: 0,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

function worker(overrides: Partial<DirectionWorker> = {}): DirectionWorker {
  return {
    direction: "ethereum-to-starknet",
    initialCursor: 0n,
    discover: async (cursor) => ({ cursorAfter: cursor, matureTip: cursor, jobs: [] }),
    hydrate: async () => job(),
    reconcile: async () => "none",
    submitVerify: async () => TX2,
    submitCommit: async () => TX2,
    submitExecute: async () => TX2,
    confirm: async () => "confirmed",
    ...overrides,
  };
}

describe("relay job state machine", () => {
  test("persists a broadcast hash in a submitted phase", async () => {
    const store = new MemoryStateStore();
    const result = await processRelayJob(store, worker(), job());
    expect(result.phase).toBe("verify_submitted");
    expect(result.verifyTransactionHash).toBe(TX2);
    expect((await store.getJob(result.id))?.phase).toBe("verify_submitted");
  });

  test("leaves a receipt lookup failure submitted for reconciliation", async () => {
    const store = new MemoryStateStore();
    const pending = job();
    pending.phase = "verify_submitted";
    pending.verifyTransactionHash = TX2;
    const result = await processRelayJob(store, worker({ confirm: async () => { throw new Error("RPC timeout"); } }), pending);
    expect(result.phase).toBe("verify_submitted");
    expect(result.lastError).toBe("RPC timeout");
  });

  test("marks a reverted phase retryable", async () => {
    const store = new MemoryStateStore();
    const pending = job();
    pending.phase = "commit_submitted";
    pending.commitTransactionHash = TX2;
    const result = await processRelayJob(store, worker({ confirm: async () => "reverted" }), pending);
    expect(result.phase).toBe("failed");
    expect(result.failedAction).toBe("commit");
  });

  test("records externally completed delivery without submitting", async () => {
    const store = new MemoryStateStore();
    let submissions = 0;
    const result = await processRelayJob(store, worker({
      reconcile: async () => "executed",
      submitVerify: async () => { submissions += 1; return TX2; },
    }), job());
    expect(result.phase).toBe("executed");
    expect(result.completionSource).toBe("reconciled");
    expect(submissions).toBe(0);
  });
});

describe("relay pass lease and cursor safety", () => {
  const config = {
    enabled: true,
    namespace: "test",
    leaseTtlMs: 60_000,
    maxRunMs: 30_000,
    maxJobsPerDirection: 10,
    evmScanChunk: 2_000n,
    starknetScanChunk: 1_000n,
    starknetMaxPages: 20,
  };

  test("returns busy when another invocation owns the lease", async () => {
    const store = new MemoryStateStore();
    await store.acquireLease("other", 60_000);
    const result = await runRelayPass({
      config,
      store,
      workers: [worker()],
      funding: async () => ({
        ethereumWei: "1",
        starknetFri: "1",
        ethereumWarning: false,
        starknetWarning: false,
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(result.status).toBe("busy");
  });

  test("does not advance the cursor when durable job storage fails", async () => {
    class FailingStore extends MemoryStateStore {
      override async upsertJob(): Promise<void> { throw new Error("Redis unavailable"); }
    }
    const store = new FailingStore();
    const candidate = job();
    await runRelayPass({
      config,
      store,
      workers: [worker({
        discover: async () => ({ cursorAfter: 20n, matureTip: 20n, jobs: [candidate] }),
      })],
      funding: async () => ({
        ethereumWei: "1",
        starknetFri: "1",
        ethereumWarning: false,
        starknetWarning: false,
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(await store.getCursor("ethereum-to-starknet", 0n)).toBe(0n);
  });
});
