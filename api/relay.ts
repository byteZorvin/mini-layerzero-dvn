import { serviceConfig } from "../src/config";
import { isAuthorized, json, methodNotAllowed } from "../src/http";

async function handler(request: Request): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isAuthorized(request, process.env.RELAY_TRIGGER_SECRET)) return json({ error: "unauthorized" }, 401);
  if (!serviceConfig().enabled) return json({ status: "disabled" });
  try {
    // Keep heavyweight chain libraries out of unauthenticated and disabled invocations.
    const { runRelayPass } = await import("../src/engine");
    const result = await runRelayPass();
    return json(result, result.status === "busy" ? 202 : 200);
  } catch (error) {
    console.error(`[mini-dvn] relay pass failed: ${error instanceof Error ? error.name : "unknown"}`);
    return json({ status: "error", error: "relay_pass_failed" }, 500);
  }
}

export default { fetch: handler };
