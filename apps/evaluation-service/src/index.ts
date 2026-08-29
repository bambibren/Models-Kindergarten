import { resolve } from "node:path";
import { EvaluationRepository } from "./repository.js";
import { EvaluationServer } from "./server.js";

const host = process.env.EVALUATION_HOST ?? "127.0.0.1";
const port = integerEnv("EVALUATION_PORT", 7441);
const dataDir = resolve(process.env.EVALUATION_DATA_DIR ?? ".data/evaluation");
const repository = new EvaluationRepository(dataDir);
await repository.initialize();
const server = new EvaluationServer(repository);

await server.listen(host, port);
console.log(`Kindergarten Evaluation API: http://${host}:${port}`);
console.log(`Evaluation data: ${dataDir}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, /** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */
() => {
    void server.close().finally(/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */
() => process.exit(0));
  });
}

/** 执行「integerEnv」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */
function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}
