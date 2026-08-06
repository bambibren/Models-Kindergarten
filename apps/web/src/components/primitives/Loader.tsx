import type { CSSProperties, ReactNode } from "react";

export type LoaderVariant =
  | "circular"
  | "classic"
  | "pulse"
  | "pulse-dot"
  | "dots"
  | "typing"
  | "wave"
  | "bars"
  | "terminal"
  | "text-blink"
  | "text-shimmer"
  | "loading-dots";

export type LoaderSize = "sm" | "md" | "lg";

export interface LoaderProps {
  variant?: LoaderVariant;
  size?: LoaderSize;
  text?: string;
  label?: string;
  className?: string;
}

/**
 * Adapted from Prompt Kit's MIT-licensed Loader.
 * 保留全部 variant，但改为项目原生 CSS，不依赖 Tailwind 或 shadcn。
 */
export function Loader({ variant = "circular", size = "md", text = "Thinking", label = "Loading", className = "" }: LoaderProps) {
  const rootClass = `loader loader-${variant} loader-${size} ${className}`.trim();
  let visual: ReactNode;

  switch (variant) {
    case "classic":
      visual = <span className="loader-classic-bars">{Array.from({ length: 12 }, (_, index) => <i key={index} style={{ "--loader-index": index } as CSSProperties} />)}</span>;
      break;
    case "pulse": visual = <span className="loader-pulse-ring" />; break;
    case "pulse-dot": visual = <span className="loader-pulse-circle" />; break;
    case "dots":
    case "typing": visual = <span className="loader-dot-row">{[0, 1, 2].map((index) => <i key={index} style={{ "--loader-index": index } as CSSProperties} />)}</span>; break;
    case "wave": visual = <span className="loader-wave-row">{[0, 1, 2, 3, 4].map((index) => <i key={index} style={{ "--loader-index": index } as CSSProperties} />)}</span>; break;
    case "bars": visual = <span className="loader-bars-row">{[0, 1, 2].map((index) => <i key={index} style={{ "--loader-index": index } as CSSProperties} />)}</span>; break;
    case "terminal": visual = <span className="loader-terminal-line"><b>&gt;</b><i /></span>; break;
    case "text-blink": visual = <span className="loader-text-blink">{text}</span>; break;
    case "text-shimmer": visual = <span className="loader-text-shimmer">{text}</span>; break;
    case "loading-dots": visual = <span className="loader-text-dots"><b>{text}</b><i>.</i><i>.</i><i>.</i></span>; break;
    default: visual = <span className="loader-circular-ring" />;
  }

  return <span className={rootClass} role="status" aria-label={label}>{visual}<span className="sr-only">{label}</span></span>;
}

export const loaderVariants: readonly LoaderVariant[] = [
  "circular", "classic", "pulse", "pulse-dot", "dots", "typing",
  "wave", "bars", "terminal", "text-blink", "text-shimmer", "loading-dots",
];
