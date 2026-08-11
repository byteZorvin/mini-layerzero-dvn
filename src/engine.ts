import { serviceConfig, type ServiceConfig } from "./config";
import { RedisRestStore, type StateStore } from "./store";
import type {
  DirectionSummary,
  FundingStatus,
  RelayAction,
  RelayJob,
  RelayPassResult,
  RunHealth,
} from "./types";
import { createDirectionWorkers, type DirectionWorker } from "./workers";

type FundingReader = () => Promise<FundingStatus>;

export interface EngineOptions {
  config?: ServiceConfig;
  store?: StateStore;
  workers?: DirectionWorker[];
  funding?: FundingReader;
  now?: () => Date;
  runId?: string;
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/0x[0-9a-fA-F]{64}/g, (value) => value.length === 66 ? value : "[redacted-hex]")
    .slice(0, 500);
}

export function errorCategory(error: unknown): string {
  const message = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
  if (message.includes("redis")) return "redis";
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("nonce")) return "nonce";
  if (message.includes("revert")) return "transaction_reverted";
  if (message.includes("rpc") || message.includes("http")) return "rpc";
  if (message.includes("balance") || message.includes("fund")) return "funding";
  if (message.includes("config") || message.includes("runtime value") || message.includes("signer")) return "configuration";
  return "relay";
}

function submittedAction(job: RelayJob): RelayAction | undefined {
  if (job.phase === "verify_submitted") return "verify";
  if (job.phase === "commit_submitted") return "commit";
  if (job.phase === "execute_submitted") return "execute";
  return undefined;
}

function hashFor(job: RelayJob, action: RelayAction) {
  if (action === "verify") return job.verifyTransactionHash;
  if (action === "commit") return job.commitTransactionHash;
  return job.executeTransactionHash;
}

function confirmedPhase(action: RelayAction) {
  return action === "verify" ? "verified" as const : action === "commit" ? "committed" as const : "executed" as const;
}

function submittedPhase(action: RelayAction) {
  return action === "verify"
    ? "verify_submitted" as const
    : action === "commit"
      ? "commit_submitted" as const
      : "execute_submitted" as const;
}

function nextAction(job: RelayJob): RelayAction | undefined {
  if (job.phase === "failed") return job.failedAction;
  if (job.phase === "discovered") return "verify";
  if (job.phase === "verified") return "commit";
  if (job.phase === "committed") return "execute";
  return undefined;
}

async function persist(store: StateStore, job: RelayJob, now: () => Date): Promise<void> {
  job.updatedAt = timestamp(now);
  await store.upsertJob(job);
}

export async function processRelayJob(
  store: StateStore,
  worker: DirectionWorker,
  job: RelayJob,
  now: () => Date = () => new Date(),
): Promise<RelayJob> {
  try {
    const reconciled = await worker.reconcile(job);
    if (reconciled === "executed") {
      job.phase = "executed";
      job.completionSource = job.executeTransactionHash ? "mini-dvn" : "reconciled";
      job.failedAction = undefined;
      job.lastError = undefined;
      await persist(store, job, now);
      return job;
    }
    if (reconciled === "committed" && job.phase !== "execute_submitted") {
      job.phase = "committed";
      job.failedAction = undefined;
      job.lastError = undefined;
      await persist(store, job, now);
    }

    const pendingAction = submittedAction(job);
    if (pendingAction) {
      const transactionHash = hashFor(job, pendingAction);
      if (!transactionHash) throw new Error(`${pendingAction} submitted without a transaction hash`);
      const confirmation = await worker.confirm(transactionHash);
      if (confirmation === "pending") return job;
      if (confirmation === "reverted") {
        job.phase = "failed";
        job.failedAction = pendingAction;
        job.lastError = `${pendingAction} transaction reverted`;
        await persist(store, job, now);
        return job;
      }
      job.phase = confirmedPhase(pendingAction);
      job.failedAction = undefined;
      job.lastError = undefined;
      if (job.phase === "executed") job.completionSource = "mini-dvn";
      await persist(store, job, now);
      if (job.phase === "executed") return job;
    }

    const action = nextAction(job);
    if (!action) return job;
    job.attempts += 1;
    const transactionHash = action === "verify"
      ? await worker.submitVerify(job)
      : action === "commit"
        ? await worker.submitCommit(job)
        : await worker.submitExecute(job);
    if (action === "verify") job.verifyTransactionHash = transactionHash;
    else if (action === "commit") job.commitTransactionHash = transactionHash;
    else job.executeTransactionHash = transactionHash;
    job.phase = submittedPhase(action);
    job.failedAction = undefined;
    job.lastError = undefined;
    await persist(store, job, now);
    return job;
  } catch (error) {
    const action = submittedAction(job) ?? nextAction(job);
    // A receipt lookup failure leaves a submitted transaction pending so the next pass reconciles it.
    if (!submittedAction(job)) {
      job.phase = "failed";
      job.failedAction = action;
    }
    job.lastError = sanitizeError(error);
    await persist(store, job, now);
    return job;
  }
}

