import * as fs from "node:fs";
import * as path from "node:path";
import { abi as layerZeroAbi } from "@layerzerolabs/protocol-starknet-v2";
import { Contract, uint256 } from "starknet";
import {
  decodeEventLog,
  getAddress,
  hexToBytes,
  parseAbiItem,
  type Address,
  type Hex,
} from "viem";
import { starknetArtifacts } from "./artifacts";
import { clients } from "./clients";
import { loadDeployment, loadRouteConfig, PROJECT_ROOT } from "./config";
import {
  addressAsBytes32,
  decodeEncodedPacket,
  feltAsBytes32,
  parsePacketHeader,
  type DecodedPacket,
} from "./packet";

const JOB_EVENT = parseAbiItem(
  "event JobAssigned(uint64 indexed jobId, uint32 indexed dstEid, address indexed sender, bytes packetHeader, bytes32 payloadHash, uint64 confirmations)",
);
const PACKET_SENT_EVENT = parseAbiItem(
  "event PacketSent(bytes encodedPayload, bytes options, address sendLibrary)",
);

type JobStatus = "verified" | "committed" | "executed" | "failed";

interface JobRecord {
  status: JobStatus;
  sourceTransactionHash: Hex;
  verifyTransactionHash?: Hex;
  commitTransactionHash?: Hex;
  executeTransactionHash?: Hex;
  destinationTransactionHash?: Hex;
  error?: string;
  updatedAt: string;
}

interface RelayState {
  lastScannedBlock: string;
  jobs: Record<string, JobRecord>;
}

export interface VerificationJob {
  key: string;
  packetHeader: Hex;
  payloadHash: Hex;
  confirmations: number;
  sourceTransactionHash: Hex;
}

const STATE_PATH = path.join(PROJECT_ROOT, "state/sepolia.json");

