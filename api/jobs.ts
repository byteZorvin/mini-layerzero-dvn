import { serviceConfig } from "../src/config";
import { isAuthorized, json, methodNotAllowed } from "../src/http";
import { RedisRestStore } from "../src/store";

async function handler(request: Request): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  if (!isAuthorized(request, process.env.STATUS_SECRET)) return json({ error: "unauthorized" }, 401);
  try {
    const config = serviceConfig();
    const limit = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get("limit") ?? 25)));
    const store = new RedisRestStore(config.namespace);
    return json({ jobs: await store.listRecent(limit) });
  } catch {
    return json({ error: "jobs_unavailable" }, 503);
  }
}

export default { fetch: handler };
