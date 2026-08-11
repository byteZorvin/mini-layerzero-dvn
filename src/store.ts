import type { Direction, RelayJob, RunHealth } from "./types";

export interface LeaseStatus {
  held: boolean;
  ttlMs: number;
}

export interface StateStore {
  acquireLease(token: string, ttlMs: number): Promise<boolean>;
  releaseLease(token: string): Promise<boolean>;
  leaseStatus(): Promise<LeaseStatus>;
  getCursor(direction: Direction, initial: bigint): Promise<bigint>;
  setCursor(direction: Direction, block: bigint): Promise<void>;
  getJob(id: string): Promise<RelayJob | undefined>;
  upsertJob(job: RelayJob): Promise<void>;
  listPending(direction: Direction, limit: number): Promise<RelayJob[]>;
  listRecent(limit: number): Promise<RelayJob[]>;
  getHealth(): Promise<RunHealth | undefined>;
  setHealth(health: RunHealth): Promise<void>;
  commandEstimate(): Promise<number>;
  flushCommandEstimate(): Promise<number>;
}

interface RedisEnvelope<T> {
  result?: T;
  error?: string;
}

function required(names: string[]): string {
  const name = names.find((candidate) => process.env[candidate]);
  const value = name ? process.env[name] : undefined;
  if (!value) throw new Error(`Missing runtime value ${names.join(" or ")}`);
  return value.replace(/\/$/, "");
}

function parseJob(value: unknown): RelayJob | undefined {
  if (typeof value !== "string") return undefined;
  return JSON.parse(value) as RelayJob;
}

export class RedisRestStore implements StateStore {
  private readonly url: string;
  private readonly token: string;
  private commandDelta = 0;

