# PPTX 生成链路开发实现与验收

> 日期：2026-08-18
> 状态：代码与自动化回归已完成，等待用户执行外部 Skill + 大聪明配置化验收
> 关联方案：[`产物与HTML-PPT生成链路升级-trd.md`](./产物与HTML-PPT生成链路升级-trd.md)、[项目外 PPTX 子方案](</Users/bones/Documents/Codex/2026-08-18/Models-Kindergarten-产物链路调研/PPTX/PPTX生成链路子方案-trd.md>)

## 1. 最终实现范围

本次为 MK 增加通用 PPTX 技术链路，不内置 PPTX Skill、不创建默认 PPT Agent，也不把外部 Skill 的工具名称写入系统提示词。

已实现的主链是：

```text
外部 Skill 提供通用设计与编写指导
  → Agent 在当前 Session Workspace 写入 PptxGenJS 源码
  → 受控构建能力生成并检查指定 .pptx
  → 现有普通文件 Artifact 能力显式发布
  → 产物列表展示并提供标准 .pptx 下载
```

本次没有实现 PPTX 专用 Browser 预览。发布后的 `.pptx` 在产物列表和详情页中按普通文件展示，用户通过下载后使用 PowerPoint、Keynote 或兼容软件打开和编辑。

## 2. 根据讨论修正的正式边界

- MK 不内置 `/Users/bones/develop/mk-resource/skills/pptx`；该目录由独立本地资源服务提供。
- Skill 不包含 MK、Artifact、Mention、Worker 或任何平台 Tool 名称。
- Runtime 不根据 Skill 内容增加工具名映射，也不动态修改 Skill。
- 构建链路只生成调用方指定的 `.pptx`，不主动生成 PDF、逐页图片、总览图、字体文件或检查报告。
- 系统提示词不介绍其他输出格式，也不设置“PPT 任务禁止产生其他文件”的程序拦截。
- `build_pptx` 不调用生图 API、图片搜索或 MCP；图片从 Workspace 中已有素材读取。
- 用户 Mention 已发布图片时，既有 `read_artifact` 能力按 owner 校验后把同一 Blob 字节物化到当前 Workspace，构建源码直接引用该路径。
- 不允许跨用户读取 Artifact；不允许跨 Session 读取 Workspace。
- 同一用户跨 Session 只允许读取用户明确选择的已发布 Artifact Blob。
- 构建 permission 服从 Agent 配置。配置为 `allow` 时不弹确认框；不存在额外“一次高层确认”。
- 构建失败不自动重试，不改走已隐藏的命令能力；用户可以使用现有手动重试入口重新发起。

## 3. 实际代码结构

| 文件 | 职责 |
|---|---|
| `packages/contracts/src/product-config.ts` | 集中保存 PPTX 源码、输出、进程日志和构建超时边界 |
| `apps/remote/src/pptx/pptx-inspector.ts` | 在内存中读取 ZIP central directory，确认基础 OOXML 条目与幻灯片数量 |
| `apps/remote/src/pptx/pptx-build-service.ts` | 校验 FileSandbox 路径、启动受控 Node 子进程、限制环境和时间、验证输出哈希与 OOXML |
| `apps/remote/src/pptx/pptx-tool-provider.ts` | 提供可配置 Runtime Tool、Agent permission、Capability snapshot 和 Tool Result |
| `apps/remote/src/capability/runtime-capability-resolver.ts` | 按当前 Agent 的保存配置决定本 Turn 是否暴露 PPTX 能力 |
| `apps/remote/src/index.ts` | 把 PPTX 能力加入 Agent capability options；不自动修改已有 Agent，也不创建 PPT Agent |
| `apps/remote/src/artifacts/*` | 复用既有普通文件发布、Blob 存储、版本、下载和 Mention 物化能力 |

### 3.1 构建输入与输出

构建能力只接受两个字段：

```json
{
  "source_path": "deck/generate.cjs",
  "output_path": "deck/final.pptx"
}
```

