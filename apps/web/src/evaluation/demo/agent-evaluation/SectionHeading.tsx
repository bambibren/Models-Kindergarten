import type { ReactNode } from "react";
import "./section-heading.css";

/** Demo 与正式实验页共用同一层内容标题。 */
export function SectionHeading({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return <div className="demo-section-heading">{icon}<div><h2>{title}</h2><p>{detail}</p></div></div>;
}
