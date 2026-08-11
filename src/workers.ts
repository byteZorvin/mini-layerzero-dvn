import { abi as layerZeroAbi } from "@layerzerolabs/protocol-starknet-v2";
import { Contract, hash, uint256 } from "starknet";
import {
  bytesToHex,
  decodeEventLog,
  getAddress,
  hexToBytes,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { clients } from "./clients";
import { loadDeployment, loadRouteConfig, serviceConfig } from "./config";
import {
  EVM_ENDPOINT_ABI,
  EVM_RECEIVE_DVN_ABI,
  EVM_RECEIVE_ULN_ABI,
  STARKNET_ERC20_ABI,
  STARKNET_MINI_DVN_ABI,
} from "./runtime-abis";
import {
  addressAsBytes32,
  decodeEncodedPacket,
  feltAsBytes32,
  parsePacketHeader,
  type DecodedPacket,
} from "./packet";
import type { Direction, FundingStatus, RelayJob, StoredPacket } from "./types";

const JOB_EVENT = parseAbiItem(
  "event JobAssigned(uint64 indexed jobId, uint32 indexed dstEid, address indexed sender, bytes packetHeader, bytes32 payloadHash, uint64 confirmations)",
);
const PACKET_SENT_EVENT = parseAbiItem("event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)");
const DELIVERED_PAYLOAD_HASH = 1n;

export type Confirmation = "confirmed" | "pending" | "reverted";
export type ReconciledPhase = "none" | "committed" | "executed";

export interface Discovery {
  cursorAfter: bigint;
  matureTip: bigint;
  jobs: RelayJob[];
}

export interface DirectionWorker {
  direction: Direction;
  initialCursor: bigint;
  discover(cursor: bigint, maximumBlock?: bigint, options?: { skipIncompatible?: boolean }): Promise<Discovery>;
  hydrate(sourceTransactionHash: Hex): Promise<RelayJob>;
  reconcile(job: RelayJob): Promise<ReconciledPhase>;
  submitVerify(job: RelayJob): Promise<Hex>;
  submitCommit(job: RelayJob): Promise<Hex>;
  submitExecute(job: RelayJob): Promise<Hex>;
  confirm(hash: Hex): Promise<Confirmation>;
}

function asByteArray(bytes: Hex): Uint8Array {
  return hexToBytes(bytes);
}

function serializePacket(packet: DecodedPacket): StoredPacket {
  return { ...packet, nonce: packet.nonce.toString() };
}

function packetFrom(job: RelayJob): DecodedPacket {
  return { ...job.packet, nonce: BigInt(job.packet.nonce) };
}

function now(): string {
  return new Date().toISOString();
}

function makeJob(
  direction: Direction,
  sourceTransactionHash: Hex,
  sourceBlock: bigint,
  packet: DecodedPacket,
  confirmations: number,
): RelayJob {
  const timestamp = now();
  return {
    id: `${direction}:${packet.payloadHash.toLowerCase()}`,
    direction,
    sourceTransactionHash,
    sourceBlock: sourceBlock.toString(),
    packet: serializePacket(packet),
    confirmations,
    phase: "discovered",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function decodePacketSent(log: { data: Hex; topics: readonly Hex[] }): Hex | undefined {
  try {
    const decoded = decodeEventLog({
      abi: [PACKET_SENT_EVENT],
      data: log.data,
      topics: [...log.topics] as [Hex, ...Hex[]],
    });
    return decoded.eventName === "PacketSent"
      ? (decoded.args as { encodedPayload: Hex }).encodedPayload
      : undefined;
  } catch {
    return undefined;
  }
}

function feltBytes(value: string, byteLength: number): Uint8Array {
  return hexToBytes(`0x${BigInt(value).toString(16).padStart(byteLength * 2, "0")}`);
}

export function decodeCairoByteArray(data: readonly string[], start = 0): { bytes: Hex; next: number } {
  if (start >= data.length) throw new Error("Missing Cairo ByteArray length");
  const fullWords = Number(BigInt(data[start]));
  const pendingIndex = start + 1 + fullWords;
  const lengthIndex = pendingIndex + 1;
  if (!Number.isSafeInteger(fullWords) || fullWords < 0 || lengthIndex >= data.length) {
    throw new Error("Invalid Cairo ByteArray");
  }
  const parts: Uint8Array[] = [];
  for (let index = 0; index < fullWords; index += 1) parts.push(feltBytes(data[start + 1 + index], 31));
  const pendingLength = Number(BigInt(data[lengthIndex]));
  if (!Number.isSafeInteger(pendingLength) || pendingLength < 0 || pendingLength > 30) {
    throw new Error("Invalid Cairo ByteArray pending length");
  }
  if (pendingLength > 0) parts.push(feltBytes(data[pendingIndex], pendingLength));
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return { bytes: bytesToHex(joined), next: lengthIndex + 1 };
}

function asBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  if (Array.isArray(value) && value.length > 0) return asBigInt(value[0]);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.low !== undefined && record.high !== undefined) {
      return asBigInt(record.low) + (asBigInt(record.high) << 128n);
    }
    if (record.value !== undefined) return asBigInt(record.value);
  }
  throw new Error("Unable to decode u256 result");
}