function readState(deploymentBlock: bigint): RelayState {
  if (!fs.existsSync(STATE_PATH)) {
    return { lastScannedBlock: (deploymentBlock - 1n).toString(), jobs: {} };
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as RelayState;
  for (const record of Object.values(state.jobs)) {
    if (!record.verifyTransactionHash && record.destinationTransactionHash) {
      record.verifyTransactionHash = record.destinationTransactionHash;
    }
  }
  return state;
}

function saveState(state: RelayState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const temporary = `${STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, STATE_PATH);
}

function asByteArray(bytes: Hex): Uint8Array {
  return hexToBytes(bytes);
}

function assertPacket(job: VerificationJob): void {
  const route = loadRouteConfig();
  const parsed = parsePacketHeader(job.packetHeader);
  if (parsed.version !== 1) throw new Error(`Unsupported packet version ${parsed.version}`);
  if (parsed.srcEid !== route.ethereum.eid) throw new Error(`Unexpected source EID ${parsed.srcEid}`);
  if (parsed.dstEid !== route.starknet.eid) throw new Error(`Unexpected destination EID ${parsed.dstEid}`);
  if (parsed.sender.toLowerCase() !== addressAsBytes32(route.ethereum.oapp).toLowerCase()) {
    throw new Error(`Unexpected packet sender ${parsed.sender}`);
  }
  if (parsed.receiver.toLowerCase() !== feltAsBytes32(route.starknet.oapp).toLowerCase()) {
    throw new Error(`Unexpected packet receiver ${parsed.receiver}`);
  }
  if (job.confirmations !== route.ethereumConfirmations) {
    throw new Error(`Unexpected confirmation requirement ${job.confirmations}`);
  }
}

function origin(packet: DecodedPacket) {
  return {
    src_eid: packet.srcEid,
    sender: { value: uint256.bnToUint256(BigInt(packet.sender)) },
    nonce: packet.nonce,
  };
}

export async function verifyOnDestination(job: VerificationJob): Promise<Hex> {
  assertPacket(job);
  const deployment = loadDeployment();
  if (!deployment.starknet) throw new Error("Starknet MiniDVN is not deployed");
  const { starknetProvider, starknetAccount } = clients();
  const artifacts = starknetArtifacts();
  const contract = new Contract({
    abi: artifacts.sierra.abi,
    address: deployment.starknet.address,
    providerOrAccount: starknetAccount,
  });
  const transaction = await contract.invoke("verify_packet", [
    asByteArray(job.packetHeader),
    { value: uint256.bnToUint256(BigInt(job.payloadHash)) },
    job.confirmations,
  ]);
  await starknetProvider.waitForTransaction(transaction.transaction_hash);
  return transaction.transaction_hash as Hex;
}

async function commitOnDestination(job: VerificationJob): Promise<Hex> {
  const route = loadRouteConfig();
  const { starknetProvider, starknetAccount } = clients();
  const receiveUln = new Contract({
    abi: layerZeroAbi.ultraLightNode302,
    address: route.starknet.receiveUln,
    providerOrAccount: starknetAccount,
  });
  const transaction = await receiveUln.invoke("commit", [
    asByteArray(job.packetHeader),
    { value: uint256.bnToUint256(BigInt(job.payloadHash)) },
  ]);
  await starknetProvider.waitForTransaction(transaction.transaction_hash);
  return transaction.transaction_hash as Hex;
}

async function executeOnDestination(packet: DecodedPacket): Promise<Hex> {
  const route = loadRouteConfig();
  const { starknetProvider, starknetAccount } = clients();
  const endpoint = new Contract({
    abi: layerZeroAbi.endpointV2,
    address: route.starknet.endpoint,
    providerOrAccount: starknetAccount,
  });
  const transaction = await endpoint.invoke("lz_receive", [
    origin(packet),
    `0x${BigInt(packet.receiver).toString(16)}`,
    { value: uint256.bnToUint256(BigInt(packet.guid)) },
    asByteArray(packet.message),
    new Uint8Array(),
    uint256.bnToUint256(0n),
  ]);
  await starknetProvider.waitForTransaction(transaction.transaction_hash);
  return transaction.transaction_hash as Hex;
}

function decodePacketSent(log: { data: Hex; topics: readonly Hex[] }): Hex | undefined {
  try {
    const decoded = decodeEventLog({
      abi: [PACKET_SENT_EVENT],
      data: log.data,
      topics: [...log.topics] as [Hex, ...Hex[]],
    });
    if (decoded.eventName !== "PacketSent") return undefined;
    return (decoded.args as { encodedPayload: Hex }).encodedPayload;
  } catch {
    return undefined;
  }
}

async function sourcePacket(sourceTransactionHash: Hex): Promise<{
  packet: DecodedPacket;
  blockNumber: bigint;
}> {
  const route = loadRouteConfig();
  const { evmPublic } = clients();
  const receipt = await evmPublic.getTransactionReceipt({ hash: sourceTransactionHash });
  if (receipt.status !== "success") throw new Error("Source transaction was not successful");
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(route.ethereum.endpoint)) continue;
    const encodedPayload = decodePacketSent(log);
    if (!encodedPayload) continue;
    const packet = decodeEncodedPacket(encodedPayload);
    if (
      packet.sender.toLowerCase() === addressAsBytes32(route.ethereum.oapp).toLowerCase() &&
      packet.receiver.toLowerCase() === feltAsBytes32(route.starknet.oapp).toLowerCase()
    ) return { packet, blockNumber: receipt.blockNumber };
  }
  throw new Error("Source transaction has no matching LayerZero Endpoint PacketSent event");
}

async function processJob(
  state: RelayState,
  job: VerificationJob,
  packet: DecodedPacket,
): Promise<JobRecord> {
  if (packet.header.toLowerCase() !== job.packetHeader.toLowerCase()) {
    throw new Error("MiniDVN header does not match Endpoint PacketSent");
  }
  if (packet.payloadHash.toLowerCase() !== job.payloadHash.toLowerCase()) {
    throw new Error("MiniDVN payload hash does not match Endpoint PacketSent");
  }
  const current = state.jobs[job.key] ?? {
    status: "failed" as const,
    sourceTransactionHash: job.sourceTransactionHash,
    updatedAt: new Date().toISOString(),
  };
  state.jobs[job.key] = current;
  try {
    if (!current.verifyTransactionHash) {
      current.verifyTransactionHash = await verifyOnDestination(job);
      current.destinationTransactionHash = current.verifyTransactionHash;
      current.status = "verified";
      current.error = undefined;
      current.updatedAt = new Date().toISOString();
      saveState(state);
    }
    if (!current.commitTransactionHash) {
      current.commitTransactionHash = await commitOnDestination(job);
      current.status = "committed";
      current.error = undefined;
      current.updatedAt = new Date().toISOString();
      saveState(state);
    }
    if (!current.executeTransactionHash) {
      current.executeTransactionHash = await executeOnDestination(packet);
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

export async function deliverSourceTransaction(sourceTransactionHash: Hex): Promise<JobRecord> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  if (!deployment.ethereum) throw new Error("Ethereum MiniDVN is not deployed");
  const state = readState(BigInt(deployment.ethereum.deploymentBlock));
  const { packet, blockNumber } = await sourcePacket(sourceTransactionHash);
  const { evmPublic } = clients();
  const latest = await evmPublic.getBlockNumber();
  if (latest - blockNumber < BigInt(route.ethereumConfirmations)) {
    throw new Error(`Source transaction has fewer than ${route.ethereumConfirmations} confirmations`);
  }
  const existing = Object.entries(state.jobs).find(([, record]) =>
    record.sourceTransactionHash.toLowerCase() === sourceTransactionHash.toLowerCase()
  );
  const job: VerificationJob = {
    key: existing?.[0] ?? `manual:${sourceTransactionHash}`,
    packetHeader: packet.header,
    payloadHash: packet.payloadHash,
    confirmations: route.ethereumConfirmations,
    sourceTransactionHash,
  };
  return processJob(state, job, packet);
}

export async function backfillHistoricalPackets(execute: boolean): Promise<{
  mode: "dry-run" | "execute";
  discovered: number;
  routePackets: number;
  executed: number;
  packets: Array<{ nonce: string; transactionHash: Hex; payloadHash: Hex }>;
}> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  if (!deployment.ethereum) throw new Error("Ethereum MiniDVN is not deployed");
  const { evmPublic } = clients();
  const deploymentReceipt = await evmPublic.getTransactionReceipt({
    hash: route.ethereum.oappDeploymentTransaction,
  });
  const latest = await evmPublic.getBlockNumber();
  const matureTip = latest - BigInt(route.ethereumConfirmations);
  const logs = [] as Awaited<ReturnType<typeof evmPublic.getLogs>>;
  for (let fromBlock = deploymentReceipt.blockNumber; fromBlock <= matureTip; fromBlock += 2_000n) {
    const toBlock = fromBlock + 1_999n > matureTip ? matureTip : fromBlock + 1_999n;
    logs.push(...await evmPublic.getLogs({
      address: route.ethereum.endpoint,
      event: PACKET_SENT_EVENT,
      fromBlock,
      toBlock,
    }));
  }
  const packets = logs.flatMap((log) => {
    const encodedPayload = decodePacketSent(log);
    if (!encodedPayload || !log.transactionHash) return [];
    const packet = decodeEncodedPacket(encodedPayload);
    if (
      packet.sender.toLowerCase() !== addressAsBytes32(route.ethereum.oapp).toLowerCase() ||
      packet.receiver.toLowerCase() !== feltAsBytes32(route.starknet.oapp).toLowerCase()
    ) return [];
    return [{ packet, transactionHash: log.transactionHash }];
  }).sort((a, b) => a.packet.nonce < b.packet.nonce ? -1 : a.packet.nonce > b.packet.nonce ? 1 : 0);

  const state = readState(BigInt(deployment.ethereum.deploymentBlock));
  if (execute) {
    for (const item of packets) {
      const existing = Object.entries(state.jobs).find(([, record]) =>
        record.sourceTransactionHash.toLowerCase() === item.transactionHash.toLowerCase()
      );
      const job: VerificationJob = {
        key: existing?.[0] ?? `backfill:${item.packet.payloadHash}`,
        packetHeader: item.packet.header,
        payloadHash: item.packet.payloadHash,
        confirmations: route.ethereumConfirmations,
        sourceTransactionHash: item.transactionHash,
      };
      await processJob(state, job, item.packet);
    }
  }
  return {
    mode: execute ? "execute" : "dry-run",
    discovered: logs.length,
    routePackets: packets.length,
    executed: packets.filter((item) => {
      const record = Object.values(state.jobs).find((entry) =>
        entry.sourceTransactionHash.toLowerCase() === item.transactionHash.toLowerCase()
      );
      return record?.status === "executed";
    }).length,
    packets: packets.map((item) => ({
      nonce: item.packet.nonce.toString(),
      transactionHash: item.transactionHash,
      payloadHash: item.packet.payloadHash,
    })),
  };
}

export async function relayOnce(): Promise<RelayState> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  if (!deployment.ethereum || !deployment.starknet) throw new Error("Both MiniDVNs must be deployed");
  const { evmPublic } = clients();
  const deploymentBlock = BigInt(deployment.ethereum.deploymentBlock);
  const state = readState(deploymentBlock);
  const latest = await evmPublic.getBlockNumber();
  if (latest <= BigInt(route.ethereumConfirmations)) return state;
  const toBlock = latest - BigInt(route.ethereumConfirmations);
  const fromBlock = BigInt(state.lastScannedBlock) + 1n;
  if (fromBlock <= toBlock) {
    const logs = await evmPublic.getLogs({
      address: deployment.ethereum.address,
      event: JOB_EVENT,
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const args = log.args;
      if (
        args.jobId === undefined || args.sender === undefined || args.packetHeader === undefined ||
        args.payloadHash === undefined || args.confirmations === undefined || !log.transactionHash
      ) throw new Error("Incomplete MiniDVN JobAssigned log");
      if (getAddress(args.sender as Address) !== getAddress(route.ethereum.oapp)) {
        throw new Error(`Job ${String(args.jobId)} has an unexpected OApp`);
      }
      const key = `${log.transactionHash}:${String(args.jobId)}`;
      const { packet } = await sourcePacket(log.transactionHash);
      await processJob(state, {
        key,
        packetHeader: args.packetHeader as Hex,
        payloadHash: args.payloadHash as Hex,
        confirmations: Number(args.confirmations),
        sourceTransactionHash: log.transactionHash,
      }, packet);
    }
    state.lastScannedBlock = toBlock.toString();
    saveState(state);
  }

  for (const [key, record] of Object.entries(state.jobs)) {
    if (record.status === "executed") continue;
    const { packet } = await sourcePacket(record.sourceTransactionHash);
    await processJob(state, {
      key,
      packetHeader: packet.header,
      payloadHash: packet.payloadHash,
      confirmations: route.ethereumConfirmations,
      sourceTransactionHash: record.sourceTransactionHash,
    }, packet);
  }
  return state;
}

export function relayState(): RelayState | undefined {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : undefined;
}
