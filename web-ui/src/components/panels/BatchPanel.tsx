import { useState } from "react";
import type { DicomStudy } from "../../types";

interface Props {
  studies: DicomStudy[];
  onClose: () => void;
  onStartBatch: (prompt: string) => void;
  isRunning: boolean;
}

export default function BatchPanel({ studies, onClose, onStartBatch, isRunning }: Props) {
  const [prompt, setPrompt] = useState("");

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    if (!trimmed || studies.length === 0) return;
    onStartBatch(trimmed);
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>Batch Analysis</span>
          <button onClick={onClose} style={styles.closeBtn}>&times;</button>
        </div>

        {/* Study summary */}
        <div style={styles.section}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>
            Target: <strong style={{ color: "var(--text-primary)" }}>{studies.length} studies</strong>
          </div>
          <div style={styles.studyList}>
            {studies.map((s) => (
              <div key={s.study_uid} style={{ fontSize: 11, color: "var(--text-muted)", padding: "1px 0" }}>
                {s.patient_name || "Unknown"} &middot; {s.patient_id} &middot; {s.study_date}
              </div>
            ))}
          </div>
        </div>

        {/* Prompt input */}
        <div style={styles.section}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
            Analysis Prompt
          </div>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. Detect all lesions and generate a report with SUV statistics"
            style={styles.textarea}
            rows={4}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleSubmit();
            }}
          />
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>
            This prompt will be run against each study. Results go to batch_analysis_results/.
            Press Ctrl+Enter to submit.
          </div>
        </div>

        {/* Submit */}
        <div style={{ padding: "12px 16px" }}>
          <button
            onClick={handleSubmit}
            disabled={!prompt.trim() || studies.length === 0 || isRunning}
            style={{
              ...styles.startBtn,
              opacity: (!prompt.trim() || studies.length === 0 || isRunning) ? 0.5 : 1,
            }}
          >
            {isRunning ? "Running..." : `Run on ${studies.length} Studies`}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.6)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 200,
  },
  modal: {
    width: 460,
    maxHeight: "80vh",
    background: "var(--bg-secondary)",
    borderRadius: 8,
    border: "1px solid var(--border)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
  },
  closeBtn: {
    fontSize: 18,
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  section: {
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
  },
  studyList: {
    maxHeight: 100,
    overflowY: "auto" as const,
  },
  textarea: {
    width: "100%",
    padding: 10,
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg-primary)",
    color: "var(--text-primary)",
    fontSize: 13,
    resize: "vertical" as const,
    fontFamily: "inherit",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  startBtn: {
    width: "100%",
    padding: "10px",
    borderRadius: 6,
    background: "var(--accent)",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
  },
};
