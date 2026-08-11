import { Contract, shortString } from "starknet";
import { parseAbi } from "viem";
import { clients } from "./clients";
import { loadDeployment, loadRouteConfig } from "./config";
import { STARKNET_MINI_DVN_ABI } from "./runtime-abis";
import { createDirectionWorkers } from "./workers";

const MINI_DVN_ABI = parseAbi([
  "function sendUln() view returns (address)",
  "function oapp() view returns (address)",
  "function destinationEid() view returns (uint32)",
]);

export async function status(): Promise<void> {
  const route = loadRouteConfig();
  const deployment = loadDeployment();
  const { evmPublic, starknetProvider } = clients();
  if (!deployment.ethereum || !deployment.starknet) throw new Error("Deployment is incomplete");
  const contract = new Contract({
    abi: STARKNET_MINI_DVN_ABI,
    address: deployment.starknet.address,
    providerOrAccount: starknetProvider,
  });
  const [evmChainId, starknetChainId, code, sendUln, oapp, destinationEid, owner, receiveUln, funding] = await Promise.all([
    evmPublic.getChainId(),
    starknetProvider.getChainId(),
    evmPublic.getCode({ address: deployment.ethereum.address }),
    evmPublic.readContract({ abi: MINI_DVN_ABI, address: deployment.ethereum.address, functionName: "sendUln", args: [] }),
    evmPublic.readContract({ abi: MINI_DVN_ABI, address: deployment.ethereum.address, functionName: "oapp", args: [] }),
    evmPublic.readContract({ abi: MINI_DVN_ABI, address: deployment.ethereum.address, functionName: "destinationEid", args: [] }),
    contract.call("get_owner", []),
    contract.call("get_receive_uln", []),
    createDirectionWorkers().funding(),
  ]);
  const starknetChainName = String(starknetChainId).startsWith("0x")
    ? shortString.decodeShortString(String(starknetChainId))
    : String(starknetChainId);
  console.log(JSON.stringify({
    ethereum: {
      chainId: evmChainId,
      address: deployment.ethereum.address,
      hasCode: Boolean(code && code !== "0x"),
      sendUln,
      oapp,
      destinationEid: Number(destinationEid),
    },
    starknet: { chainId: starknetChainName, address: deployment.starknet.address, owner: String(owner), receiveUln: String(receiveUln) },
    funding,
    expected: route,
  }, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
}
