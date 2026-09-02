/**
 * 产品与 Runtime 当前采用的资源预算和生命周期配置。
 *
 * 这些数值先保留现有行为，但不再散落在业务逻辑里；后续有产品依据时只在这里调整。
 */
/**
 * 单个 Agent Turn 的硬执行预算。
 *
 * Runtime 允许在测试或部署组合根注入更小的值，但不能在一次 Turn 中动态放宽，
 * 以免模型循环、流式正文或工具参数把 Remote 堆内存持续推高。
 */
export interface RuntimeExecutionBudget {
  /** 一个 Turn 最多发起的模型请求轮数。 */
  maxModelRounds: number;
  /** 单轮最多接受的工具调用数。 */
  maxToolCallsPerRound: number;
  /** 一个 Turn 累计最多接受的工具调用数。 */
  maxToolCallsPerTurn: number;
  /** 单轮 assistant 正文的 UTF-8 字节上限。 */
  maxTextBytesPerRound: number;
  /** 单轮 thinking 正文的 UTF-8 字节上限。 */
  maxThinkingBytesPerRound: number;
  /** 单个工具调用参数序列化后的 UTF-8 字节上限。 */
  maxToolArgumentBytesPerCall: number;
  /** 一个 Turn 中全部工具参数的累计 UTF-8 字节上限。 */
  maxToolArgumentBytesPerTurn: number;
  /** Provider 连续多久没有事件即判定流已失活。 */
  modelStreamIdleTimeoutMs: number;
  /** 首次模型请求失败后，最多额外重试的次数。 */
  modelRequestMaxRetries: number;
  /** 模型请求指数退避的初始等待时间。 */
  modelRequestRetryInitialDelayMs: number;
  /** 没有 Retry-After 时，模型请求指数退避的等待上限。 */
  modelRequestRetryMaxDelayMs: number;
  /** 一个 Remote 进程同时允许执行的 Prompt Turn 数。 */
  maxConcurrentTurns: number;
}

