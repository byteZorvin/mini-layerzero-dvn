import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ROOT, type DeploymentState } from "./config";

const DEPLOYMENT_PATH = path.join(PROJECT_ROOT, "deployments/sepolia.json");

export function saveDeployment(state: DeploymentState): void {
  fs.mkdirSync(path.dirname(DEPLOYMENT_PATH), { recursive: true });
  const next = { ...state, updatedAt: new Date().toISOString() };
  const temporary = `${DEPLOYMENT_PATH}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, DEPLOYMENT_PATH);
}
