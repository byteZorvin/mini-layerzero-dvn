import { Account, RpcProvider } from "starknet";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { runtimeSecrets } from "./config";
import { loadRouteConfig } from "./config";

export function clients() {
  const secrets = runtimeSecrets();
  const evmAccount = privateKeyToAccount(secrets.evmPrivateKey);
  const route = loadRouteConfig();
  if (getAddress(evmAccount.address) !== getAddress(secrets.evmAddress)) {
    throw new Error("MINI_DVN_EVM_PRIVATE_KEY does not match MINI_DVN_EVM_ADDRESS");
  }
  if (getAddress(evmAccount.address) !== getAddress(route.ethereum.expectedDeployer)) {
    throw new Error("EVM signer is not the configured Sepolia operator");
  }
  if (BigInt(secrets.starknetAddress) !== BigInt(route.starknet.expectedDeployer)) {
    throw new Error("Starknet address is not the configured Sepolia operator");
  }
  const evmPublic = createPublicClient({ chain: sepolia, transport: http(secrets.evmRpcUrl) });
  const evmWallet = createWalletClient({
    account: evmAccount,
    chain: sepolia,
    transport: http(secrets.evmRpcUrl),
  });
  const starknetProvider = new RpcProvider({ nodeUrl: secrets.starknetRpcUrl });
  const starknetAccount = new Account({
    provider: starknetProvider,
    address: secrets.starknetAddress,
    signer: secrets.starknetPrivateKey,
  });
  return { secrets, evmAccount, evmPublic, evmWallet, starknetProvider, starknetAccount };
}
