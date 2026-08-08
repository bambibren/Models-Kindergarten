import { resolve } from "node:path";
import { EvaluationRepository } from "./repository.js";
import { EvaluationServer } from "./server.js";

const host = process.env.EVALUATION_HOST ?? "127.0.0.1";
const port = integerEnv("EVALUATION_PORT", 7441);
const dataDir = resolve(process.env.EVALUATION_DATA_DIR ?? ".data/evaluation");
const server = new EvaluationServer(new EvaluationRepository(dataDir));

await server.listen(host, port);
console.log(`Kindergarten Evaluation API: http://${host}:${port}`);
console.log(`Evaluation data: ${dataDir}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
