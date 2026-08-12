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
      constructor: [evmAccount.address, route.ethereum.sendUln, route.ethereum.oapp, route.starknet.eid],
    },
    starknet: {
      chainId: starknetChainName,
      signer: secrets.starknetAddress,
      contract: "MiniDVN",
      constructor: [secrets.starknetAddress, route.starknet.receiveUln],
    },
  }, null, 2));
  if (!execute) return;

  const state: DeploymentState = loadDeployment();
  if (!state.ethereum) {
    const evmHash = await evmWallet.deployContract({
      abi: evmArtifact.abi,
      bytecode: evmArtifact.bytecode,
      args: [evmAccount.address, route.ethereum.sendUln, route.ethereum.oapp, route.starknet.eid],
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
  }

  if (!state.starknet) {
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
      declareTransactionHash: declaration.transaction_hash
        ? declaration.transaction_hash as Hex
        : undefined,
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
  }
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
        secrets.starknetAddress,
        route.starknet.sendUln,
        route.starknet.oapp,
        route.ethereum.eid,
        route.starknetConfirmations,
      ],
    },
  }, null, 2));
  if (!execute) return;

  const state = loadDeployment();
  if (!state.ethereumReceive) {
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
  }

  if (!state.starknetSend) {
    const declaration = await starknetAccount.declareIfNot({
      contract: starkArtifacts.sierra,
      casm: starkArtifacts.casm,
    });
    if (declaration.transaction_hash) await starknetProvider.waitForTransaction(declaration.transaction_hash);
    const deployResponse = await starknetAccount.deployContract({
      classHash: declaration.class_hash,
      constructorCalldata: CallData.compile({
        owner: secrets.starknetAddress,
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
      declareTransactionHash: declaration.transaction_hash
        ? declaration.transaction_hash as Hex
        : undefined,
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
  }
  console.log(JSON.stringify(state, null, 2));
}

function asBytes32(value: string): Hex {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}` as Hex;
}

function sameAddress(a: string, b: string): boolean {
  return getAddress(a) === getAddress(b);
}

export async function configure(execute: boolean): Promise<void> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  if (!deployment.ethereum || !deployment.starknet || !deployment.ethereumReceive || !deployment.starknetSend) {
    throw new Error("MiniDVN deployment metadata is incomplete");
  }

  const evmForwardArtifact = ethereumArtifact();
  const evmReverseArtifact = ethereumReceiveArtifact();
  const starknetForwardArtifact = starknetArtifacts();
  const starknetReverseArtifact = starknetSendArtifacts();
  const { secrets, evmAccount, evmPublic, evmWallet, starknetProvider, starknetAccount } = clients();
  const sourceOapp = asBytes32(route.starknet.oapp);
  const destinationOapp = asBytes32(route.ethereum.oapp);

  const forward = new Contract({
    abi: starknetForwardArtifact.sierra.abi,
    address: deployment.starknet.address,
    providerOrAccount: starknetProvider,
  });
  const reverse = new Contract({
    abi: starknetReverseArtifact.sierra.abi,
    address: deployment.starknetSend.address,
    providerOrAccount: starknetProvider,
  });
  const [
    evmForwardOwner,
    evmForwardSendUln,
    evmForwardOapp,
    evmForwardDestinationEid,
    evmReverseOwner,
    evmReverseReceiveUln,
    evmReverseSourceEid,
    evmReverseSourceOapp,
    evmReverseDestinationEid,
    evmReverseDestinationOapp,
    evmReverseConfirmations,
    starknetForwardOwner,
    starknetForwardReceiveUln,
    starknetReverseOwner,
    starknetReverseSendUln,
    starknetReverseOapp,
    starknetReverseDestinationEid,
    starknetReverseConfirmations,
  ] = await Promise.all([
    evmPublic.readContract({ abi: evmForwardArtifact.abi, address: deployment.ethereum.address, functionName: "owner", args: [] }),
    evmPublic.readContract({ abi: evmForwardArtifact.abi, address: deployment.ethereum.address, functionName: "sendUln", args: [] }),
    evmPublic.readContract({ abi: evmForwardArtifact.abi, address: deployment.ethereum.address, functionName: "oapp", args: [] }),
    evmPublic.readContract({ abi: evmForwardArtifact.abi, address: deployment.ethereum.address, functionName: "destinationEid", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "owner", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "receiveUln", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "sourceEid", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "sourceOapp", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "destinationEid", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "destinationOapp", args: [] }),
    evmPublic.readContract({ abi: evmReverseArtifact.abi, address: deployment.ethereumReceive.address, functionName: "expectedConfirmations", args: [] }),
    forward.call("get_owner", []),
    forward.call("get_receive_uln", []),
    reverse.call("get_owner", []),
    reverse.call("get_send_uln", []),
    reverse.call("get_oapp", []),
    reverse.call("get_destination_eid", []),
    reverse.call("get_expected_confirmations", []),
  ]);

  if (!sameAddress(String(evmForwardOwner), evmAccount.address) || !sameAddress(String(evmReverseOwner), evmAccount.address)) {
    throw new Error("EVM operator is not the owner of both configurable MiniDVN contracts");
  }
  if (!sameFelt(String(starknetForwardOwner), secrets.starknetAddress) ||
      !sameFelt(String(starknetReverseOwner), secrets.starknetAddress)) {
    throw new Error("Starknet operator is not the owner of both configurable MiniDVN contracts");
  }

  const changes = {
    ethereumForward:
      !sameAddress(String(evmForwardSendUln), route.ethereum.sendUln) ||
      !sameAddress(String(evmForwardOapp), route.ethereum.oapp) ||
      Number(evmForwardDestinationEid) !== route.starknet.eid,
    starknetForward: !sameFelt(String(starknetForwardReceiveUln), route.starknet.receiveUln),
    ethereumReverse:
      !sameAddress(String(evmReverseReceiveUln), route.ethereum.receiveUln) ||
      Number(evmReverseSourceEid) !== route.starknet.eid ||
      String(evmReverseSourceOapp).toLowerCase() !== sourceOapp.toLowerCase() ||
      Number(evmReverseDestinationEid) !== route.ethereum.eid ||
      String(evmReverseDestinationOapp).toLowerCase() !== destinationOapp.toLowerCase() ||
      Number(evmReverseConfirmations) !== route.starknetConfirmations,
    starknetReverse:
      !sameFelt(String(starknetReverseSendUln), route.starknet.sendUln) ||
      !sameFelt(String(starknetReverseOapp), route.starknet.oapp) ||
      Number(starknetReverseDestinationEid) !== route.ethereum.eid ||
      Number(starknetReverseConfirmations) !== route.starknetConfirmations,
  };
  console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", changes, route }, null, 2));
  if (!execute || !Object.values(changes).some(Boolean)) return;

  if (changes.ethereumForward) {
    const hash = await evmWallet.writeContract({
      abi: evmForwardArtifact.abi,
      address: deployment.ethereum.address,
      functionName: "setRoute",
      args: [route.ethereum.sendUln, route.ethereum.oapp, route.starknet.eid],
    });
    const receipt = await evmPublic.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Ethereum forward configuration failed: ${hash}`);
  }
  if (changes.starknetForward) {
    const contract = new Contract({
      abi: starknetForwardArtifact.sierra.abi,
      address: deployment.starknet.address,
      providerOrAccount: starknetAccount,
    });
    const transaction = await contract.invoke("set_receive_uln", [route.starknet.receiveUln]);
    await starknetProvider.waitForTransaction(transaction.transaction_hash);
  }
  if (changes.ethereumReverse) {
    const hash = await evmWallet.writeContract({
      abi: evmReverseArtifact.abi,
      address: deployment.ethereumReceive.address,
      functionName: "setRoute",
      args: [
        route.ethereum.receiveUln,
        route.starknet.eid,
        sourceOapp,
        route.ethereum.eid,
        destinationOapp,
        BigInt(route.starknetConfirmations),
      ],
    });
    const receipt = await evmPublic.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Ethereum reverse configuration failed: ${hash}`);
  }
  if (changes.starknetReverse) {
    const contract = new Contract({
      abi: starknetReverseArtifact.sierra.abi,
      address: deployment.starknetSend.address,
      providerOrAccount: starknetAccount,
    });
    const transaction = await contract.invoke("set_route", [
      route.starknet.sendUln,
      route.starknet.oapp,
      route.ethereum.eid,
      route.starknetConfirmations,
    ]);
    await starknetProvider.waitForTransaction(transaction.transaction_hash);
  }
  await configure(false);
}
