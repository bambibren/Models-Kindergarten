import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/sync";
import * as ast from "typescript/unstable/ast";
import { createScanner } from "typescript/unstable/ast/scanner";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scopes = readScopes(process.argv.slice(2));
const projects = [
  "apps/remote/tsconfig.json", "apps/web/tsconfig.json", "apps/evaluation-service/tsconfig.json",
  "packages/contracts/tsconfig.json",
  "packages/runtime-observation/tsconfig.json", "packages/evaluation-contract/tsconfig.json",
  "packages/evaluation-exporter/tsconfig.json",
];
const api = new API();
const snapshot = api.updateSnapshot({ openProjects: projects.map((file) => resolve(root, file)) });
const sourceFiles = new Map();
for (const project of snapshot.getProjects()) {
  for (const fileName of project.program.getSourceFileNames()) {
    const relativeName = relative(root, fileName);
    if (!isAuditedFile(relativeName) || !inScope(relativeName)) continue;
    const sourceFile = project.program.getSourceFile(fileName);
    if (sourceFile) sourceFiles.set(fileName, sourceFile);
  }
}

const missingProduction = [];
const missingTests = [];
const shortCore = [];
const englishOnly = [];
const englishComments = [];
const placeholderComments = [];
let functionCount = 0;
let declarationCount = 0;

for (const [fileName, sourceFile] of sourceFiles) {
  const text = await readFile(fileName, "utf8");
  for (const match of text.matchAll(/\/\*\* (?:完成「[^」\n]+」的局部职责，保持调用方约定并避免产生未受控副作用|为测试提供「[^」\n]+」辅助行为，保持输入固定并返回可断言结果)。 \*\//gu)) {
    const line = text.slice(0, match.index).split("\n").length;
    placeholderComments.push(`${relative(root, fileName)}:${line}`);
  }
  const scanner = createScanner(false, sourceFile.languageVariant, text);
  for (let token = scanner.scan(); token !== ast.SyntaxKind.EndOfFile; token = scanner.scan()) {
    if (token !== ast.SyntaxKind.SingleLineCommentTrivia && token !== ast.SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText();
    const commentToken = token === ast.SyntaxKind.MultiLineCommentTrivia || /^\/\/\s/u.test(comment);
    if (commentToken && /[A-Za-z]{4,}/u.test(comment) && !/[\u3400-\u9fff]{2,}/u.test(comment)) {
      const line = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenStart()).line + 1;
      englishComments.push(`${relative(root, fileName)}:${line} ${comment.replace(/\s+/gu, " ").slice(0, 120)}`);
    }
  }
  const visit = (node) => {
    const auditableFunction = ast.isFunctionLikeDeclaration(node) && !ast.isFunctionTypeNode(node);
    const auditableDeclaration = isExportedDeclaration(node);
    if (auditableFunction || auditableDeclaration) {
      if (auditableFunction) functionCount += 1;
      else declarationCount += 1;
      const comment = leadingExplanation(text, node.getStart(sourceFile));
      const item = locationOf(sourceFile, node, relative(root, fileName));
      if (!hasChineseExplanation(comment)) {
        (isTestFile(fileName) ? missingTests : missingProduction).push(item);
        if (comment && /[A-Za-z]{4,}/u.test(comment)) englishOnly.push(item);
      } else if (isCoreNode(node) && chineseLength(comment) < 12) {
        shortCore.push(item);
      }
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
}

snapshot.dispose();
api.close();
const groups = [
  ["生产代码缺少中文解释", missingProduction],
  ["测试代码缺少中文解释", missingTests],
  ["核心函数注释过短", shortCore],
  ["紧邻说明只有英文", englishOnly],
  ["代码中存在纯英文注释", englishComments],
  ["仍使用低信息模板注释", placeholderComments],
];
const failures = groups.reduce((total, [, items]) => total + items.length, 0);
if (failures > 0) {
  console.error(`中文注释审计失败：${sourceFiles.size} 个文件，${functionCount} 个函数节点，${declarationCount} 个导出声明。`);
  for (const [title, items] of groups) {
    if (items.length === 0) continue;
    console.error(`\n${title}（${items.length}）：`);
    items.slice(0, 300).forEach((item) => console.error(`- ${item}`));
    if (items.length > 300) console.error(`- 其余 ${items.length - 300} 项已省略`);
  }
  process.exitCode = 1;
} else {
  console.log(`中文注释审计通过：${sourceFiles.size} 个文件，${functionCount} 个函数节点，${declarationCount} 个导出声明均有中文解释。`);
}

/** 判断注释是否至少包含一个中文解释句，而不是只有符号或类型名。 */
function hasChineseExplanation(text) { return /[\u3400-\u9fff]{4,}/u.test(text.replace(/[`*_/#@-]/gu, "")); }

/** 读取节点紧邻的最后一段块注释或行注释。 */
function leadingExplanation(text, start) {
  const prefix = text.slice(Math.max(0, start - 1200), start);
  return prefix.match(/(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+)\s*$/u)?.[0] ?? "";
}

/** 统计注释中的中文字符数。 */
function chineseLength(text) { return [...text.matchAll(/[\u3400-\u9fff]/gu)].length; }

/** 导出的类、接口和类型别名是跨模块合同，必须有中文说明。 */
function isExportedDeclaration(node) {
  if (!(ast.isClassDeclaration(node) || ast.isInterfaceDeclaration(node) || ast.isTypeAliasDeclaration(node))) return false;
  return node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.ExportKeyword) === true;
}

/** 对公开函数、组件、Reducer、Parser 和路由工厂执行更严格长度检查。 */
function isCoreNode(node) {
  const name = node.name?.getText?.() ?? "";
  return node.modifiers?.some((modifier) => modifier.kind === ast.SyntaxKind.ExportKeyword) === true ||
    /(?:Reducer|Parser|Provider|Repository|Service|Runtime|Route|Component|Page|parse|read|validate|register)/u.test(name);
}

/** 转换为稳定的文件、行号和节点名称。 */
function locationOf(sourceFile, node, file) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const name = node.name?.getText?.() ?? node.parent?.name?.getText?.() ?? ast.formatSyntaxKind(node.kind);
  return `${file}:${line} ${name}`;
}

/** 解析重复的 --scope 参数；未传时审计全仓。 */
function readScopes(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === "--scope" && args[index + 1]) result.push(args[++index]);
  return result;
}

/** 判断文件是否位于用户指定审计范围。 */
function inScope(file) { return scopes.length === 0 || scopes.some((scope) => file === scope || file.startsWith(`${scope}/`)); }

/** 只审计工作区自身的 TS/TSX，不进入声明文件和生成物。 */
function isAuditedFile(file) { return /^(?:apps|packages)\/.+\.(?:ts|tsx)$/u.test(file) && !file.endsWith(".d.ts") && !file.includes("/dist/"); }

/** 测试文件单列，便于分批补齐。 */
function isTestFile(file) { return /(?:\/test\/|\.test\.tsx?$)/u.test(file); }
