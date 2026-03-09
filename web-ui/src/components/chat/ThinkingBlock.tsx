import { useState } from "react";
import type { ReactStep } from "../../types";

interface Props {
  steps: ReactStep[];
  currentIteration: string;
  isActive: boolean;
}

const STEP_ICONS: Record<string, string> = {
  thought: "\uD83D\uDCAD",
  action: "\u26A1",
  observation: "\uD83D\uDC41",
  final: "\u2713",
  plan: "\uD83D\uDCCB",
  overlay: "\uD83D\uDDBC",
  progress: "\u23F3",
  report: "\uD83D\uDCC4",
  iteration: "\uD83D\uDD04",
  viewer_cmd: "\uD83D\uDCFA",
};

export default function ThinkingBlock({ steps, currentIteration, isActive }: Props) {
  const [expanded, setExpanded] = useState(false);

  const meaningful = steps.filter((s) => s.type !== "iteration");
  const latest = meaningful.length > 0 ? meaningful[meaningful.length - 1] : null;
  const summary = latest ? latest.content.slice(0, 120) : "Thinking...";

  return (
    <div
      style={{
        margin: "8px 0",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        animation: "fadeIn 0.2s ease",
      }}
    >
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "var(--bg-tertiary)",
          textAlign: "left",
        }}
      >
        {isActive ? (
          <span
            style={{
              display: "inline-block",
              width: 14,
              height: 14,
              border: "2px solid var(--accent)",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              flexShrink: 0,
            }}
          />
        ) : (
          <span style={{ color: "var(--success)", fontSize: 14, flexShrink: 0 }}>{"\u2713"}</span>
        )}

        <span style={{ flex: 1, fontSize: 13, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isActive
            ? `${currentIteration ? `Step ${currentIteration}` : "Working"} \u2014 ${summary}`
            : `Completed (${meaningful.length} steps)`
          }
        </span>

        <span style={{ fontSize: 12, color: "var(--text-muted)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>
          {"\u25BC"}
        </span>
      </button>

      {/* Steps list */}
      {expanded && (
        <div style={{ maxHeight: 300, overflowY: "auto", padding: "4px 0" }}>
          {steps.map((step, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                gap: 8,
                padding: "4px 12px",
                fontSize: 12,
                color: "var(--text-secondary)",
              }}
            >
              <span style={{ flexShrink: 0, width: 20, textAlign: "center" }}>
                {STEP_ICONS[step.type] || "\u2022"}
              </span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ fontWeight: 500, marginRight: 4, textTransform: "capitalize" }}>
                  {step.type}:
                </span>
                {step.content.slice(0, 200)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
