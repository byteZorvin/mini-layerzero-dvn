import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT } from "./config";

function readJson(filePath: string): any {
  if (!fs.existsSync(filePath)) throw new Error(`Missing build artifact ${filePath}; run bun run build`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function ethereumArtifact() {
  const artifact = readJson(
    path.join(PROJECT_ROOT, "contracts/ethereum/out/MiniDVN.sol/MiniDVN.json"),
  );
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
  };
}

export function ethereumReceiveArtifact() {
  const artifact = readJson(
    path.join(PROJECT_ROOT, "contracts/ethereum/out/MiniDVNReceive.sol/MiniDVNReceive.json"),
  );
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as `0x${string}`,
  };
}

export function starknetArtifacts() {
  const base = path.join(PROJECT_ROOT, "contracts/starknet/target/dev");
  return {
    sierra: readJson(path.join(base, "mini_dvn_MiniDVN.contract_class.json")),
    casm: readJson(path.join(base, "mini_dvn_MiniDVN.compiled_contract_class.json")),
  };
}

export function starknetSendArtifacts() {
  const base = path.join(PROJECT_ROOT, "contracts/starknet/target/dev");
  return {
    sierra: readJson(path.join(base, "mini_dvn_MiniDVNSend.contract_class.json")),
    casm: readJson(path.join(base, "mini_dvn_MiniDVNSend.compiled_contract_class.json")),
  };
}
