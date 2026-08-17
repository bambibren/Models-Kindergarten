/**
 * 产品与 Runtime 当前采用的资源预算和生命周期配置。
 *
 * 这些数值先保留现有行为，但不再散落在业务逻辑里；后续有产品依据时只在这里调整。
 */
export const PRODUCT_CONFIG = {
  skill: {
    /** 单个 Skill 最多收集的文件数，防止安装过程失控。 */
    maxFiles: 200,
    /** 单个 Skill 所有文件的总字节上限，防止安装和读取占用过多资源。 */
    maxTotalBytes: 2 * 1024 * 1024,
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
  },
  tools: {
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
