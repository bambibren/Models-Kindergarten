# Turn Evaluation 技术设计

## 1. 目标与边界

Evaluation 评测一个真实 Agent 的一次终态 Prompt Turn。聊天页根据 `ChatEntry.turnId` 提供“Runtime 与评测”入口，跳转到同一 Web 应用的 `/evaluation/*` 页面。

```text
Chat 页面
└─ sessionId + turnId
        │
        ▼
Web /evaluation/*
        │ GET /api/evaluation/v1
        ▼
Evaluation 模块
├─ TraceCollector
├─ Minimal Evaluator
└─ Turn Trace Repository
        ▲
        │ 有界后台队列
AgentRunner
└─ RuntimeObservationEvent
```

不实现批量数据集、后台无头执行、LLM-as-Judge、综合总分和通用 Runtime Event Store。

## 2. 模块边界

| 模块 | 职责 | 明确不负责 |
|---|---|---|
| `runtime-observation` | 定义稳定的只读执行事件端口 | 存储、评分、React |
| `evaluation-contract` | Trace 与评分结果的数据合同 | 执行逻辑 |
| `evaluation/trace-collector` | 按 `runId` 聚合终态 Trace、控制后台写入容量 | 改变 Runtime 控制流 |
| `evaluation/evaluator` | 从 Trace 计算客观指标 | 主观质量判断 |
| `evaluation/repository` | 一 Turn 一文件、索引、原子写入 | ACP、Agent 执行 |
| `evaluation/evaluation-module` | 组装模块并提供同源只读 API | 独立端口和跨进程通信 |
| `web/evaluation` | 展示执行树和客观指标 | ACP 连接、Runtime 状态 |

## 3. Trace 事实结构

```text
TurnTraceDocument
├─ identity: traceId / runId / sessionId / turnId
├─ variant: ModelStudent / model / systemPromptHash / tools
├─ terminal: status / stopReason / startedAt / completedAt
├─ modelRounds[]
│  ├─ context.messages[] / truncatedSourceIds[] / inputTokens
│  ├─ firstTokenAt / outputTokens
│  └─ thinking / text / stopReason
├─ toolCalls[]
│  ├─ modelRoundId / toolCallId / name / arguments / signature
│  ├─ permission / status / startedAt / completedAt
│  └─ output / error
├─ permissions[]
└─ errors[]
```

Tool 节点按 `startedAt` 固定在所属 Model Round；并行 Tool 的完成顺序只更新节点状态，不改变显示顺序。

## 4. 最小评分集

`MinimalTurnEvaluationResult` 只从 Trace 确定性计算：正常完成、Model Round 数、Tool Call 数、Tool 成功/失败数、是否重复调用、上下文 Token、被截断上下文数、首 Token 延迟、总耗时、输出 Token、错误数和权限违规数。

Provider 提供 usage 时使用精确 Token；逐条 Context Message 的 `estimatedTokens` 只解释上下文组成。

## 5. 异步隔离

```text
Agent Turn 到达终态
├─ 先完成 Session 状态提交
└─ Evaluation 后台处理
   ├─ 最大四条并发写入
   ├─ Trace 最大 1 MiB
   ├─ 评分和写入失败只记录警告
   ├─ 不建立无界等待队列
   └─ 进程退出时等待已开始的写入
```

- Evaluation 初始化失败时，Remote 主链继续运行；评测接口返回 `503`。
- Repository 以 `sessionId + turnId` 覆盖同一轮记录，并使用临时文件原子替换。
- Web 对异步写入窗口做短暂重试，随后显示“尚未生成本轮评测”。

## 6. 地址与数据

```text
Web 页面
└─ /evaluation/sessions/:sessionId/turns/:turnId

只读 API
└─ http://127.0.0.1:7331/api/evaluation/v1

本机数据
└─ apps/remote/.data/evaluation
   ├─ turn-evaluations/
   └─ turn-evaluations.index.json
```

根目录运行 `pnpm dev` 只启动 Web 和 Remote，Evaluation 随 Remote 一起初始化。
