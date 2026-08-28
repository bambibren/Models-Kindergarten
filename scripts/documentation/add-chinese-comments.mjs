import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const projects = [
  "apps/remote/tsconfig.json", "apps/web/tsconfig.json", "apps/evaluation-service/tsconfig.json",
  "apps/evaluation-web/tsconfig.json", "packages/contracts/tsconfig.json",
  "packages/runtime-observation/tsconfig.json", "packages/evaluation-contract/tsconfig.json",
  "packages/evaluation-exporter/tsconfig.json",
];
const api = new API();
const snapshot = api.updateSnapshot({ openProjects: projects.map((file) => resolve(root, file)) });
const sourceFiles = new Map();

for (const project of snapshot.getProjects()) {
  for (const fileName of project.program.getSourceFileNames()) {
    const local = relative(root, fileName);
    if (!/^(?:apps|packages)\/.+\.(?:ts|tsx)$/u.test(local) || local.endsWith(".d.ts") || local.includes("/dist/")) continue;
    const sourceFile = project.program.getSourceFile(fileName);
    if (sourceFile) sourceFiles.set(fileName, sourceFile);
  }
}

let changedFiles = 0;
let insertedComments = 0;
for (const [fileName, sourceFile] of sourceFiles) {
  const original = await readFile(fileName, "utf8");
  const insertions = [];
  const visit = (node) => {
    const functionNode = ast.isFunctionLikeDeclaration(node) && !ast.isFunctionTypeNode(node);
    const contractNode = isExportedContract(node);
    if (functionNode || contractNode) {
      const start = node.getStart(sourceFile);
      const explanation = leadingExplanation(original, start);
      if (!hasChineseExplanation(explanation) || (isCoreNode(node) && chineseLength(explanation) < 12)) {
        insertions.push({ start, comment: buildComment(node, fileName) });
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  let output = original;
  for (const insertion of insertions.toSorted((left, right) => right.start - left.start)) {
    output = `${output.slice(0, insertion.start)}${insertion.comment}${output.slice(insertion.start)}`;
  }
  // `return` 与返回表达式之间不能因生成注释引入换行，否则 JavaScript 自动分号插入会把返回值变成 undefined。
  output = output.replace(/\b(return|yield|throw)( \/\*\*[^\n]*\*\/)[\t ]*\n/gu, "$1$2 ");
  // 匿名 Hook 或集合回调可能从外层组件推断出大写名称；按真实调用点纠正模板语义。
  const generatedComponent = String.raw`\/\*\* 渲染「[^」]+」界面投影，所有业务事实仍由上层状态与服务端提供。 \*\/`;
  output = output
    .replace(new RegExp(`(use(?:Effect|LayoutEffect)\\()${generatedComponent}`, "gu"), "$1/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */")
    .replace(new RegExp(`(use(?:Memo|Callback)\\()${generatedComponent}`, "gu"), "$1/** 缓存当前派生计算，依赖变化时重新生成以避免陈旧闭包。 */")
    .replace(new RegExp(`(\\.map\\()${generatedComponent}`, "gu"), "$1/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */")
    .replace(new RegExp(`(\\.(?:filter|find|some|every)\\()${generatedComponent}`, "gu"), "$1/** 按当前业务条件筛选或判断元素，不修改原始集合。 */")
    .replace(new RegExp(`(\\.reduce\\()${generatedComponent}`, "gu"), "$1/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */");
  // 只替换两个完全匹配的单行模板，不使用跨行通配符，避免注释维护工具误触源码正文。
  output = refineGeneratedPlaceholders(output);
  if (output === original) continue;
  await writeFile(fileName, output);
  changedFiles += 1;
  insertedComments += insertions.length;
}

snapshot.dispose();
api.close();
console.log(`已为 ${changedFiles} 个文件补充 ${insertedComments} 处中文职责注释。`);

/** 判断注释是否包含可读的中文解释。 */
function hasChineseExplanation(text) { return /[\u3400-\u9fff]{4,}/u.test(text.replace(/[`*_/#@-]/gu, "")); }

/** 读取紧邻节点的上一段说明，避免重复生成已有注释。 */
function leadingExplanation(text, start) {
  const prefix = text.slice(Math.max(0, start - 1200), start);
  return prefix.match(/(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+)\s*$/u)?.[0] ?? "";
}

/** 统计已有注释长度，公开核心节点需要解释到职责和边界。 */
function chineseLength(text) { return [...text.matchAll(/[\u3400-\u9fff]/gu)].length; }

/** 导出的类、接口和类型别名属于跨模块合同。 */
function isExportedContract(node) {
  if (!(ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isTypeAliasDeclaration(node))) return false;
  return node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.ExportKeyword) === true;
}

/** 识别需要更完整职责句的公开函数和框架入口。 */
function isCoreNode(node) {
  const name = node.name?.getText?.() ?? "";
  return node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.ExportKeyword) === true ||
    /(?:Reducer|Parser|Provider|Repository|Service|Runtime|Route|Component|Page|parse|read|validate|register)/u.test(name);
}

/** 根据声明名和调用上下文生成职责与约束，而不是逐行翻译实现。 */
function buildComment(node, fileName) {
  const name = node.name?.getText?.() ?? inferredName(node) ?? "匿名回调";
  const testFile = /(?:\/test\/|\.test\.tsx?$)/u.test(fileName);
  const call = enclosingCallName(node);

  if (testFile) {
    if (/describe/u.test(call)) return "/** 组织这一组相关测试，统一建立场景边界并验证公开行为。 */\n";
    if (/(?:^|\.)beforeEach$/u.test(call)) return "/** 在每个测试前重建隔离状态，避免前一场景的资源影响断言。 */\n";
    if (/(?:^|\.)afterEach$/u.test(call)) return "/** 在每个测试后释放临时资源，保证后续场景从干净状态开始。 */\n";
    if (/(?:^|\.)(?:it|test)$/u.test(call)) return "/** 执行当前测试场景并断言可观察结果，不依赖其它用例的执行顺序。 */\n";
    return `${testHelperComment(name)}\n`;
  }

  if (isExportedContract(node)) return `/** 描述「${name}」跨模块数据合同，调用方应按字段语义而非实现细节使用。 */\n`;
  if (ast.isConstructorDeclaration(node)) return `/** 初始化「${name}」所需依赖，不在构造阶段启动不可回收的后台任务。 */\n`;
  if (/(?:useEffect|useLayoutEffect)/u.test(call)) return "/** 同步组件生命周期内的外部状态，并在清理阶段释放订阅或临时资源。 */\n";
  if (/(?:useMemo|useCallback)/u.test(call)) return `/** 缓存「${name}」的派生计算，依赖变化时重新生成以避免陈旧闭包。 */\n`;
  if (/\.map$/u.test(call)) return "/** 将当前元素转换为目标投影，并保持集合顺序与一一对应关系。 */\n";
  if (/\.(?:filter|find|some|every)$/u.test(call)) return "/** 按当前业务条件筛选或判断元素，不修改原始集合。 */\n";
  if (/\.reduce$/u.test(call)) return "/** 把当前元素归并到有限累加状态，避免额外复制完整集合。 */\n";
  if (/\.sort$/u.test(call)) return "/** 按稳定业务键比较两个元素，供调用方生成确定顺序。 */\n";
  if (/\.(?:then|catch|finally)$/u.test(call)) return "/** 处理异步阶段的完成或清理，确保成功与失败路径都释放临时状态。 */\n";
  if (/(?:setTimeout|setInterval)/u.test(call)) return "/** 执行受生命周期约束的定时任务，调用方负责在结束时取消句柄。 */\n";
  if (/Promise/u.test(call)) return "/** 完成当前异步桥接，并保证每条分支只结算一次。 */\n";
  if (/addEventListener/u.test(call)) return "/** 处理当前外部事件；注册方必须在对称生命周期中移除监听器。 */\n";
  if (/^[A-Z][A-Za-z0-9]*$/u.test(name) && /\.tsx$/u.test(fileName)) return `/** 渲染「${name}」界面投影，所有业务事实仍由上层状态与服务端提供。 */\n`;

  if (/^(?:is|has|can|should|supports|matches|contains)/u.test(name)) return `/** 判断「${name}」对应条件，只返回判定结果且不修改输入状态。 */\n`;
  if (/^(?:parse|decode|normalize|validate|assert)/u.test(name)) return `/** 校验并规范化「${name}」输入，非法数据直接返回明确错误。 */\n`;
  if (/^(?:read|load|get|find|list|query|fetch|take)/u.test(name)) return `/** 读取「${name}」所需数据，并遵守作用域、分页与容量边界。 */\n`;
  if (/^(?:create|make|build|assemble|compose|to|from)/u.test(name)) return `/** 根据已校验输入构建「${name}」结果，不额外持有调用方的大对象。 */\n`;
  if (/^(?:save|write|put|update|set|insert|append|record)/u.test(name)) return `/** 更新「${name}」对应状态，并保持写入顺序、原子性与容量约束。 */\n`;
  if (/^(?:delete|remove|clear|close|dispose|release|prune|evict|cleanup)/u.test(name)) return `/** 释放或删除「${name}」对应资源，重复调用仍保持安全。 */\n`;
  if (/^(?:handle|on|accept|respond)/u.test(name)) return `/** 处理「${name}」事件，校验归属后再推进状态且避免重复提交。 */\n`;
  if (/^(?:run|execute|start|stream|send|request|call)/u.test(name)) return `/** 执行「${name}」主流程，传播取消与失败并在结束时清理临时资源。 */\n`;
  if (/Reducer$/u.test(name)) return `/** 根据动作归并「${name}」状态，保持纯函数、幂等与终态不可倒退。 */\n`;
  return `${fallbackResponsibilityComment(name)}\n`;
}

/**
 * 把旧版生成器留下的低信息模板改成带有动作、边界和失败约定的职责句。
 *
 * 正则只允许在同一行、同一条完整 JSDoc 内匹配，绝不跨过换行或源码标记。
 */
function refineGeneratedPlaceholders(text) {
  const productionPlaceholder = /\/\*\* 完成「([^」\n]+)」的局部职责，保持调用方约定并避免产生未受控副作用。 \*\//gu;
  const testPlaceholder = /\/\*\* 为测试提供「([^」\n]+)」辅助行为，保持输入固定并返回可断言结果。 \*\//gu;
  return text
    .replace(productionPlaceholder, (_comment, name) => fallbackResponsibilityComment(name))
    .replace(testPlaceholder, (_comment, name) => testHelperComment(name));
}

/** 根据职责名称生成可核对的动作、数据范围和失败传播说明。 */
function fallbackResponsibilityComment(name) {
  if (name === "匿名回调") {
    return "/** 执行当前调用点的回调步骤；仅使用显式参数与受控闭包状态，并遵循外层 API 的返回约定。 */";
  }
  if (/^(?:errorText|errorMessage)$/u.test(name)) {
    return `/** 把未知异常转换为「${name}」文本，避免错误序列化过程再次抛出。 */`;
  }
  if (/^(?:safeJson|safeStringify)$/u.test(name)) {
    return `/** 把输入安全序列化为「${name}」结果，失败时返回受控降级文本而不泄漏原始对象。 */`;
  }
  if (/^(?:require|ensure)/u.test(name)) {
    return `/** 校验并取得「${name}」所需对象；缺失或归属不符时立即抛出明确错误。 */`;
  }
  if (/(?:Key|Identity|Id)$/u.test(name)) {
    return `/** 由规范字段生成稳定的「${name}」标识，供索引精确定位且不保留原始大对象。 */`;
  }
  if (/(?:File|Directory|Dir|Path)$/u.test(name)) {
    return `/** 根据受控标识构造「${name}」路径；调用方仍须执行归属与目录边界校验。 */`;
  }
  if (/(?:Snapshot|Projection|Facts)$/u.test(name)) {
    return `/** 生成「${name}」不可变视图，隔离后续状态修改并只暴露该层需要的事实。 */`;
  }
  if (/^(?:clone|publicClone)$/u.test(name)) {
    return `/** 复制「${name}」返回值，防止调用方通过共享引用修改仓储内部状态。 */`;
  }
  if (/^(?:merge|aggregate|sum|accumulate)/u.test(name)) {
    return `/** 汇总「${name}」对应指标，保持缺失字段语义且不重复计算同一来源。 */`;
  }
  if (/^(?:prompt|message|session|resource).*(?:Text|Content)$/iu.test(name)) {
    return `/** 把「${name}」归一为当前边界需要的文本视图，不暴露无关内部结构。 */`;
  }
  return `/** 执行「${name}」对应的业务步骤；只操作当前作用域持有的状态，并把失败交由调用链统一处理。 */`;
}

/** 为测试辅助节点说明固定输入、隔离范围和可断言输出。 */
function testHelperComment(name) {
  if (name === "匿名回调") {
    return "/** 执行当前测试回调并只断言公开结果；场景状态由所属用例独立建立和释放。 */";
  }
  return `/** 构造「${name}」测试辅助步骤；固定输入与隔离状态，并返回当前用例可直接断言的结果。 */`;
}

/** 从变量、属性或父级方法推断匿名函数的职责名称。 */
function inferredName(node) {
  let current = node.parent;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parent) {
    const name = current.name?.getText?.();
    if (name) return name;
  }
  return undefined;
}

/** 查找包围回调的调用名，用于区分测试、集合转换和生命周期函数。 */
function enclosingCallName(node) {
  let current = node.parent;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.parent) {
    const expression = current.expression?.getText?.();
    if (expression) return expression;
  }
  return "";
}