export function assertForwardPacket(packet: DecodedPacket): void {
  const route = loadRouteConfig();
  const parsed = parsePacketHeader(packet.header);
  if (parsed.version !== 1 || parsed.srcEid !== route.ethereum.eid || parsed.dstEid !== route.starknet.eid) {
    throw new Error("Unexpected Ethereum-to-Starknet packet route");
  }
  if (parsed.sender.toLowerCase() !== addressAsBytes32(route.ethereum.oapp).toLowerCase()) {
    throw new Error("Unexpected Ethereum packet sender");
  }
  if (parsed.receiver.toLowerCase() !== feltAsBytes32(route.starknet.oapp).toLowerCase()) {
    throw new Error("Unexpected Starknet packet receiver");
  }
}

export function assertReversePacket(packet: DecodedPacket): void {
  const route = loadRouteConfig();
  if (packet.version !== 1 || packet.srcEid !== route.starknet.eid || packet.dstEid !== route.ethereum.eid) {
    throw new Error("Unexpected Starknet-to-Ethereum packet route");
  }
  if (packet.sender.toLowerCase() !== feltAsBytes32(route.starknet.oapp).toLowerCase()) {
    throw new Error("Unexpected Starknet packet sender");
  }
  if (packet.receiver.toLowerCase() !== addressAsBytes32(route.ethereum.oapp).toLowerCase()) {
    throw new Error("Unexpected Ethereum packet receiver");
  }
}

function classifyPayloadHash(actual: bigint, expected: Hex): ReconciledPhase {
  if (actual === DELIVERED_PAYLOAD_HASH) return "executed";
  if (actual === BigInt(expected)) return "committed";
  if (actual === 0n) return "none";
  throw new Error("Destination Endpoint contains an unexpected payload hash");
}

function starknetReceiptStatus(receipt: unknown): Confirmation {
  const record = receipt as Record<string, unknown>;
  const execution = String(record.execution_status ?? "").toUpperCase();
  if (execution.includes("REVERT")) return "reverted";
  const finality = String(record.finality_status ?? "").toUpperCase();
  if (execution.includes("SUCCEED") || finality.includes("ACCEPTED")) return "confirmed";
  return "pending";
}

function isReceiptMissing(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /not found|receipt.*not.*found|transaction hash/i.test(message);
}

