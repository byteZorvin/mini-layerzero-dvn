import * as fs from "node:fs";
import * as path from "node:path";
import type { Address, Hex } from "viem";
import routeConfig from "../config/sepolia.json";
import deploymentState from "../deployments/sepolia.json";

export const PROJECT_ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname).replace(/\/$/, "");

export interface RouteConfig {
  ethereum: {
    chainId: number;
    eid: number;
    sendUln: Address;
    receiveUln: Address;
    endpoint: Address;
    oapp: Address;
    oappDeploymentTransaction: Hex;
    expectedDeployer: Address;
  };
  starknet: {
    chainId: string;
    eid: number;
    receiveUln: Hex;
    sendUln: Hex;
    endpoint: Hex;
    oapp: Hex;
    expectedDeployer: Hex;
    strkToken: Hex;
  };
  ethereumConfirmations: number;
  starknetConfirmations: number;
  pollIntervalMs: number;
  fundingWarnings: { ethereumWei: string; starknetFri: string };
  server: { host: string; port: number };
}

export interface DeploymentState {
  network: "sepolia";
  ethereum?: { address: Address; transactionHash: Hex; deploymentBlock: string };
  starknet?: {
    address: Hex;
    classHash: Hex;
    declareTransactionHash?: Hex;
    deployTransactionHash: Hex;
  };
  ethereumReceive?: { address: Address; transactionHash: Hex; deploymentBlock: string };
  starknetSend?: {
    address: Hex;
    classHash: Hex;
    declareTransactionHash?: Hex;
    deployTransactionHash: Hex;
    deploymentBlock: string;
  };
  updatedAt: string;
}

const ROUTE_CONFIG = routeConfig as RouteConfig;
const DEPLOYMENT = deploymentState as DeploymentState;

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function loadLocalOperatorEnvironment(): void {
  if (process.env.VERCEL) return;
  const explicit = process.env.ARCXCORE_ENV_FILE;
  if (explicit) {
    loadEnvFile(explicit);
    return;
  }
  const scriptsDir = path.resolve(PROJECT_ROOT, "../arcxcore/scripts");
  const local = path.join(scriptsDir, ".env.local");
  loadEnvFile(fs.existsSync(local) ? local : path.join(scriptsDir, ".env"));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing runtime value ${name}`);
  return value;
}

export function runtimeSecrets() {
  loadLocalOperatorEnvironment();
  const rawEvmPrivateKey = process.env.MINI_DVN_EVM_PRIVATE_KEY ?? required("EVM_DEPLOYER_PRIVATE_KEY");
  return {
    evmRpcUrl: process.env.MINI_DVN_EVM_RPC_URL ?? required("EVM_RPC_URL"),
    evmPrivateKey: (rawEvmPrivateKey.startsWith("0x") ? rawEvmPrivateKey : `0x${rawEvmPrivateKey}`) as Hex,
    evmAddress: (process.env.MINI_DVN_EVM_ADDRESS ?? required("EVM_DEPLOYER_ADDRESS")) as Address,
    starknetRpcUrl: process.env.MINI_DVN_STARKNET_RPC_URL ?? required("RPC_URL"),
    starknetPrivateKey: process.env.MINI_DVN_STARKNET_PRIVATE_KEY ?? required("DEPLOYER_PRIVATE_KEY"),
    starknetAddress: (process.env.MINI_DVN_STARKNET_ADDRESS ?? required("DEPLOYER_ADDRESS")) as Hex,
  };
}

export function loadRouteConfig(): RouteConfig {
  return ROUTE_CONFIG;
}

export function loadDeployment(): DeploymentState {
  return DEPLOYMENT;
}

export interface ServiceConfig {
  enabled: boolean;
  namespace: string;
  leaseTtlMs: number;
  maxRunMs: number;
  maxJobsPerDirection: number;
  evmScanChunk: bigint;
  starknetScanChunk: bigint;
  starknetMaxPages: number;
}

export function serviceConfig(): ServiceConfig {
  return {
    enabled: process.env.MINI_DVN_ENABLED === "true",
    namespace: process.env.MINI_DVN_REDIS_NAMESPACE ?? "mini-dvn:sepolia",
    leaseTtlMs: Number(process.env.MINI_DVN_LEASE_TTL_MS ?? 240_000),
    maxRunMs: Number(process.env.MINI_DVN_MAX_RUN_MS ?? 210_000),
    maxJobsPerDirection: Number(process.env.MINI_DVN_MAX_JOBS_PER_DIRECTION ?? 10),
    evmScanChunk: BigInt(process.env.MINI_DVN_EVM_SCAN_CHUNK ?? 2_000),
    starknetScanChunk: BigInt(process.env.MINI_DVN_STARKNET_SCAN_CHUNK ?? 1_000),
    starknetMaxPages: Number(process.env.MINI_DVN_STARKNET_MAX_PAGES ?? 20),
  };
}
