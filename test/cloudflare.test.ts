import { afterEach, describe, expect, test } from "bun:test";
import { runSchedule } from "../cloudflare/worker";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete (globalThis as unknown as { scheduler?: unknown }).scheduler;
});

describe("Cloudflare scheduler", () => {
  test("invokes Vercel immediately and after fifteen seconds", async () => {
    const waits: number[] = [];
    const passes: string[] = [];
    (globalThis as unknown as { scheduler: { wait(ms: number): Promise<void> } }).scheduler = {
      wait: async (ms) => { waits.push(ms); },
    };
    globalThis.fetch = (async (_input, init) => {
      const headers = new Headers(init?.headers);
      passes.push(headers.get("x-mini-dvn-pass") ?? "");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    await runSchedule(
      { scheduledTime: 123, cron: "* * * * *" },
      { VERCEL_RELAY_URL: "https://example.test/api/relay", RELAY_TRIGGER_SECRET: "secret" },
    );
    expect(passes).toEqual(["1", "2"]);
    expect(waits).toEqual([15_000]);
  });
});
