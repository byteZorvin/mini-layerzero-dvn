import { serviceConfig } from "../src/config";
import { json, methodNotAllowed } from "../src/http";
import { RedisRestStore } from "../src/store";

async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const config = serviceConfig();
  const hasRedis = Boolean(
    (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL) &&
    (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
  );
  if (!hasRedis) {
    return json({ status: "unconfigured", enabled: config.enabled }, 503);
  }
  try {
    const store = new RedisRestStore(config.namespace);
    const [health, lease, redisCommands] = await Promise.all([
      store.getHealth(),
      store.leaseStatus(),
      store.commandEstimate(),
    ]);
    const summaries = health?.summaries?.map((summary) => ({
      ...summary,
      cursorLag: (BigInt(summary.matureTip) - BigInt(summary.cursorAfter)).toString(),
    }));
    return json({
      status: health?.status ?? (config.enabled ? "starting" : "disabled"),
      enabled: config.enabled,
      lastRunAt: health?.completedAt ?? health?.startedAt,
      lastSuccessAt: health?.lastSuccessAt,
      lastErrorCategory: health?.lastErrorCategory,
      funding: health?.funding,
      summaries,
      lease,
      redisCommands,
    });
  } catch {
    return json({ status: "degraded", enabled: config.enabled, lastErrorCategory: "redis" }, 503);
  }
}

export default { fetch: handler };
