import * as fs from "node:fs";
import * as path from "node:path";
import {
  bytesToHex,
  getAddress,
  hexToBytes,
  parseAbi,
  type Hex,
} from "viem";
import { clients } from "./clients";
import { loadDeployment, loadRouteConfig, PROJECT_ROOT } from "./config";
import {
  addressAsBytes32,
  decodeEncodedPacket,
  feltAsBytes32,
  type DecodedPacket,
} from "./packet";

const RECEIVE_DVN_ABI = parseAbi([
  "function verifyPacket(bytes packetHeader, bytes32 payloadHash, uint64 confirmations)",
]);
const RECEIVE_ULN_ABI = parseAbi([
  "function commitVerification(bytes packetHeader, bytes32 payloadHash)",
]);
const ENDPOINT_ABI = parseAbi([
  "function lzReceive((uint32 srcEid, bytes32 sender, uint64 nonce) origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
]);

type ReverseStatus = "verified" | "committed" | "executed" | "failed";

interface ReverseRecord {
  status: ReverseStatus;
  sourceTransactionHash: Hex;
  verifyTransactionHash?: Hex;
  commitTransactionHash?: Hex;
  executeTransactionHash?: Hex;
  error?: string;
  updatedAt: string;
}

interface ReverseState {
  lastScannedBlock: string;
  jobs: Record<string, ReverseRecord>;
}

const STATE_PATH = path.join(PROJECT_ROOT, "state/sepolia-reverse.json");

function readState(deploymentBlock: bigint): ReverseState {
  if (!fs.existsSync(STATE_PATH)) {
    return { lastScannedBlock: (deploymentBlock - 1n).toString(), jobs: {} };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as ReverseState;
}

function saveState(state: ReverseState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, STATE_PATH);
}

function feltBytes(value: string, byteLength: number): Uint8Array {
  const hex = BigInt(value).toString(16).padStart(byteLength * 2, "0");
  return hexToBytes(`0x${hex}`);
}

function decodeByteArray(data: readonly string[], start = 0): { bytes: Hex; next: number } {
  if (start >= data.length) throw new Error("Missing Cairo ByteArray length");
  const fullWords = Number(BigInt(data[start]));
  const pendingIndex = start + 1 + fullWords;
  const lengthIndex = pendingIndex + 1;
  if (!Number.isSafeInteger(fullWords) || fullWords < 0 || lengthIndex >= data.length) {
    throw new Error("Invalid Cairo ByteArray");
  }
  const parts: Uint8Array[] = [];
  for (let index = 0; index < fullWords; index += 1) {
    parts.push(feltBytes(data[start + 1 + index], 31));
  }
  const pendingLength = Number(BigInt(data[lengthIndex]));
  if (!Number.isSafeInteger(pendingLength) || pendingLength < 0 || pendingLength > 30) {
    throw new Error("Invalid Cairo ByteArray pending length");
  }
  if (pendingLength > 0) parts.push(feltBytes(data[pendingIndex], pendingLength));
  const length = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return { bytes: bytesToHex(joined), next: lengthIndex + 1 };
}

function decodeStarknetPacketSent(event: { data: readonly string[] }): DecodedPacket | undefined {
  try {
    return decodeEncodedPacket(decodeByteArray(event.data).bytes);
  } catch {
    return undefined;
  }
}

function assertReversePacket(packet: DecodedPacket): void {
  const route = loadRouteConfig();
  if (packet.version !== 1 || packet.srcEid !== route.starknet.eid || packet.dstEid !== route.ethereum.eid) {
    throw new Error("Unexpected reverse packet route");
  }
  if (packet.sender.toLowerCase() !== feltAsBytes32(route.starknet.oapp).toLowerCase()) {
    throw new Error("Unexpected reverse packet sender");
  }
  if (packet.receiver.toLowerCase() !== addressAsBytes32(route.ethereum.oapp).toLowerCase()) {
    throw new Error("Unexpected reverse packet receiver");
  }
}