- `source_path` 必须是当前 Session Workspace 内的 `.js`、`.cjs` 或 `.mjs` 相对 POSIX 路径。
- `output_path` 必须是当前 Session Workspace 内的 `.pptx` 相对 POSIX 路径。
- 不接受命令字符串、绝对路径、环境变量、URL、宿主机目录或附属输出路径。
- 源码必须实际更新指定输出；返回旧文件或没有写出目标文件会失败。

成功结果只返回：源码路径、PPTX 路径、SHA-256、字节数、幻灯片数和 OOXML 条目数。检查结果属于本次 Tool Result，不写入独立报告文件。

### 3.2 基础完整性检查

构建成功后，Remote 直接读取 `.pptx` 的 ZIP central directory，至少确认：

- ZIP end of central directory 与条目边界有效；
- 不存在重复 ZIP 条目；
- 包含 `[Content_Types].xml`；
- 包含 `_rels/.rels`；
- 包含 `ppt/presentation.xml`；
- 包含 `ppt/_rels/presentation.xml.rels`；
- 至少包含一张 `ppt/slides/slideN.xml`。

这一步只确认文件是基本完整的 PowerPoint OOXML 包，不把自动审美评分、渲染截图或跨客户端字体一致性冒充为程序保证。

### 3.3 受控进程

- 进程入口固定为当前 Node.js，不接受模型提供的命令或可执行文件。
- 子进程只收到 `PATH`、语言、临时目录和 PptxGenJS 模块路径，不继承模型、MCP、认证头或 API Key。
- macOS 使用 `sandbox-exec`：Workspace 可写、依赖只读、网络拒绝。
- Linux 使用独立 user/network namespace 与 Node permission model；部署镜像需要提供 `/usr/bin/unshare`。
- 超时或取消会终止整个进程组。
- 构建不自动重试。

### 3.4 容量配置

| 配置 | 初始值 |
|---|---:|
| PptxGenJS 源码 | 5 MiB |
| 最终 `.pptx` | 100 MiB |
| 构建时间 | 120 秒 |
| stdout/stderr 摘要 | 各链路合计最多 64 KiB |

这些是云端资源保护边界，不是页面数量、对象数量或设计复杂度限制。模型生成源码所花的时间不计入 120 秒构建时间。

## 4. Agent 配置与外部 Skill

### 4.1 外部资源地址

资源服务默认监听：

```text
http://127.0.0.1:7342
```

PPTX Skill 安装地址：

```text
http://127.0.0.1:7342/skills/pptx
```

MK 只下载该 URL 返回的只读 Skill Bundle；Skill 源码仍保存在 `/Users/bones/develop/mk-resource/skills/pptx`，没有复制进 MK 仓库。

### 4.2 建议的验收 Agent

用户在 MK 管理页自行新建 PPT Agent：

1. 模型选择“大聪明”。
2. 绑定从上述 URL 安装的 `pptx` Skill。
3. 启用文件读取、文件写入、PPTX 构建、Artifact 读取和 Artifact 发布所需能力。
4. 将写入、构建和发布配置为 `allow`，避免构建确认弹窗。
5. 不需要启用命令能力；当前产品也不会向模型暴露该能力。

MK 不会自动创建这个 Agent，也不会静默修改已有 Agent 的配置。

## 5. 用户可见效果

- 新建或编辑 Agent 时，能力列表中出现 `build_pptx`，默认不勾选；用户勾选后按保存配置生效。
- 大聪明可在当前 Session 写入 PptxGenJS 源码并生成标准 `.pptx`。
- 构建成功本身不会制造预览入口；发布成功后，文件进入“我的 Artifacts”。
- 产物详情显示文件名、MIME、大小、SHA-256、版本和来源 Session/Turn。
- 用户下载得到的字节就是构建产生并存入 Artifact Blob Store 的 `.pptx`。
- 同一内容仍享受 Artifact Blob SHA-256 去重、vN、覆盖和回滚能力。
- Mention 已有图片或 PPTX 时，可以从 Artifact Blob 物化到当前 Workspace；不会读取原 Session Workspace。

## 6. 验收清单

### A. 外部 Skill 与 Agent 配置

