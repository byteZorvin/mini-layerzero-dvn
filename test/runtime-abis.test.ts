import { describe, expect, test } from "bun:test";
import { Contract, uint256 } from "starknet";
import { hexToBytes } from "viem";
import { STARKNET_MINI_DVN_ABI } from "../src/runtime-abis";

describe("Starknet MiniDVN runtime ABI", () => {
  test("encodes the live LayerZero packet header as a Cairo ByteArray", () => {
    const packetHeader =
      "0x01000000000000000100009ce10000000000000000000000009a4c4d10d548d44e12aa847636700f6f4bf16e1200009e3407e9593b9a78dff63fe86a488710be4c683a1befcd24f697475e3e0ae86e75e5";
    const payloadHash =
      "0x94aa170b3faff43f34755cc87f29bdbfb9f347c4d3c694597e28712bbc5ed9b7";
    const contract = new Contract({
      abi: STARKNET_MINI_DVN_ABI,
      address: "0x1",
    });

    const call = contract.populate("verify_packet", [
      hexToBytes(packetHeader),
      { value: uint256.bnToUint256(BigInt(payloadHash)) },
      1,
    ]);
    const calldata = call.calldata as string[];

    expect(calldata).toHaveLength(8);
    expect(calldata.slice(0, 5)).toEqual([
      "0x2",
      "0x1000000000000000100009ce10000000000000000000000009a4c4d10d548",
      "0xd44e12aa847636700f6f4bf16e1200009e3407e9593b9a78dff63fe86a4887",
      "0x10be4c683a1befcd24f697475e3e0ae86e75e5",
      "0x13",
    ]);
  });
});
