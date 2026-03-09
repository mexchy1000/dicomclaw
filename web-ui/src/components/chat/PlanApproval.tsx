import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PlanOption {
  key: string;
  label: string;
  inputLabel?: string; // if option needs a text input
}

/** Strip JSON wrappers / code fences and convert to readable markdown. */
function cleanPlanText(raw: string): string {
  let text = raw.replace(/\\n/g, "\n");

  // Try to parse as JSON and extract a human-readable field
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      // Common patterns: { plan: "...", steps: [...] }
      if (typeof parsed.plan === "string") return parsed.plan;
      if (typeof parsed.text === "string") return parsed.text;
      if (typeof parsed.description === "string") return parsed.description;
      // If it's an object with numbered/string steps, format them
      if (Array.isArray(parsed.steps)) {
        return parsed.steps
          .map((s: unknown, i: number) =>
            typeof s === "string" ? `${i + 1}. ${s}` : `${i + 1}. ${JSON.stringify(s)}`,
          )
          .join("\n");
      }
      // Fallback: pretty-print but strip outer braces
      const pretty = JSON.stringify(parsed, null, 2);
      return pretty;
    }
  } catch {
    // Not JSON — that's fine, treat as plain text / markdown
  }

  // Strip code fences
  text = text.replace(/^```(?:json|markdown|md)?\s*\n?/gm, "").replace(/```\s*$/gm, "");

  return text.trim();
}

function parseOptions(planText: string): { cleanPlan: string; options: PlanOption[] } {
  const optMatch = planText.match(/\[OPTIONS\]([\s\S]*?)\[\/OPTIONS\]/);
  if (!optMatch) return { cleanPlan: planText, options: [] };

  const optBlock = optMatch[1];
  const cleanPlan = planText.replace(/\[OPTIONS\][\s\S]*?\[\/OPTIONS\]/, "").trim();

  const options: PlanOption[] = [];
  for (const line of optBlock.split("\n")) {
    const m = line.trim().match(/^-\s*([A-Z]):\s*(.+)/);
    if (!m) continue;
    const key = m[1];
    let label = m[2].trim();
    let inputLabel: string | undefined;
    const inputMatch = label.match(/\(input:\s*([^)]+)\)/);
    if (inputMatch) {
      inputLabel = inputMatch[1].trim();
      label = label.replace(inputMatch[0], "").trim();
    }
    options.push({ key, label, inputLabel });
  }
  return { cleanPlan, options };
}

interface Props {
  plan: string;
  onApprove: () => void;
  onModify: (feedback: string) => void;
  onReject: () => void;
}

export default function PlanApproval({ plan, onApprove, onModify, onReject }: Props) {
  const [modifying, setModifying] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [optionInputs, setOptionInputs] = useState<Record<string, string>>({});

  const cleaned = useMemo(() => cleanPlanText(plan), [plan]);
  const { cleanPlan, options } = useMemo(() => parseOptions(cleaned), [cleaned]);
  const hasOptions = options.length > 0;

  // Check if selected option needs input and has it filled
  const selectedOpt = options.find((o) => o.key === selectedOption);
  const needsInput = selectedOpt?.inputLabel;
  const inputFilled = !needsInput || (optionInputs[selectedOption!] || "").trim().length > 0;
  const canSubmit = hasOptions ? selectedOption !== null && inputFilled : true;

  return (
    <div
      style={{
        margin: "12px 0",
        border: "1px solid var(--purple)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        animation: "fadeIn 0.3s ease",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "6px 12px",
          background: "rgba(139, 92, 246, 0.1)",
          borderBottom: "1px solid var(--purple)",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--purple)",
        }}
      >
        Analysis Plan
      </div>

      {/* Plan content */}
      <div
        className="plan-content"
        style={{
          padding: "8px 14px",
          maxHeight: 260,
          overflowY: "auto",
          fontSize: 11.5,
          lineHeight: 1.6,
        }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanPlan}</ReactMarkdown>
      </div>

      {/* Option selection */}
      {hasOptions && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Select an option
          </div>
          {options.map((opt) => (
            <div
              key={opt.key}
              style={{
                marginBottom: 6,
                padding: "6px 8px",
                borderRadius: "var(--radius-sm)",
                border: selectedOption === opt.key ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: selectedOption === opt.key ? "rgba(139, 92, 246, 0.06)" : "transparent",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
              onClick={() => setSelectedOption(opt.key)}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12 }}>
                <input
                  type="radio"
                  name="plan-option"
                  checked={selectedOption === opt.key}
                  onChange={() => setSelectedOption(opt.key)}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span style={{ fontWeight: 600, minWidth: 16 }}>{opt.key}.</span>
                <span>{opt.label}</span>
              </label>
              {opt.inputLabel && selectedOption === opt.key && (
                <input
                  autoFocus
                  value={optionInputs[opt.key] || ""}
                  onChange={(e) => setOptionInputs((prev) => ({ ...prev, [opt.key]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && canSubmit) {
                      const inputVal = optionInputs[selectedOption!] || "";
                      onModify(inputVal ? `OPTION:${selectedOption},${inputVal}` : `OPTION:${selectedOption}`);
                    }
                  }}
                  placeholder={opt.inputLabel}
                  style={{
                    marginLeft: 28,
                    marginTop: 6,
                    width: "calc(100% - 28px)",
                    background: "var(--bg-input)",
                    border: "1px solid var(--border-light)",
                    borderRadius: "var(--radius-sm)",
                    padding: "5px 8px",
                    color: "var(--text-primary)",
                    fontSize: 12,
                    outline: "none",
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div
        style={{
          padding: "8px 12px",
          borderTop: "1px solid var(--border)",
          display: "flex",
          gap: 6,
          alignItems: "center",
        }}
      >
        <button
          onClick={onReject}
          style={{
            padding: "5px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--error)",
            color: "var(--error)",
            fontSize: 11.5,
          }}
        >
          Reject
        </button>
        <button
          onClick={() => setModifying(!modifying)}
          style={{
            padding: "5px 12px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--warning)",
            color: "var(--warning)",
            fontSize: 11.5,
          }}
        >
          Modify
        </button>
        <button
          onClick={() => onApprove()}
          disabled={!canSubmit}
          style={{
            padding: "5px 14px",
            borderRadius: "var(--radius-sm)",
            background: canSubmit ? "var(--accent)" : "var(--bg-tertiary)",
            color: canSubmit ? "#fff" : "var(--text-muted)",
            fontSize: 11.5,
            fontWeight: 600,
            marginLeft: "auto",
          }}
        >
          {hasOptions ? (selectedOption ? `Run Option ${selectedOption}` : "Select an Option") : "Approve & Run"}
        </button>
      </div>

      {/* Modify input */}
      {modifying && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <input
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing && feedback.trim()) {
                onModify(feedback.trim());
                setFeedback("");
                setModifying(false);
              }
            }}
            placeholder="Describe what to change..."
            style={{
              width: "100%",
              background: "var(--bg-input)",
              border: "1px solid var(--border-light)",
              borderRadius: "var(--radius-sm)",
              padding: "5px 10px",
              color: "var(--text-primary)",
              fontSize: 12,
              outline: "none",
            }}
          />
        </div>
      )}
    </div>
  );
}
