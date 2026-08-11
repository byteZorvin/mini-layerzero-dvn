import type { Hex } from "viem";
import { deploy, deployReverse } from "./deploy";
import { runRelayPass } from "./engine";
import { migrateLegacyState } from "./migrate-state";
import { backfillHistoricalPackets, deliverSourceTransaction } from "./relay";
import { status } from "./status";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const command = process.argv[2];
if (command === "deploy") {
  await deploy(process.argv.includes("--execute"));
} else if (command === "deploy-reverse") {
  await deployReverse(process.argv.includes("--execute"));
} else if (command === "relay") {
  console.log(JSON.stringify(await runRelayPass(), null, 2));
} else if (command === "migrate-state") {
  const forward = option("--forward");
  const reverse = option("--reverse");
  if (!forward || !reverse) {
    throw new Error("Usage: cli.ts migrate-state --forward /path/sepolia.json --reverse /path/sepolia-reverse.json");
  }
  console.log(JSON.stringify(await migrateLegacyState(forward, reverse), null, 2));
} else if (command === "deliver") {
  const transactionHash = option("--tx") as Hex | undefined;
  if (!transactionHash) throw new Error("Usage: bun run deliver -- --tx 0x...");
  const record = await deliverSourceTransaction(transactionHash);
  console.log(JSON.stringify(record, null, 2));
} else if (command === "backfill") {
  console.log(JSON.stringify(await backfillHistoricalPackets(process.argv.includes("--execute")), null, 2));
} else if (command === "status") {
  await status();
} else {
  throw new Error("Usage: cli.ts deploy [--execute] | deploy-reverse [--execute] | relay | migrate-state --forward PATH --reverse PATH | deliver --tx 0x... | backfill [--execute] | status");
}
