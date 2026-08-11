import { describe, expect, test } from "bun:test";
import { isAuthorized } from "../src/http";
import { MemoryStateStore } from "../src/store";

describe("lease ownership", () => {
  test("only the owning token can release the lease", async () => {
    const store = new MemoryStateStore();
    expect(await store.acquireLease("owner", 10_000)).toBe(true);
    expect(await store.releaseLease("other")).toBe(false);
    expect((await store.leaseStatus()).held).toBe(true);
    expect(await store.releaseLease("owner")).toBe(true);
    expect((await store.leaseStatus()).held).toBe(false);
  });
});

describe("bearer authentication", () => {
  test("accepts only an exact bearer token", () => {
    expect(isAuthorized(new Request("https://example.test", {
      headers: { authorization: "Bearer secret-value" },
    }), "secret-value")).toBe(true);
    expect(isAuthorized(new Request("https://example.test", {
      headers: { authorization: "Bearer secret-valuE" },
    }), "secret-value")).toBe(false);
    expect(isAuthorized(new Request("https://example.test"), "secret-value")).toBe(false);
  });
});
