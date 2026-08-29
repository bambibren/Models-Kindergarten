import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readDeploymentConfig } from "../config/deployment-config.js";
import { initializeMasterKey } from "./file-master-key.js";

const workspaceRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const deployment = readDeploymentConfig(process.env, process.cwd(), workspaceRoot);
await initializeMasterKey(deployment.masterKeyFile);
console.log(`MK 主密钥已创建: ${deployment.masterKeyFile}`);
