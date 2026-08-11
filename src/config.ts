import type { Address, Hex } from "viem";

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

const ROUTE_CONFIG: RouteConfig = {
  ethereum: {
    chainId: 11155111,
    eid: 40161,
    sendUln: "0xcc1ae8cf5d3904cef3360a9532b477529b177cce",
    receiveUln: "0xdaf00f5ee2158dd58e0d3857851c432e34a3a851",
    endpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    oapp: "0x1B94c5fcDBa4d2a3E9e6cB3F3684CbB6b846CF52",
    oappDeploymentTransaction: "0x1ef4ee616bde3dd2b94816faaddb352f59e83bee636bd05bfcd3c5139693e8ed",
    expectedDeployer: "0x37B54930D500Db3c35De7B72C68A1e7afbc9A5ae",
  },
  starknet: {
    chainId: "SN_SEPOLIA",
    eid: 40500,
    receiveUln: "0x0706572d6f7b938c813a20dc1b0328b83de939066e25bd0fbe14c270077f769d",
    sendUln: "0x0706572d6f7b938c813a20dc1b0328b83de939066e25bd0fbe14c270077f769d",
    endpoint: "0x0316d70a6e0445a58c486215fac8ead48d3db985acde27efca9130da4c675878",
    oapp: "0x3b6609179f6236ffb37e20658e8f69db9611d5c568d41fba8a156f7d18f371",
    expectedDeployer: "0x011dE9C756a84A99b5765183625cD7ad8EB6A0206cE2904Dbe478A1a1e5C0cb1",
    strkToken: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  },
  ethereumConfirmations: 1,
  starknetConfirmations: 15,
  pollIntervalMs: 15_000,
  fundingWarnings: {
    ethereumWei: "50000000000000000",
    starknetFri: "50000000000000000000",
  },
  server: { host: "127.0.0.1", port: 4010 },
};

const DEPLOYMENT: DeploymentState = {
  network: "sepolia",
  updatedAt: "2026-08-10T15:00:54.072Z",
  ethereum: {
    address: "0xe661e30cbdb3e2a6a2e27f95c9f5e3fdb132c1d1",
    transactionHash: "0x7e3b3bce5ff76e14cc5fc7ca3e0d303859aa830e88a27f00fb2ccdea2322ba03",
    deploymentBlock: "11459663",
  },
  starknet: {
    address: "0x636e2b57d4b95fb29b1a8d2385dd71499ac43e90b9bd791e7258c9d62d034ad",
    classHash: "0x6ea0c527407325a99726e61b11b8e30090bfa0093f993a363c10fb7a5334882",
    declareTransactionHash: "0xd31d2cd1e9a8e4413b289742377b38ea0e846aae68efbcb30d1ee4ec607357",
    deployTransactionHash: "0x7f4e3fa214bea4da7a35d49d110cf914669c37c1e18099b915d7d91d8c36d17",
  },
  ethereumReceive: {
    address: "0x29540c0d87f206a7677521d7f578430541eacbac",
    transactionHash: "0x98d1542010ff74977a2dc183a378950e4fcd60aad9356827b59e569511d2168b",
    deploymentBlock: "11459947",
  },
  starknetSend: {
    address: "0x49a72020fb914e38e91c175e13becb79d0cd1512c12357942e4babe381ea40e",
    classHash: "0x5399e65fd749a8b6ab333239c36519947c78ab57d4d7eecd282d972beaef5a9",
    declareTransactionHash: "0x703c0930d0f2ddecac9c145348b3c962920b918cd414ced83ee4ba755693a38",
    deployTransactionHash: "0x79251b017f8c13c0b8ffe2e4b6b313ab91cf41ade6e7ded1ac3b27ecb03eaed",
    deploymentBlock: "13251917",
  },
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing runtime value ${name}`);
  return value;
}

export function runtimeSecrets() {
  const rawEvmPrivateKey = required("MINI_DVN_EVM_PRIVATE_KEY");
  return {
    evmRpcUrl: required("MINI_DVN_EVM_RPC_URL"),
    evmPrivateKey: (rawEvmPrivateKey.startsWith("0x") ? rawEvmPrivateKey : `0x${rawEvmPrivateKey}`) as Hex,
    evmAddress: required("MINI_DVN_EVM_ADDRESS") as Address,
    starknetRpcUrl: required("MINI_DVN_STARKNET_RPC_URL"),
    starknetPrivateKey: required("MINI_DVN_STARKNET_PRIVATE_KEY"),
    starknetAddress: required("MINI_DVN_STARKNET_ADDRESS") as Hex,
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
