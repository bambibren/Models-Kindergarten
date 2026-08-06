# Models Kindergarten 开发约束

## 当前目标

只维护“React 类 GPT Web + Remote ACP Agent”的最小闭环。旧版 `model-kindergarten-v1-codex` 仅是背景，不是当前实现规范。

## 必须保持

- Browser 与 Remote 之间只使用官方 ACP；
- 一个浏览器页面只有一个 ACP connection owner；
- `load` 完整回放，`resume` 零回放；
- Remote 不保存 Web 投影，Web 不保存 Runtime 状态；
- Model Provider 不依赖 ACP，默认演示必须调用本地小模型；
- UI 组件不解释 Raw ACP；
- 每个 session 同时最多一个 prompt；
- 新增协议行为必须有测试。
- 文件 Tool 必须经过 `FileSandbox`；禁止绕过路径、大小和符号链接校验；
- 写入必须使用 ACP permission，AskUser 必须使用 ACP elicitation，二者不得混用。

## V1 禁止提前加入

- Java/RCS、Channel Group、EventBus、SSE；
- `RunEvt` 或另一套 Command/Event envelope；
- 自动重连、重试、熔断和旧格式归一化；
- Student、Course、Skill、Memory 等未进入主链的领域对象；
- Shell、任意代码执行、网络访问 Tool 和 Artifact；

## 代码风格

- 注释使用中文，解释边界、原因和不变量，不逐行翻译代码；
- 变量名简短、准确；避免多个同义词拼接成长驼峰；
- 一个模块只有一个清晰职责；
- 不为“未来也许需要”创建空抽象；
- 错误直接暴露，不偷偷降级到另一条行为路径。