- [ ] 打开 `http://127.0.0.1:7342/health` 返回 `ok=true`。
- [ ] 打开 `http://127.0.0.1:7342/skills` 能看到 `pptx`。
- [ ] 打开 `http://127.0.0.1:7342/skills/pptx` 返回合法 Skill Bundle。
- [ ] 在 MK 安装上述 URL 后，Skill 状态为 ready。
- [ ] 新建 PPT Agent，选择大聪明并绑定该 Skill。
- [ ] Agent 能力列表中可以选择 `build_pptx`，保存为 `allow` 后不弹构建确认。
- [ ] MK 仓库中不存在内置 PPTX Skill 或默认 PPT Agent 数据。

### B. 基础生成链路

- [ ] 输入一个明确的 PPT 主题、受众和页数要求。
- [ ] Agent 激活外部 Skill，并在当前 Workspace 写入 PptxGenJS 源码。
- [ ] Agent 调用构建能力，结果返回 `.pptx` 路径、SHA-256、字节数和页数。
- [ ] Workspace 没有由 MK 主动生成 PDF、逐页图、总览图或检查报告。
- [ ] Agent 显式发布 `.pptx` 后，最终回复包含 Artifact 链接。
- [ ] “我的 Artifacts”出现该 `.pptx`，刷新页面后仍存在。
- [ ] 下载文件扩展名、MIME 和实际内容均为标准 `.pptx`。

### C. PowerPoint 文件质量

- [ ] 使用 PowerPoint 或兼容软件打开下载文件，不出现文件损坏提示。
- [ ] 幻灯片数量与任务要求一致。
- [ ] 文本框、原生形状和原生图表可以继续编辑，不是整页截图。
- [ ] 已提供的图片保持比例，无明显拉伸。
- [ ] 中文文字可见；使用的字体不要求 MK 生成或附带字体文件。
- [ ] 修改一段文本并另存后，文件仍可打开。

### D. Mention 与素材复用

- [ ] 在输入框 Mention 当前用户已发布的图片 Artifact。
- [ ] Agent 读取时，图片 Blob 被原样物化到当前 Session Workspace。
- [ ] 物化前后的 SHA-256 一致。
- [ ] PPTX 中使用的是该文件内容；MK 构建能力不会自动调用生图 API。
- [ ] 尝试读取其他用户 Artifact 时返回不存在。
- [ ] 尝试读取另一个 Session 的 Workspace 相对路径时被拒绝。

### E. 失败与重试

- [ ] 源码扩展名不是 `.js/.cjs/.mjs` 时，构建在执行前失败。
- [ ] 输出扩展名不是 `.pptx` 或路径越界时，构建在执行前失败。
- [ ] 源码进程非零退出时，返回执行失败，不发布旧文件或伪造成功。
- [ ] 输出不是有效 OOXML 或没有幻灯片时，返回结构错误。
- [ ] 超过 120 秒时终止进程组并返回超时。
- [ ] 取消 Turn 时终止构建。
- [ ] 任何失败均不自动重试；用户手动重试后才会重新执行。

### F. 回归

- [ ] HTML Bundle 发布与 JavaScript 预览保持正常。
- [ ] 普通文件 Artifact 发布、下载、归档、恢复、版本和回滚保持正常。
- [ ] Composer 的 textarea + Mention Tag 行为保持正常。
- [ ] ACP load/resume、单 Prompt、Permission/Elicitation 分离保持正常。
- [ ] MCP 与 Skill 仍只从 Remote Runtime 接入并经过 ToolRuntime。

## 7. 自动化验证映射

| 自动化测试 | 覆盖内容 |
|---|---|
| `pptx-inspector.test.ts` | ZIP/OOXML 条目、页数、损坏文件 |
| `pptx-build-service.test.ts` | 路径、真实 PptxGenJS 构建、错误、取消、无自动重试 |
| `pptx-tool-provider.test.ts` | Tool Schema、permission=allow、无直接预览、Capability snapshot |
| `runtime-capability-resolver.test.ts` | Agent 未启用时隐藏、启用后进入当前 Turn |
| `pptx-artifact-chain.test.ts` | build → publish → download → Mention 物化字节一致 |

视觉设计质量和 PowerPoint 客户端编辑体验属于配置化人工验收；程序测试不伪造这两项结论。