export async function runRelayPass(options: EngineOptions = {}): Promise<RelayPassResult> {
  const config = options.config ?? serviceConfig();
  if (!config.enabled) return { status: "disabled" };

  const store = options.store ?? new RedisRestStore(config.namespace);
  const runtime = options.workers && options.funding
    ? { workers: options.workers, funding: options.funding }
    : createDirectionWorkers();
  const workers = options.workers ?? runtime.workers;
  const funding = options.funding ?? runtime.funding;
  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? crypto.randomUUID();
  const leaseToken = crypto.randomUUID();
  const startedAt = timestamp(now);

  if (!await store.acquireLease(leaseToken, config.leaseTtlMs)) return { status: "busy" };

  const previousHealth = await store.getHealth();
  let health: RunHealth = {
    status: "running",
    runId,
    startedAt,
    lastSuccessAt: previousHealth?.lastSuccessAt,
    funding: previousHealth?.funding,
  };
  await store.setHealth(health);
  const summaries: DirectionSummary[] = [];
  let firstErrorCategory: string | undefined;
  const deadline = Date.now() + config.maxRunMs;

  try {
    for (const worker of workers) {
      const cursorBefore = await store.getCursor(worker.direction, worker.initialCursor);
      let cursorAfter = cursorBefore;
      let matureTip = cursorBefore;
      let discovered = 0;
      let processed = 0;
      let executed = 0;
      let errors = 0;
      try {
        const discovery = await worker.discover(cursorBefore);
        cursorAfter = discovery.cursorAfter;
        matureTip = discovery.matureTip;
        for (const candidate of discovery.jobs) {
          const existing = await store.getJob(candidate.id);
          if (!existing) {
            await store.upsertJob(candidate);
            discovered += 1;
          } else if (
            existing.sourceTransactionHash.toLowerCase() !== candidate.sourceTransactionHash.toLowerCase() ||
            existing.packet.header.toLowerCase() !== candidate.packet.header.toLowerCase()
          ) {
            throw new Error(`Conflicting immutable data for job ${candidate.id}`);
          }
        }
        // The cursor moves only after every discovered job is durable.
        if (cursorAfter !== cursorBefore) await store.setCursor(worker.direction, cursorAfter);

        const pending = await store.listPending(worker.direction, config.maxJobsPerDirection);
        for (const job of pending) {
          if (Date.now() >= deadline) break;
          const result = await processRelayJob(store, worker, job, now);
          processed += 1;
          if (result.phase === "executed") executed += 1;
          if (result.phase === "failed") {
            errors += 1;
            firstErrorCategory ??= errorCategory(result.lastError ?? "relay failed");
          }
        }
      } catch (error) {
        errors += 1;
        firstErrorCategory ??= errorCategory(error);
      }
      summaries.push({
        direction: worker.direction,
        cursorBefore: cursorBefore.toString(),
        cursorAfter: cursorAfter.toString(),
        matureTip: matureTip.toString(),
        discovered,
        processed,
        executed,
        errors,
      });
    }

    try {
      health.funding = await funding();
      if (health.funding.ethereumWarning || health.funding.starknetWarning) {
        firstErrorCategory ??= "funding";
      }
    } catch (error) {
      firstErrorCategory ??= errorCategory(error);
    }

    const completedAt = timestamp(now);
    health = {
      ...health,
      status: firstErrorCategory ? "degraded" : "ok",
      completedAt,
      lastSuccessAt: firstErrorCategory ? health.lastSuccessAt : completedAt,
      lastErrorCategory: firstErrorCategory,
      summaries,
    };
    await store.setHealth(health);
    return { status: "completed", runId, startedAt, completedAt, summaries };
  } catch (error) {
    health = {
      ...health,
      status: "degraded",
      completedAt: timestamp(now),
      lastErrorCategory: errorCategory(error),
      summaries,
    };
    await store.setHealth(health).catch(() => undefined);
    throw error;
  } finally {
    await store.releaseLease(leaseToken).catch(() => false);
    await store.flushCommandEstimate().catch(() => 0);
  }
}
