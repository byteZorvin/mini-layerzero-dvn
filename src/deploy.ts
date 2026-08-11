import { CallData, Contract, shortString } from "starknet";
import { getAddress, type Hex } from "viem";
import {
  ethereumArtifact,
  ethereumReceiveArtifact,
  starknetArtifacts,
  starknetSendArtifacts,
} from "./artifacts";
import { clients } from "./clients";
import {
  loadRouteConfig,
  loadDeployment,
  type DeploymentState,
} from "./config";
import { saveDeployment } from "./local-deployment";

function sameFelt(a: string, b: string): boolean {
  return BigInt(a) === BigInt(b);
}

export async function deploy(execute: boolean): Promise<void> {
  const route = loadRouteConfig();
  const evmArtifact = ethereumArtifact();
  const starkArtifacts = starknetArtifacts();
  const { secrets, evmAccount, evmPublic, evmWallet, starknetProvider, starknetAccount } = clients();

  const [evmChainId, starknetChainId] = await Promise.all([
    evmPublic.getChainId(),
    starknetProvider.getChainId(),
  ]);
  if (evmChainId !== route.ethereum.chainId) throw new Error(`Unexpected EVM chain ${evmChainId}`);
  const starknetChainName = String(starknetChainId).startsWith("0x")
    ? shortString.decodeShortString(String(starknetChainId))
    : String(starknetChainId);
  if (starknetChainName !== route.starknet.chainId) {
    throw new Error(`Unexpected Starknet chain ${starknetChainName}`);
  }
  if (getAddress(evmAccount.address) !== getAddress(route.ethereum.expectedDeployer)) {
    throw new Error("EVM signer is not the configured ArcX owner/delegate");
  }
  if (!sameFelt(secrets.starknetAddress, route.starknet.expectedDeployer)) {
    throw new Error("Starknet signer is not the configured ArcX owner/delegate");
  }

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    ethereum: {
      chainId: evmChainId,
      signer: evmAccount.address,
      contract: "MiniDVN",
      constructor: [route.ethereum.sendUln, route.ethereum.oapp, route.starknet.eid],
    },
    starknet: {
      chainId: starknetChainName,
      signer: secrets.starknetAddress,
      contract: "MiniDVN",
      constructor: [secrets.starknetAddress, route.starknet.receiveUln],
    },
  }, null, 2));
  if (!execute) return;

  const state: DeploymentState = { network: "sepolia", updatedAt: new Date().toISOString() };
  const evmHash = await evmWallet.deployContract({
    abi: evmArtifact.abi,
    bytecode: evmArtifact.bytecode,
    args: [route.ethereum.sendUln, route.ethereum.oapp, route.starknet.eid],
  });
  const evmReceipt = await evmPublic.waitForTransactionReceipt({ hash: evmHash });
  if (evmReceipt.status !== "success" || !evmReceipt.contractAddress) {
    throw new Error(`EVM MiniDVN deployment failed: ${evmHash}`);
  }
  state.ethereum = {
    address: evmReceipt.contractAddress,
    transactionHash: evmHash,
    deploymentBlock: evmReceipt.blockNumber.toString(),
  };
  saveDeployment(state);

  const declaration = await starknetAccount.declareIfNot({
    contract: starkArtifacts.sierra,
    casm: starkArtifacts.casm,
  });
  if (declaration.transaction_hash) {
    await starknetProvider.waitForTransaction(declaration.transaction_hash);
  }
  const deployResponse = await starknetAccount.deployContract({
    classHash: declaration.class_hash,
    constructorCalldata: CallData.compile({
      owner: secrets.starknetAddress,
      receive_uln: route.starknet.receiveUln,
    }),
  });
  await starknetProvider.waitForTransaction(deployResponse.transaction_hash);
  if (!deployResponse.contract_address) throw new Error("Starknet deployment returned no address");
  state.starknet = {
    address: deployResponse.contract_address as Hex,
    classHash: declaration.class_hash as Hex,
    declareTransactionHash: declaration.transaction_hash as Hex | undefined,
    deployTransactionHash: deployResponse.transaction_hash as Hex,
  };

  const contract = new Contract({
    abi: starkArtifacts.sierra.abi,
    address: deployResponse.contract_address,
    providerOrAccount: starknetProvider,
  });
  const [owner, receiveUln] = await Promise.all([
    contract.call("get_owner", []),
    contract.call("get_receive_uln", []),
  ]);
  if (!sameFelt(String(owner), secrets.starknetAddress)) throw new Error("Starknet owner readback failed");
  if (!sameFelt(String(receiveUln), route.starknet.receiveUln)) throw new Error("Starknet ULN readback failed");

  saveDeployment(state);
  console.log(JSON.stringify(state, null, 2));
}

