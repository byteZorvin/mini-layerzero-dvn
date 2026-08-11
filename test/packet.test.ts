import { describe, expect, test } from "bun:test";
import { concatHex, numberToHex } from "viem";
import { parsePacketHeader, splitEncodedPacket } from "../src/packet";

describe("LayerZero packet codec", () => {
  const header = concatHex([
    "0x01",
    numberToHex(7n, { size: 8 }),
    numberToHex(40161, { size: 4 }),
    numberToHex(0x1234, { size: 32 }),
    numberToHex(40500, { size: 4 }),
    numberToHex(0x5678, { size: 32 }),
  ]);

  test("parses the 81-byte V1 header", () => {
    const parsed = parsePacketHeader(header);
    expect(parsed.version).toBe(1);
    expect(parsed.nonce).toBe(7n);
    expect(parsed.srcEid).toBe(40161);
    expect(parsed.dstEid).toBe(40500);
    expect(parsed.sender.endsWith("1234")).toBe(true);
    expect(parsed.receiver.endsWith("5678")).toBe(true);
  });

  test("hashes guid plus message as the payload", () => {
    const split = splitEncodedPacket(concatHex([header, numberToHex(1, { size: 32 }), "0xaabb"]));
    expect(split.header).toBe(header);
    expect(split.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

