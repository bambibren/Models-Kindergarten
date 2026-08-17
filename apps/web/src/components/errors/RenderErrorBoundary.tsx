import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  scope: "app" | "entry";
}

interface State { failed: boolean; }

/**
 * 这里只隔离 React 渲染异常，不参与 Runtime 重试。
 * Entry 级错误不会拖垮整页；根级兜底保证页面不会变成空白屏。
 */
export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[web-react] render failed", {
      scope: this.props.scope,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.scope === "app") {
      return <main className="app-render-fallback" role="alert">
        <strong>页面内容暂时无法显示</strong>
        <p>应用遇到了渲染错误。错误已被隔离，页面不会显示为空白。</p>
      </main>;
    }
    return <div className="entry-render-fallback" role="alert">这段内容暂时无法显示，其他消息仍可正常使用。</div>;
  }
}