export async function deployReverse(execute: boolean): Promise<void> {
  const route = loadRouteConfig();
  const evmArtifact = ethereumReceiveArtifact();
  const starkArtifacts = starknetSendArtifacts();
  const { secrets, evmAccount, evmPublic, evmWallet, starknetProvider, starknetAccount } = clients();
  const [evmChainId, starknetChainId] = await Promise.all([
    evmPublic.getChainId(),
    starknetProvider.getChainId(),
  ]);
  const starknetChainName = String(starknetChainId).startsWith("0x")
    ? shortString.decodeShortString(String(starknetChainId))
    : String(starknetChainId);
  if (evmChainId !== route.ethereum.chainId || starknetChainName !== route.starknet.chainId) {
    throw new Error("Unexpected deployment network");
  }
  if (getAddress(evmAccount.address) !== getAddress(route.ethereum.expectedDeployer)) {
    throw new Error("EVM signer is not the configured ArcX owner/delegate");
  }
  if (!sameFelt(secrets.starknetAddress, route.starknet.expectedDeployer)) {
    throw new Error("Starknet signer is not the configured ArcX owner/delegate");
  }

  const sourceOapp = `0x${BigInt(route.starknet.oapp).toString(16).padStart(64, "0")}` as Hex;
  const destinationOapp = `0x${route.ethereum.oapp.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    ethereumReceive: {
      contract: "MiniDVNReceive",
      constructor: [
        evmAccount.address,
        route.ethereum.receiveUln,
        route.starknet.eid,
        sourceOapp,
        route.ethereum.eid,
        destinationOapp,
        route.starknetConfirmations,
      ],
    },
    starknetSend: {
      contract: "MiniDVNSend",
      constructor: [
        route.starknet.sendUln,
        route.starknet.oapp,
        route.ethereum.eid,
        route.starknetConfirmations,
      ],
    },
  }, null, 2));
  if (!execute) return;

  const state = loadDeployment();
  const evmHash = await evmWallet.deployContract({
    abi: evmArtifact.abi,
    bytecode: evmArtifact.bytecode,
    args: [
      evmAccount.address,
      route.ethereum.receiveUln,
      route.starknet.eid,
      sourceOapp,
      route.ethereum.eid,
      destinationOapp,
      BigInt(route.starknetConfirmations),
    ],
  });
  const evmReceipt = await evmPublic.waitForTransactionReceipt({ hash: evmHash });
  if (evmReceipt.status !== "success" || !evmReceipt.contractAddress) {
    throw new Error(`EVM receive MiniDVN deployment failed: ${evmHash}`);
  }
  state.ethereumReceive = {
    address: evmReceipt.contractAddress,
    transactionHash: evmHash,
    deploymentBlock: evmReceipt.blockNumber.toString(),
  };
  saveDeployment(state);

  const declaration = await starknetAccount.declareIfNot({
    contract: starkArtifacts.sierra,
    casm: starkArtifacts.casm,
  });
  if (declaration.transaction_hash) await starknetProvider.waitForTransaction(declaration.transaction_hash);
  const deployResponse = await starknetAccount.deployContract({
    classHash: declaration.class_hash,
    constructorCalldata: CallData.compile({
      send_uln: route.starknet.sendUln,
      oapp: route.starknet.oapp,
      destination_eid: route.ethereum.eid,
      expected_confirmations: route.starknetConfirmations,
    }),
  });
  const waitReceipt = await starknetProvider.waitForTransaction(deployResponse.transaction_hash);
  if (!deployResponse.contract_address) throw new Error("Starknet send deployment returned no address");
  const receiptValue = (waitReceipt as unknown as { value?: { block_number?: number }; block_number?: number });
  const deploymentBlock = receiptValue.value?.block_number ?? receiptValue.block_number;
  if (deploymentBlock === undefined) throw new Error("Starknet deployment receipt has no block number");
  state.starknetSend = {
    address: deployResponse.contract_address as Hex,
    classHash: declaration.class_hash as Hex,
    declareTransactionHash: declaration.transaction_hash as Hex | undefined,
    deployTransactionHash: deployResponse.transaction_hash as Hex,
    deploymentBlock: String(deploymentBlock),
  };
  saveDeployment(state);

  const contract = new Contract({
    abi: starkArtifacts.sierra.abi,
    address: deployResponse.contract_address,
    providerOrAccount: starknetProvider,
  });
  const [sendUln, oapp, destinationEid, confirmations] = await Promise.all([
    contract.call("get_send_uln", []),
    contract.call("get_oapp", []),
    contract.call("get_destination_eid", []),
    contract.call("get_expected_confirmations", []),
  ]);
  if (!sameFelt(String(sendUln), route.starknet.sendUln) || !sameFelt(String(oapp), route.starknet.oapp)) {
    throw new Error("Starknet send worker readback failed");
  }
  if (Number(destinationEid) !== route.ethereum.eid || Number(confirmations) !== route.starknetConfirmations) {
    throw new Error("Starknet send worker route readback failed");
  }
  console.log(JSON.stringify(state, null, 2));
}
