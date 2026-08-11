import { afterEach, describe, expect, test } from "bun:test";
import relay from "../api/relay";

const originalSecret = process.env.RELAY_TRIGGER_SECRET;
const originalEnabled = process.env.MINI_DVN_ENABLED;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.RELAY_TRIGGER_SECRET;
  else process.env.RELAY_TRIGGER_SECRET = originalSecret;
  if (originalEnabled === undefined) delete process.env.MINI_DVN_ENABLED;
  else process.env.MINI_DVN_ENABLED = originalEnabled;
});

describe("relay API safety gates", () => {
  test("rejects unauthenticated requests before loading chain clients", async () => {
    process.env.RELAY_TRIGGER_SECRET = "test-secret";
    process.env.MINI_DVN_ENABLED = "false";
    const response = await relay.fetch(new Request("https://example.test/api/relay", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  test("returns disabled without loading chain clients", async () => {
    process.env.RELAY_TRIGGER_SECRET = "test-secret";
    process.env.MINI_DVN_ENABLED = "false";
    const response = await relay.fetch(new Request("https://example.test/api/relay", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled" });
  });
});