export function createDirectionWorkers(): { workers: DirectionWorker[]; funding: () => Promise<FundingStatus> } {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  const limits = serviceConfig();
  if (!deployment.ethereum || !deployment.starknet || !deployment.ethereumReceive || !deployment.starknetSend) {
    throw new Error("MiniDVN deployment metadata is incomplete");
  }
  const { secrets, evmAccount, evmPublic, evmWallet, starknetProvider, starknetAccount } = clients();

  const forward: DirectionWorker = {
    direction: "ethereum-to-starknet",
    initialCursor: BigInt(deployment.ethereum.deploymentBlock) - 1n,
    async discover(cursor, maximumBlock, options) {
      const latest = await evmPublic.getBlockNumber();
      const chainMatureTip = latest - BigInt(route.ethereumConfirmations);
      const matureTip = maximumBlock !== undefined && maximumBlock < chainMatureTip ? maximumBlock : chainMatureTip;
      const fromBlock = cursor + 1n;
      if (fromBlock > matureTip) return { cursorAfter: cursor, matureTip, jobs: [] };
      const toBlock = fromBlock + limits.evmScanChunk - 1n > matureTip
        ? matureTip
        : fromBlock + limits.evmScanChunk - 1n;
      const logs = await evmPublic.getLogs({
        address: deployment.ethereum!.address,
        event: JOB_EVENT,
        fromBlock,
        toBlock,
      });
      const packetCache = new Map<Hex, DecodedPacket>();
      const jobs: RelayJob[] = [];
      for (const log of logs) {
        const args = log.args;
        if (!log.transactionHash || log.blockNumber === null || args.packetHeader === undefined ||
          args.payloadHash === undefined || args.confirmations === undefined || args.sender === undefined) {
          throw new Error("Incomplete MiniDVN JobAssigned log");
        }
        if (getAddress(args.sender as Address) !== getAddress(route.ethereum.oapp)) continue;
        let packet = packetCache.get(log.transactionHash);
        if (!packet) {
          const receipt = await evmPublic.getTransactionReceipt({ hash: log.transactionHash });
          for (const receiptLog of receipt.logs) {
            if (getAddress(receiptLog.address) !== getAddress(route.ethereum.endpoint)) continue;
            const encoded = decodePacketSent(receiptLog);
            if (!encoded) continue;
            const candidate = decodeEncodedPacket(encoded);
            try {
              assertForwardPacket(candidate);
              packet = candidate;
              break;
            } catch {
              // A source transaction may contain unrelated LayerZero packets.
            }
          }
          if (!packet) throw new Error(`No matching PacketSent event in ${log.transactionHash}`);
          packetCache.set(log.transactionHash, packet);
        }
        if (packet.header.toLowerCase() !== String(args.packetHeader).toLowerCase() ||
          packet.payloadHash.toLowerCase() !== String(args.payloadHash).toLowerCase()) {
          throw new Error("MiniDVN job does not match its Endpoint packet");
        }
        if (Number(args.confirmations) !== route.ethereumConfirmations && options?.skipIncompatible) continue;
        if (Number(args.confirmations) !== route.ethereumConfirmations) {
          throw new Error("Unexpected Ethereum confirmation requirement");
        }
        jobs.push(makeJob(this.direction, log.transactionHash, log.blockNumber, packet, Number(args.confirmations)));
      }
      return { cursorAfter: toBlock, matureTip, jobs };
    },
    async hydrate(sourceTransactionHash) {
      const receipt = await evmPublic.getTransactionReceipt({ hash: sourceTransactionHash });
      if (receipt.status !== "success") throw new Error(`Source transaction ${sourceTransactionHash} was not successful`);
      let packet: DecodedPacket | undefined;
      let confirmations = route.ethereumConfirmations;
      for (const receiptLog of receipt.logs) {
        if (getAddress(receiptLog.address) === getAddress(route.ethereum.endpoint)) {
          const encoded = decodePacketSent(receiptLog);
          if (encoded) {
            const candidate = decodeEncodedPacket(encoded);
            try {
              assertForwardPacket(candidate);
              packet = candidate;
            } catch {
              // Ignore unrelated packets in a batch transaction.
            }
          }
        }
        if (getAddress(receiptLog.address) === getAddress(deployment.ethereum!.address)) {
          try {
            const decoded = decodeEventLog({
              abi: [JOB_EVENT],
              data: receiptLog.data,
              topics: [...receiptLog.topics] as [Hex, ...Hex[]],
            });
            if (decoded.eventName === "JobAssigned") {
              confirmations = Number((decoded.args as { confirmations: bigint }).confirmations);
            }
          } catch {
            // Historical backfill transactions predate the MiniDVN contract.
          }
        }
      }
      if (!packet) throw new Error(`No matching PacketSent event in ${sourceTransactionHash}`);
      return makeJob(this.direction, sourceTransactionHash, receipt.blockNumber, packet, confirmations);
    },
    async reconcile(job) {
      const packet = packetFrom(job);
      const endpoint = new Contract({
        abi: layerZeroAbi.endpointV2,
        address: route.starknet.endpoint,
        providerOrAccount: starknetProvider,
      });
      const result = await endpoint.call("inbound_payload_hash", [
        route.starknet.oapp,
        packet.srcEid,
        { value: uint256.bnToUint256(BigInt(packet.sender)) },
        packet.nonce,
      ]);
      return classifyPayloadHash(asBigInt(result), packet.payloadHash);
    },
    async submitVerify(job) {
      assertForwardPacket(packetFrom(job));
      const contract = new Contract({
        abi: STARKNET_MINI_DVN_ABI,
        address: deployment.starknet!.address,
        providerOrAccount: starknetAccount,
      });
      const transaction = await contract.invoke("verify_packet", [
        asByteArray(job.packet.header),
        { value: uint256.bnToUint256(BigInt(job.packet.payloadHash)) },
        job.confirmations,
      ]);
      return transaction.transaction_hash as Hex;
    },
    async submitCommit(job) {
      const receiveUln = new Contract({
        abi: layerZeroAbi.ultraLightNode302,
        address: route.starknet.receiveUln,
        providerOrAccount: starknetAccount,
      });
      const transaction = await receiveUln.invoke("commit", [
        asByteArray(job.packet.header),
        { value: uint256.bnToUint256(BigInt(job.packet.payloadHash)) },
      ]);
      return transaction.transaction_hash as Hex;
    },
    async submitExecute(job) {
      const packet = packetFrom(job);
      const endpoint = new Contract({
        abi: layerZeroAbi.endpointV2,
        address: route.starknet.endpoint,
        providerOrAccount: starknetAccount,
      });
      const transaction = await endpoint.invoke("lz_receive", [
        {
          src_eid: packet.srcEid,
          sender: { value: uint256.bnToUint256(BigInt(packet.sender)) },
          nonce: packet.nonce,
        },
        `0x${BigInt(packet.receiver).toString(16)}`,
        { value: uint256.bnToUint256(BigInt(packet.guid)) },
        asByteArray(packet.message),
        new Uint8Array(),
        uint256.bnToUint256(0n),
      ]);
      return transaction.transaction_hash as Hex;
    },
    async confirm(transactionHash) {
      try {
        return starknetReceiptStatus(await starknetProvider.getTransactionReceipt(transactionHash));
      } catch (error) {
        if (isReceiptMissing(error)) return "pending";
        throw error;
      }
    },
  };

  const reverse: DirectionWorker = {
    direction: "starknet-to-ethereum",
    initialCursor: BigInt(deployment.starknetSend.deploymentBlock) - 1n,
    async discover(cursor, maximumBlock) {
      const latest = BigInt(await starknetProvider.getBlockNumber());
      const chainMatureTip = latest - BigInt(route.starknetConfirmations);
      const matureTip = maximumBlock !== undefined && maximumBlock < chainMatureTip ? maximumBlock : chainMatureTip;
      const fromBlock = cursor + 1n;
      if (fromBlock > matureTip) return { cursorAfter: cursor, matureTip, jobs: [] };
      const toBlock = fromBlock + limits.starknetScanChunk - 1n > matureTip
        ? matureTip
        : fromBlock + limits.starknetScanChunk - 1n;
      const jobs: RelayJob[] = [];
      let continuationToken: string | undefined;
      let pages = 0;
      do {
        pages += 1;
        if (pages > limits.starknetMaxPages) {
          throw new Error("Starknet PacketSent scan exceeded the configured page limit");
        }
        const chunk = await starknetProvider.getEvents({
          address: route.starknet.endpoint,
          from_block: { block_number: Number(fromBlock) },
          to_block: { block_number: Number(toBlock) },
          keys: [[hash.getSelectorFromName("PacketSent")]],
          chunk_size: 100,
          continuation_token: continuationToken,
        });
        for (const event of chunk.events) {
          if (!event.transaction_hash) continue;
          let packet: DecodedPacket;
          try {
            packet = decodeEncodedPacket(decodeCairoByteArray(event.data).bytes);
            assertReversePacket(packet);
          } catch {
            continue;
          }
          const sourceBlock = BigInt(event.block_number ?? toBlock);
          jobs.push(makeJob(this.direction, event.transaction_hash as Hex, sourceBlock, packet, route.starknetConfirmations));
        }
        continuationToken = chunk.continuation_token;
      } while (continuationToken);
      return { cursorAfter: toBlock, matureTip, jobs };
    },
    async hydrate(sourceTransactionHash) {
      const receipt = await starknetProvider.getTransactionReceipt(sourceTransactionHash);
      const record = receipt as unknown as { block_number?: number; events?: Array<{ from_address?: string; data: string[] }> };
      for (const event of record.events ?? []) {
        if (event.from_address !== undefined && BigInt(event.from_address) !== BigInt(route.starknet.endpoint)) continue;
        try {
          const packet = decodeEncodedPacket(decodeCairoByteArray(event.data).bytes);
          assertReversePacket(packet);
          return makeJob(
            this.direction,
            sourceTransactionHash,
            BigInt(record.block_number ?? deployment.starknetSend!.deploymentBlock),
            packet,
            route.starknetConfirmations,
          );
        } catch {
          // Ignore unrelated receipt events.
        }
      }
      throw new Error(`No matching Starknet PacketSent event in ${sourceTransactionHash}`);
    },
    async reconcile(job) {
      const packet = packetFrom(job);
      const receiver = getAddress(`0x${packet.receiver.slice(-40)}`);
      const actual = await evmPublic.readContract({
        address: route.ethereum.endpoint,
        abi: EVM_ENDPOINT_ABI,
        functionName: "inboundPayloadHash",
        args: [receiver, packet.srcEid, packet.sender, packet.nonce],
      });
      return classifyPayloadHash(BigInt(actual), packet.payloadHash);
    },
    async submitVerify(job) {
      assertReversePacket(packetFrom(job));
      return evmWallet.writeContract({
        address: deployment.ethereumReceive!.address,
        abi: EVM_RECEIVE_DVN_ABI,
        functionName: "verifyPacket",
        args: [job.packet.header, job.packet.payloadHash, BigInt(job.confirmations)],
      });
    },
    async submitCommit(job) {
      return evmWallet.writeContract({
        address: route.ethereum.receiveUln,
        abi: EVM_RECEIVE_ULN_ABI,
        functionName: "commitVerification",
        args: [job.packet.header, job.packet.payloadHash],
      });
    },
    async submitExecute(job) {
      const packet = packetFrom(job);
      return evmWallet.writeContract({
        address: route.ethereum.endpoint,
        abi: EVM_ENDPOINT_ABI,
        functionName: "lzReceive",
        args: [
          { srcEid: packet.srcEid, sender: packet.sender, nonce: packet.nonce },
          getAddress(`0x${packet.receiver.slice(-40)}`),
          packet.guid,
          packet.message,
          "0x",
        ],
        value: 0n,
      });
    },
    async confirm(transactionHash) {
      try {
        const receipt = await evmPublic.getTransactionReceipt({ hash: transactionHash });
        return receipt.status === "success" ? "confirmed" : "reverted";
      } catch (error) {
        if (isReceiptMissing(error)) return "pending";
        throw error;
      }
    },
  };

  return {
    workers: [forward, reverse],
    async funding() {
      const strk = new Contract({
        abi: STARKNET_ERC20_ABI,
        address: route.starknet.strkToken,
        providerOrAccount: starknetProvider,
      });
      const [ethereumWei, starknetBalance] = await Promise.all([
        evmPublic.getBalance({ address: evmAccount.address }),
        strk.call("balance_of", [secrets.starknetAddress]),
      ]);
      const starknetFri = asBigInt(starknetBalance);
      return {
        ethereumWei: ethereumWei.toString(),
        starknetFri: starknetFri.toString(),
        ethereumWarning: ethereumWei < BigInt(route.fundingWarnings.ethereumWei),
        starknetWarning: starknetFri < BigInt(route.fundingWarnings.starknetFri),
        checkedAt: now(),
      };
    },
  };
}
