# Encrypted Secret Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除 macOS Keychain 正式依赖，以同一套 AES-256-GCM 加密凭据库支持本机源码、Docker 预演和云端 Docker。

**Architecture:** Remote 只依赖 `EncryptedFileSecretStore`。部署配置依据 profile 自动选择主密钥文件：`local-source` 使用仓库 `.local/secrets/mk_master_key`，`docker-preview/cloud` 使用 `/run/secrets/mk_master_key`；`MASTER_KEY_FILE` 只作为显式覆盖。密文统一写入 `DATA_DIR/secure/credentials.enc`，旧 Keychain 仅作为一次性读取迁移来源，迁移成功后删除旧项。

**Tech Stack:** Node.js 22 `node:crypto` AES-256-GCM、原子 JSON 文件、pnpm、Vitest、TypeScript。

---

### Task 1: 部署配置自动选择路径

**Files:**
- Modify: `apps/remote/src/config/deployment-config.ts`
- Modify: `apps/remote/test/config/deployment-config.test.ts`

- [x] **Step 1: 写 profile 路径测试**

验证 `local-source` 得到 `<workspace>/.local/secrets/mk_master_key`，两个容器 profile 得到 `/run/secrets/mk_master_key`，`MASTER_KEY_FILE` 和 `CREDENTIAL_VAULT_FILE` 可覆盖。

- [x] **Step 2: 删除 SecretBackend 分支并实现确定性路径规则**

```ts
const masterKeyFile = resolve(
  workspaceRoot,
  env.MASTER_KEY_FILE ?? (
    profile === "local-source"
      ? ".local/secrets/mk_master_key"
      : "/run/secrets/mk_master_key"
  ),
);
const credentialVaultFile = resolve(
  cwd,
  env.CREDENTIAL_VAULT_FILE ?? `${dataDir}/secure/credentials.enc`,
);
```

- [x] **Step 3: 运行配置测试**

Run: `pnpm --filter @kindergarten/remote test -- test/config/deployment-config.test.ts`

Expected: PASS。

### Task 2: 文件主密钥和初始化命令

**Files:**
- Create: `apps/remote/src/secrets/file-master-key.ts`
- Create: `apps/remote/src/secrets/secret-init.ts`
- Create: `apps/remote/test/secrets/file-master-key.test.ts`
- Modify: `apps/remote/package.json`
- Modify: `package.json`
- Modify: `.gitignore`

- [x] **Step 1: 写主密钥校验与拒绝覆盖测试**

覆盖 32 字节 base64、非普通文件、宽松权限、格式错误、已存在文件不覆盖。

- [x] **Step 2: 实现主密钥读取与生成**

```ts
export class FileMasterKeySource {
  constructor(readonly file: string) {}
  read(): Promise<Buffer>;
}

export async function initializeMasterKey(file: string): Promise<void> {
  // randomBytes(32)，目录 0700，文件以 wx/0600 创建。
}
```

- [x] **Step 3: 增加 `pnpm secret:init`**

命令使用和 Remote 完全相同的 deployment config，因此本机自动生成到 `.local/secrets/mk_master_key`，容器 profile 自动指向 `/run/secrets/mk_master_key`。

- [x] **Step 4: 运行主密钥测试**

Run: `pnpm --filter @kindergarten/remote test -- test/secrets/file-master-key.test.ts`

Expected: PASS。

### Task 3: AES-GCM 加密凭据库

**Files:**
- Create: `apps/remote/src/secrets/encrypted-file-secret-store.ts`
- Create: `apps/remote/test/secrets/encrypted-file-secret-store.test.ts`
- Modify: `apps/remote/src/mcp/secret-store.ts`

- [x] **Step 1: 写 write/read/delete 与安全测试**

验证磁盘不含明文、错误主密钥和篡改认证标签均失败、删除幂等、并发写不丢记录、env 引用保持只读。

- [x] **Step 2: 实现统一 Vault**

每个 Secret 使用独立 12 字节 IV，以 Secret key 作为 AAD；文件保存 `iv/ciphertext/authTag/updatedAt`，整个文档通过临时文件加 `rename` 原子替换。

- [x] **Step 3: 保留接口，删除 HostSecretStore Keychain 实现**

`SecretStore` 与 `WritableSecretStore` 保留为业务边界，生产组装改用 `EncryptedFileSecretStore`。

- [x] **Step 4: 运行 Vault 测试**

Run: `pnpm --filter @kindergarten/remote test -- test/secrets/encrypted-file-secret-store.test.ts`

Expected: PASS。

### Task 4: 旧 Keychain 一次性迁移

**Files:**
- Create: `apps/remote/src/secrets/legacy-keychain-reader.ts`
- Create: `apps/remote/test/secrets/legacy-keychain-migration.test.ts`
- Modify: `apps/remote/src/secrets/encrypted-file-secret-store.ts`

- [x] **Step 1: 写缺失 Vault 记录时的迁移测试**

旧记录读取成功后先原子写入 Vault，再删除 Keychain；Vault 已有记录时绝不访问 Keychain；非 macOS 不启用兼容读取。

- [x] **Step 2: 实现只读迁移适配器**

新凭据永远不写 Keychain。兼容适配器只处理遗留 key，迁移完成后正式读链只访问加密文件。

- [x] **Step 3: 运行迁移测试**

Run: `pnpm --filter @kindergarten/remote test -- test/secrets/legacy-keychain-migration.test.ts`

Expected: PASS。

### Task 5: Remote 组装、配置与文档收口

**Files:**
- Modify: `apps/remote/src/index.ts`
- Modify: `apps/remote/test/mcp/secret-store.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [x] **Step 1: Remote 使用统一文件 Vault**

```ts
const secrets = new EncryptedFileSecretStore(
  new FileMasterKeySource(deployment.masterKeyFile),
  deployment.credentialVaultFile,
  legacyKeychainReader(),
);
```

- [x] **Step 2: 明确零模型启动与缺失密钥行为**

没有 Vault 时 Remote 可零模型/Ollama 启动；第一次写入受管 API Key 时若缺少主密钥，返回运行 `pnpm secret:init` 的明确错误。已有 Vault 却缺少主密钥时启动失败。

- [x] **Step 3: 更新配置说明**

删除 `SECRET_BACKEND=keychain`，记录自动路径规则、Docker 只读挂载合同和主密钥不进入 Git/镜像/数据卷的不变量。

- [x] **Step 4: 运行全量验收**

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: PASS；仍为一个 Web 静态产物与两个 Node ESM bundle。

- [x] **Step 5: 主密钥与真实 dist 冒烟**

在临时目录执行初始化、写读删 Vault，并以空 Vault/无 Ollama 启动 Remote；确认 profile 自动路径测试通过且日志不含主密钥或 API Key。
