# Demo 到真实产品实现状态与验证记录

> 对应主方案：[Demo 到真实产品实施 TRD](./DEMO_TO_PRODUCTION_TRD.md)  
> 实现版本：D2P-1.3  
> 验证日期：2026-08-13

## 1. 实现结论

Demo 中除明确调研留白外的主功能已经接入真实 Remote、ACP Runtime、持久化 Store 和生产路由。生产页面不读取 Demo `sessionStorage`，不使用定时器伪造安装、连接或实验完成，也不按演示 Prompt 分支返回写死业务数据。

本轮明确不实现模型入园、小说真实创作、Bearer Token 小说 MCP 和自动评分模型。首页保留不可点击的“小说创作 · 功能调研中”卡片；生产路由不注册 `/model-admission`。

## 2. 人工标注题目的真实程序路径

这里的“人工标注”分为模型出题和人工判断两步，模型不会替人打分。

1. A/B/C lane 全部结束后，evaluation-web 请求 `POST /experiments/{experimentId}/annotation-worksheet`。
2. Remote 从持久化 Experiment 读取原始问题、各 lane 最终回答和 Runtime Tool 事件，并由服务器先把每条原回答拆成带稳定编号的文本单元。
3. Remote 每个新 Experiment 都调用该实验绑定的 ModelStudent 一次，要求它返回严格 JSON：
   - `requirements`：分析原始任务并合并重复需求，生成公共人工判断项；
   - `workflows`：逐 lane 从回答和真实 Tool 过程提取实际 Workflow 步骤；
   - `outputSections`：逐 lane 把全部文本单元分成首尾相接的结果段。
4. 这次请求不提供 Tools，并关闭支持该参数的 Provider 推理模式；模型只能整理题目，不能返回 `verdict`、分数、排名或 winner。
5. Remote 校验所有 lane 都出现且 Workflow 不为空；模型的分段编号只作为边界建议，小模型出现跳号、重叠或越界时由服务器按模型给出的段落顺序和标签规范化，最终强制从 0 开始、首尾相接并完整覆盖原回答，再保存连续字符区间和原文 hash。
6. 校验通过的工作表持久化到 Experiment，包含生成模型、Provider、Prompt 版本、输入 hash、输出 hash和生成时间。页面刷新只读取这份结果，不重复调用模型。
7. 人分别判断需求是否命中、Workflow 步骤是否有效、结果段是否有效。服务端把人工事实计算为理解、规划、输出三维；Runtime Trace 按确定性规则生成执行维。
8. 三个人工维度全部完成后，服务端按四维等权生成总分、雷达图、排名和 winner。模型出题不属于自动评分。

失败时页面保留可操作错误和重试入口；重试会重新调用模型。用户显式选择“重新生成题目”时也会重新调用模型，并删除基于旧题目的 Scorecard，避免题目和答案错配。

## 3. 已落地模块

| 模块 | 实际落地 |
| --- | --- |
| Agent | 真实 Repository/Service、内置工具/Skill/MCP/history 策略编辑；Agent 只影响后续 Turn，无归档、迁移、ETag 或会话内换 Agent。 |
| Session/Turn | Session 固定绑定 ModelStudent 与 Agent；Turn 保存 Agent、能力、上下文和 Runtime 快照；普通列表隐藏实验 Session。 |
| Skill | 手动安装任务、失败重试、显式 GitHub 地址触发 `ensure_agent_skills`、同源/同名复用或更新、同 Turn 能力刷新。模糊需求不会自动找地址安装。 |
| MCP | 无认证 Remote MCP 的安装测试、连接、重连、禁用和卸载；Agent 按安装记录绑定，Runtime 再校验；Bearer 写入接口缺席。 |
| FileReference | `write_file` 产物复制为 Session 范围的不可变文件引用；聊天用 opaque ID 打开安全预览，拒绝路径、符号链接和跨 Session 越权。 |
| Context Lab | fresh/history 两种实验；服务端生成真实 Provider 输入预览；history A 复用原 Turn 且不重跑，B/C 通过隐藏 ACP Session 使用正式 Runtime。 |
| Evaluation | 真实回答、运行事实、模型生成标注工作表、三维人工判断、Runtime 执行分、四维总分/雷达/排名/winner 全部可持久恢复。 |
| 产品页面 | 首页、固定身份 Session、Agent 编辑、“我的”资源中心、MCP 管理、Context Lab 与独立 evaluation-web 生产路由。 |
| 安全与恢复 | loopback/Origin 限制、统一 Problem Detail/requestId、版本化 JSON Store、原子落盘与重启恢复、实验运行失败/取消终态。 |

## 4. 验证结果

### 4.1 自动化

- `pnpm -r typecheck`：8 个工作区项目全部通过。
- `pnpm -r test`：37 个测试文件、116 个测试全部通过。
- `pnpm -r build`：Contracts、Runtime、Remote、Web、Evaluation Service、Evaluation Web 等全部构建成功。
- 覆盖重点包括 ACP load/resume/Prompt、Tool 顺序、Session 绑定、Agent 能力解析、Skill/MCP 生命周期、FileReference 越权、Experiment fresh/history、模型工作表与四维 Scorecard。

### 4.2 真实浏览器和真实本地模型

- 首页读取真实 `qwen3:8b` 与默认 Agent；小说卡片显示但不可点击。
- 从首页创建真实聊天 Session，ACP 流式回答完成；刷新后回答、上下文提要、Provider token 用量和 Turn 快照恢复。
- 从历史回答打开 Context Lab，页面正确固定原问题、模型和 A 的原始快照，A 明确标记“不重跑”。
- fresh 实验的 A/B 均通过真实隔离 ACP Session 调用 `qwen3:8b` 完成。
- lane 完成后由 `qwen3:8b` 生成并持久化需求项、逐 lane Workflow 和逐 lane 结果分段；人工完成三维判断后得到 A=100、B=98，排名与 winner 由服务端计算。
- 刷新 evaluation-web 后，原始回答、工作表、人工标注、四维雷达图、总分、排名和 winner 均从服务端恢复。
- 真实聊天调用 `write_file` 时展示权限确认；允许后生成 `mk-file://` opaque 引用，并在产品内打开 Markdown 安全预览。产物分栏从约 486px 拖到 646px、再拖到 300px 下限，边界稳定且松手后清理拖动态。
- 修正自定义 ACP 通知 parser 后，新标签页加载已有会话无页面运行错误。

## 5. 当前保留的工程边界

- 这是本地单用户产品，Control API 当前 principal 为本地管理员；远程多用户认证不在本轮。
- Agent 使用单一可变记录和最后一次成功保存，不实现协作编辑冲突界面。
- 标注工作表生成超时为 180 秒；本地 8B 模型的实测生成时间约 127 秒。生成失败不会伪造题目，用户可重试。
- Ollama 普通聊天继续开启推理；只有结构化标注题生成关闭推理，防止长推理挤占工作表超时。
- Web 构建存在单个约 1 MB 的主包体积警告，不影响正确性；后续可按路由拆包优化首屏下载。