async function verifyOnEthereum(packet: DecodedPacket): Promise<Hex> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  if (!deployment.ethereumReceive) throw new Error("Ethereum receive MiniDVN is not deployed");
  const { evmWallet, evmPublic } = clients();
  const hash = await evmWallet.writeContract({
    address: deployment.ethereumReceive.address,
    abi: RECEIVE_DVN_ABI,
    functionName: "verifyPacket",
    args: [packet.header, packet.payloadHash, BigInt(route.starknetConfirmations)],
  });
  const receipt = await evmPublic.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Ethereum verification failed: ${hash}`);
  return hash;
}

async function commitOnEthereum(packet: DecodedPacket): Promise<Hex> {
  const route = loadRouteConfig();
  const { evmWallet, evmPublic } = clients();
  const hash = await evmWallet.writeContract({
    address: route.ethereum.receiveUln,
    abi: RECEIVE_ULN_ABI,
    functionName: "commitVerification",
    args: [packet.header, packet.payloadHash],
  });
  const receipt = await evmPublic.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Ethereum commit failed: ${hash}`);
  return hash;
}

async function executeOnEthereum(packet: DecodedPacket): Promise<Hex> {
  const route = loadRouteConfig();
  const { evmWallet, evmPublic } = clients();
  const receiver = getAddress(`0x${packet.receiver.slice(-40)}`);
  const hash = await evmWallet.writeContract({
    address: route.ethereum.endpoint,
    abi: ENDPOINT_ABI,
    functionName: "lzReceive",
    args: [{ srcEid: packet.srcEid, sender: packet.sender, nonce: packet.nonce }, receiver, packet.guid, packet.message, "0x"],
    value: 0n,
  });
  const receipt = await evmPublic.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Ethereum execution failed: ${hash}`);
  return hash;
}

async function processPacket(
  state: ReverseState,
  key: string,
  sourceTransactionHash: Hex,
  packet: DecodedPacket,
): Promise<ReverseRecord> {
  assertReversePacket(packet);
  const current = state.jobs[key] ?? {
    status: "failed" as const,
    sourceTransactionHash,
    updatedAt: new Date().toISOString(),
  };
  state.jobs[key] = current;
  try {
    if (!current.verifyTransactionHash) {
      current.verifyTransactionHash = await verifyOnEthereum(packet);
      current.status = "verified";
      current.error = undefined;
      current.updatedAt = new Date().toISOString();
      saveState(state);
    }
    if (!current.commitTransactionHash) {
      current.commitTransactionHash = await commitOnEthereum(packet);
      current.status = "committed";
      current.error = undefined;
      current.updatedAt = new Date().toISOString();
      saveState(state);
    }
    if (!current.executeTransactionHash) {
      current.executeTransactionHash = await executeOnEthereum(packet);
      current.status = "executed";
      current.error = undefined;
      current.updatedAt = new Date().toISOString();
      saveState(state);
    }
  } catch (error) {
    current.status = "failed";
    current.error = error instanceof Error ? error.message : String(error);
    current.updatedAt = new Date().toISOString();
    saveState(state);
  }
  return current;
}

export async function reverseRelayOnce(): Promise<ReverseState> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  if (!deployment.starknetSend || !deployment.ethereumReceive) {
    throw new Error("Reverse MiniDVN deployment is incomplete");
  }
  const { starknetProvider } = clients();
  const deploymentBlock = BigInt(deployment.starknetSend.deploymentBlock);
  const state = readState(deploymentBlock);
  const latest = BigInt(await starknetProvider.getBlockNumber());
  if (latest <= BigInt(route.starknetConfirmations)) return state;
  const matureTip = latest - BigInt(route.starknetConfirmations);
  let fromBlock = BigInt(state.lastScannedBlock) + 1n;
  while (fromBlock <= matureTip) {
    const toBlock = fromBlock + 999n > matureTip ? matureTip : fromBlock + 999n;
    let continuationToken: string | undefined;
    do {
      const chunk = await starknetProvider.getEvents({
        address: route.starknet.endpoint,
        from_block: { block_number: Number(fromBlock) },
        to_block: { block_number: Number(toBlock) },
        chunk_size: 100,
        continuation_token: continuationToken,
      });
      for (const event of chunk.events) {
        const packet = decodeStarknetPacketSent(event);
        if (!packet || !event.transaction_hash) continue;
        try {
          assertReversePacket(packet);
        } catch {
          continue;
        }
        await processPacket(state, packet.payloadHash, event.transaction_hash as Hex, packet);
      }
      continuationToken = chunk.continuation_token;
    } while (continuationToken);
    state.lastScannedBlock = toBlock.toString();
    saveState(state);
    fromBlock = toBlock + 1n;
  }
  return state;
}

export function reverseRelayState(): ReverseState | undefined {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : undefined;
}