  constructor(private readonly namespace: string, options?: { url: string; token: string }) {
    this.url = options?.url?.replace(/\/$/, "") ?? required(["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]);
    this.token = options?.token ?? required(["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"]);
  }

  private key(suffix: string): string {
    return `${this.namespace}:${suffix}`;
  }

  private async request<T>(command: Array<string | number>): Promise<T> {
    this.commandDelta += 1;
    const response = await fetch(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Redis request failed with HTTP ${response.status}`);
    const body = await response.json() as RedisEnvelope<T>;
    if (body.error) throw new Error(`Redis command failed: ${body.error}`);
    return body.result as T;
  }

  private async pipeline<T extends unknown[]>(commands: Array<Array<string | number>>): Promise<T> {
    if (commands.length === 0) return [] as unknown as T;
    this.commandDelta += commands.length;
    const response = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Redis pipeline failed with HTTP ${response.status}`);
    const body = await response.json() as Array<RedisEnvelope<unknown>>;
    for (const item of body) if (item.error) throw new Error(`Redis pipeline command failed: ${item.error}`);
    return body.map((item) => item.result) as T;
  }

  async acquireLease(token: string, ttlMs: number): Promise<boolean> {
    const result = await this.request<string | null>(["SET", this.key("lease"), token, "NX", "PX", ttlMs]);
    return result === "OK";
  }

  async releaseLease(token: string): Promise<boolean> {
    const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
    return Number(await this.request<number>(["EVAL", script, 1, this.key("lease"), token])) === 1;
  }

  async leaseStatus(): Promise<LeaseStatus> {
    const ttlMs = Number(await this.request<number>(["PTTL", this.key("lease")]));
    return { held: ttlMs >= 0, ttlMs: Math.max(ttlMs, 0) };
  }

  async getCursor(direction: Direction, initial: bigint): Promise<bigint> {
    const value = await this.request<string | null>(["GET", this.key(`cursor:${direction}`)]);
    return value === null ? initial : BigInt(value);
  }

  async setCursor(direction: Direction, block: bigint): Promise<void> {
    await this.request(["SET", this.key(`cursor:${direction}`), block.toString()]);
  }

  async getJob(id: string): Promise<RelayJob | undefined> {
    return parseJob(await this.request<string | null>(["GET", this.key(`job:${id}`)]));
  }

  async upsertJob(job: RelayJob): Promise<void> {
    const score = Number(job.sourceBlock);
    const jobKey = this.key(`job:${job.id}`);
    const commands: Array<Array<string | number>> = [
      ["SET", jobKey, JSON.stringify(job)],
      ["ZADD", this.key("jobs"), score, job.id],
    ];
    if (job.phase === "executed") commands.push(["ZREM", this.key(`pending:${job.direction}`), job.id]);
    else commands.push(["ZADD", this.key(`pending:${job.direction}`), score, job.id]);
    await this.pipeline(commands);
  }

  private async jobsForIds(ids: string[]): Promise<RelayJob[]> {
    const values = await this.pipeline<unknown[]>(ids.map((id) => ["GET", this.key(`job:${id}`)]));
    return values.map(parseJob).filter((job): job is RelayJob => Boolean(job));
  }

  async listPending(direction: Direction, limit: number): Promise<RelayJob[]> {
    const ids = await this.request<string[]>(["ZRANGE", this.key(`pending:${direction}`), 0, Math.max(0, limit - 1)]);
    return this.jobsForIds(ids ?? []);
  }

  async listRecent(limit: number): Promise<RelayJob[]> {
    const ids = await this.request<string[]>(["ZREVRANGE", this.key("jobs"), 0, Math.max(0, limit - 1)]);
    return this.jobsForIds(ids ?? []);
  }

  async getHealth(): Promise<RunHealth | undefined> {
    const value = await this.request<string | null>(["GET", this.key("health")]);
    return value === null ? undefined : JSON.parse(value) as RunHealth;
  }

  async setHealth(health: RunHealth): Promise<void> {
    await this.request(["SET", this.key("health"), JSON.stringify(health)]);
  }

  async commandEstimate(): Promise<number> {
    return Number(await this.request<string | null>(["GET", this.key("redis-commands")]) ?? 0);
  }

  async flushCommandEstimate(): Promise<number> {
    const delta = this.commandDelta + 1;
    this.commandDelta = 0;
    return Number(await this.request<number>(["INCRBY", this.key("redis-commands"), delta]));
  }
}

export class MemoryStateStore implements StateStore {
  private lease?: { token: string; expiresAt: number };
  private readonly cursors = new Map<Direction, bigint>();
  private readonly jobs = new Map<string, RelayJob>();
  private health?: RunHealth;
  private commands = 0;

  async acquireLease(token: string, ttlMs: number): Promise<boolean> {
    this.commands += 1;
    if (this.lease && this.lease.expiresAt > Date.now()) return false;
    this.lease = { token, expiresAt: Date.now() + ttlMs };
    return true;
  }

  async releaseLease(token: string): Promise<boolean> {
    this.commands += 1;
    if (this.lease?.token !== token) return false;
    this.lease = undefined;
    return true;
  }

  async leaseStatus(): Promise<LeaseStatus> {
    this.commands += 1;
    const ttlMs = Math.max(0, (this.lease?.expiresAt ?? 0) - Date.now());
    return { held: ttlMs > 0, ttlMs };
  }

  async getCursor(direction: Direction, initial: bigint): Promise<bigint> {
    this.commands += 1;
    return this.cursors.get(direction) ?? initial;
  }

  async setCursor(direction: Direction, block: bigint): Promise<void> {
    this.commands += 1;
    this.cursors.set(direction, block);
  }

  async getJob(id: string): Promise<RelayJob | undefined> {
    this.commands += 1;
    return this.jobs.get(id);
  }

  async upsertJob(job: RelayJob): Promise<void> {
    this.commands += 3;
    this.jobs.set(job.id, structuredClone(job));
  }

  async listPending(direction: Direction, limit: number): Promise<RelayJob[]> {
    this.commands += 1;
    return [...this.jobs.values()]
      .filter((job) => job.direction === direction && job.phase !== "executed")
      .sort((a, b) => Number(BigInt(a.sourceBlock) - BigInt(b.sourceBlock)))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async listRecent(limit: number): Promise<RelayJob[]> {
    this.commands += 1;
    return [...this.jobs.values()]
      .sort((a, b) => Number(BigInt(b.sourceBlock) - BigInt(a.sourceBlock)))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async getHealth(): Promise<RunHealth | undefined> {
    this.commands += 1;
    return this.health ? structuredClone(this.health) : undefined;
  }

  async setHealth(health: RunHealth): Promise<void> {
    this.commands += 1;
    this.health = structuredClone(health);
  }

  async commandEstimate(): Promise<number> {
    return this.commands;
  }

  async flushCommandEstimate(): Promise<number> {
    this.commands += 1;
    return this.commands;
  }
}