export const PRODUCT_CONFIG = {
  runtime: {
    maxModelRounds: 32,
    maxToolCallsPerRound: 16,
    maxToolCallsPerTurn: 64,
    maxTextBytesPerRound: 8 * 1024 * 1024,
    maxThinkingBytesPerRound: 8 * 1024 * 1024,
    maxToolArgumentBytesPerCall: 1024 * 1024,
    maxToolArgumentBytesPerTurn: 4 * 1024 * 1024,
    modelStreamIdleTimeoutMs: 60_000,
    modelRequestMaxRetries: 5,
    modelRequestRetryInitialDelayMs: 500,
    modelRequestRetryMaxDelayMs: 8_000,
    maxConcurrentTurns: 8,
  } satisfies RuntimeExecutionBudget,
  server: {
    /** Remote 同时允许进入 ACP upgrade 的 WebSocket 连接数。 */
    maxAcpConnections: 16,
    /** Control API 同时执行的路由 Handler 数；超限请求立即返回 503，不进入等待队列。 */
    maxConcurrentControlRequests: 32,
    /** Node HTTP Server 同时保留的 TCP 连接数，覆盖慢连接的进程级上界。 */
    maxHttpConnections: 64,
    /** 完整 HTTP 请求允许占用连接的最长时间。 */
    requestTimeoutMs: 120_000,
    /** 请求头必须在该时间内接收完成。 */
    headersTimeoutMs: 60_000,
    /** 空闲 keep-alive 连接的保留时间。 */
    keepAliveTimeoutMs: 5_000,
    /** 同一 keep-alive socket 服务固定次数后主动轮换。 */
    maxRequestsPerSocket: 100,
  },
  capacity: {
    /** 包含内置模型在内，进程运行目录最多持有的 ModelStudent 数。 */
    maxModelStudents: 64,
    /** 同时执行真实网络探针的 Model Admission Test 数；超限不排队。 */
    maxConcurrentModelAdmissionTests: 4,
    /** Remote 内暂存、等待 install 消费的含 Secret Candidate 数。 */
    maxRetainedModelCandidates: 32,
    /** 持久化 MCP Installation 的全局数量上限。 */
    maxMcpInstallations: 100,
    /** 同一进程最多保持连接的 MCP Client 数。 */
    maxEnabledMcpClients: 32,
    /** 单个 MCP Server 最多向 Runtime 暴露的 Tool 数。 */
    maxMcpToolsPerServer: 256,
    /** 单个 MCP Server 全部能力描述的序列化字节上限。 */
    maxMcpDescriptorBytes: 2 * 1024 * 1024,
    /** Skill Registry 最多常驻的元数据条数。 */
    maxInstalledSkills: 200,
    /** 一个 Agent 最多绑定的 Skill 数。 */
    maxAgentSkills: 64,
    /** 一个 Agent 最多绑定的 MCP Installation 数。 */
    maxAgentMcps: 32,
    /** 一个 Agent 启用的 Built-in 与 MCP Tool 总数上限。 */
    maxAgentBoundTools: 128,
    /** 单次模型请求的全部 Tool Schema 序列化总字节上限。 */
    maxTurnToolSchemaBytes: 2 * 1024 * 1024,
    /** 每个 owner 最多保留的终态 Skill 安装任务；活动任务不参与裁剪。 */
    maxTerminalSkillInstallJobsPerOwner: 100,
  },
  artifact: {
    /** 每个 Artifact ID 包含当前内容在内最多保留的修订总数。 */
    maxRetainedRevisions: 3,
    /** 普通 Artifact 首版采用较大的单文件上限，后续再按云端观测收紧。 */
    maxFileBytes: 100 * 1024 * 1024,
    /** HTML Bundle 的所有文件总量上限。 */
    maxHtmlBundleBytes: 500 * 1024 * 1024,
    /** HTML Bundle 的文件数上限，防止大量空文件撑爆目录清单和 ZIP 元数据。 */
    maxHtmlBundleFiles: 2_000,
    /** 单个 Turn 可占用的构建/发布临时空间预算。 */
    maxTurnStagingBytes: 1024 * 1024 * 1024,
    /** 文本预览只进入模型/UI 的前 5 MiB；原始 Artifact 仍可完整下载。 */
    maxTextPreviewBytes: 5 * 1024 * 1024,
  },
  pptx: {
    /** PptxGenJS 源码沿用文本文件的大上限，不允许把二进制素材塞进源码。 */
    maxSourceBytes: 5 * 1024 * 1024,
    /** 最终 PPTX 复用普通 Artifact 的单文件上限。 */
    maxOutputBytes: 100 * 1024 * 1024,
    /** 浏览器静态渲染会整体读取 ZIP；超过该值只允许下载或 ONLYOFFICE 流程。 */
    maxBrowserPreviewBytes: 32 * 1024 * 1024,
    /** 构建只计算源码执行时间；模型生成源码的时间不在其中。 */
    buildTimeoutMs: 120_000,
    /** 子进程 stdout/stderr 只保留诊断摘要，不进入产物。 */
    maxProcessOutputBytes: 64 * 1024,
  },
  skill: {
    /** 单个 Skill 最多收集的文件数，防止安装过程失控。 */
    maxFiles: 512,
    /** 单个 Skill 所有文件的总字节上限，防止安装和读取占用过多资源。 */
    maxTotalBytes: 64 * 1024 * 1024,
    /** 单次安装任务最多接收的用户提供 Skill URL 数量。 */
    maxSourceUrlsPerJob: 10,
  },
  sessionLaunch: {
    /** 会话启动 Prompt 当前允许的最大字符数。 */
    maxPromptCharacters: 100_000,
    /** 会话启动草稿的保留时长，当前为 24 小时。 */
    draftTtlMs: 24 * 60 * 60_000,
  },
  mcp: {
    /** MCP 连接测试结果的有效时长，当前为 10 分钟。 */
    testResultTtlMs: 10 * 60_000,
    /** MCP SDK 返回值在第一次结构化克隆前允许的最大序列化字节数。 */
    maxResultBytes: 4 * 1024 * 1024,
    /** 一次 Tool 或 Resource 返回允许包含的最大内容块数量。 */
    maxResultBlocks: 256,
  },
  agent: {
    /** Agent 名称的当前字符上限。 */
    nameMaxCharacters: 80,
    /** Agent 说明的当前字符上限。 */
    descriptionMaxCharacters: 500,
    /** System Prompt 正文的当前字符上限；正文首尾空白必须原样保留。 */
    systemPromptMaxCharacters: 32_000,
    /** Built-in Tool 标识符的当前字符上限。 */
    toolIdMaxCharacters: 120,
    /** MCP Installation 标识符的当前字符上限。 */
    mcpInstallationIdMaxCharacters: 120,
    /** MCP 远端 Tool 名称的当前字符上限。 */
    mcpRemoteToolNameMaxCharacters: 200,
    /** MCP Resource URI 的当前字符上限。 */
    mcpResourceUriMaxCharacters: 2_048,
    /** 最近历史策略当前允许选择的最大完整 Turn 数。 */
    historyRecentTurnsMax: 50,
    /** Web 与 ACP 首屏每次加载的完整 Turn 数。 */
    historyPageTurns: 20,
    /** 浏览器最多同时保留的历史 Turn 数。 */
    maxWebRetainedTurns: 100,
  },
  tools: {
    /** 同一模型批次最多并行执行的 Tool 数，结果仍按调用顺序返回。 */
    maxBatchConcurrency: 4,
    /** `build_pptx` 等高内存构建在同一 ToolRuntime 内的并发上限。 */
    maxHeavyConcurrency: 2,
    /** 提供给模型和 ACP 的一次工具结果视图总字节上限。 */
    maxResultViewBytes: 1024 * 1024,
    file: {
      /** FileSandbox 文本和普通文件 Tool 的默认读写上限。 */
      maxBytes: 5 * 1024 * 1024,
    },
    process: {
      /** 单条终端命令的当前字符上限。 */
      commandMaxCharacters: 2_000,
      /** 未指定终端超时时采用的默认时长。 */
      defaultTimeoutMs: 15_000,
      /** 调用方请求的终端超时下限。 */
      minTimeoutMs: 100,
      /** 单次终端命令允许的最大执行时长。 */
      maxTimeoutMs: 30_000,
      /** stdout 与 stderr 各自保留的最大字节数。 */
      maxOutputBytes: 64 * 1024,
    },
    web: {
      /** 搜索词的当前字符上限。 */
      queryMaxCharacters: 500,
      /** 未指定搜索结果数时使用的默认值。 */
      defaultSearchResults: 5,
      /** 单次搜索至少返回的结果数预算。 */
      minSearchResults: 1,
      /** 单次搜索最多返回的结果数预算。 */
      maxSearchResults: 10,
      /** 单个网页响应允许读取的最大字节数。 */
      maxFetchBytes: 512 * 1024,
      /** 交给模型的网页纯文本当前最大字符数。 */
      maxModelTextCharacters: 24_000,
      /** 单次网页请求的超时时长。 */
      requestTimeoutMs: 12_000,
      /** 单次网页读取允许跟随的最大重定向次数。 */
      maxRedirects: 5,
    },
  },
} as const;
