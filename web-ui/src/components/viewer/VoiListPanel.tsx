/**
 * Panel showing all VOIs (both auto-generated from agent and manual user-drawn).
 * Each VOI has show/hide/delete controls.
 */
import type { UserVoi } from "../../hooks/useViewerMarkers";
import type { OverlayData } from "../../hooks/useOverlays";

interface Props {
  /** User-drawn manual VOIs */
  userVois: UserVoi[];
  onToggleVoiVisibility: (id: number) => void;
  onDeleteVoi: (id: number) => void;
  onVoiClick?: (voi: UserVoi) => void;
  /** Agent-generated overlays (AutoPET, TotalSegmentator, etc.) */
  overlays?: OverlayData[];
  activeLabels?: Set<string>;
  onToggleLabel?: (name: string) => void;
  onClose: () => void;
}

export default function VoiListPanel({
  userVois, onToggleVoiVisibility, onDeleteVoi, onVoiClick,
  overlays = [], activeLabels = new Set(), onToggleLabel,
  onClose,
}: Props) {
  // Collect agent VOIs from overlays
  const agentVois: { name: string; displayName: string; color: string; suv_max?: number; volume_ml?: number }[] = [];
  let autoIdx = 1;
  for (const ov of overlays) {
    for (const label of ov.labels) {
      if (agentVois.some((a) => a.name === label.name)) continue;
      const meta = ov.metadata?.find((m) => m.name === label.name);
      agentVois.push({
        name: label.name,
        displayName: `VOI-a${String(autoIdx).padStart(3, "0")}: ${label.name}`,
        color: label.color,
        suv_max: meta?.suv_max,
        volume_ml: meta?.volume_ml,
      });
      autoIdx++;
    }
  }

  const hasItems = userVois.length > 0 || agentVois.length > 0;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={{ fontWeight: 700, fontSize: 11 }}>VOI List</span>
        <button onClick={onClose} style={styles.closeBtn}>&times;</button>
      </div>

      {!hasItems && (
        <div style={{ padding: "12px 8px", fontSize: 10, color: "#888", textAlign: "center" }}>
          No VOIs yet. Use VOI tool to draw or run agent analysis.
        </div>
      )}

      {/* Manual VOIs */}
      {userVois.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Manual</div>
          {userVois.map((v) => (
            <div key={v.id} style={{ ...styles.row, opacity: v.visible ? 1 : 0.4 }}>
              <span style={{ ...styles.dot, background: v.color }} />
              <span
                style={{ flex: 1, fontSize: 10, fontWeight: 600, cursor: "pointer" }}
                onClick={() => onVoiClick?.(v)}
                title="Click for details"
              >
                {v.label}
              </span>
              {v.stats && (
                <span style={{ fontSize: 9, color: "#aaa", marginRight: 4 }}>
                  SUV {v.stats.suvMax.toFixed(1)} · {v.stats.volumeMl.toFixed(1)}ml
                  {v.stats.thresholdType && (
                    <span style={{ color: "#4a9eff" }}>
                      {" "}({v.stats.thresholdValue}{v.stats.thresholdType === "percent" ? "%" : ""})
                    </span>
                  )}
                </span>
              )}
              <button
                onClick={() => onToggleVoiVisibility(v.id)}
                style={styles.actionBtn}
                title={v.visible ? "Hide" : "Show"}
              >
                {v.visible ? "H" : "S"}
              </button>
              <button
                onClick={() => onDeleteVoi(v.id)}
                style={{ ...styles.actionBtn, color: "#f66" }}
                title="Delete"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Agent VOIs */}
      {agentVois.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>Agent</div>
          {agentVois.map((a) => {
            const active = activeLabels.has(a.name);
            return (
              <div key={a.name} style={{ ...styles.row, opacity: active ? 1 : 0.4 }}>
                <span style={{ ...styles.dot, background: a.color }} />
                <span style={{ flex: 1, fontSize: 10, fontWeight: 600 }}>{a.displayName}</span>
                {a.suv_max != null && (
                  <span style={{ fontSize: 9, color: "#aaa", marginRight: 4 }}>
                    SUV {a.suv_max.toFixed(1)}
                  </span>
                )}
                {a.volume_ml != null && (
                  <span style={{ fontSize: 9, color: "#aaa", marginRight: 4 }}>
                    {a.volume_ml.toFixed(0)}ml
                  </span>
                )}
                <button
                  onClick={() => onToggleLabel?.(a.name)}
                  style={styles.actionBtn}
                  title={active ? "Hide" : "Show"}
                >
                  {active ? "H" : "S"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: "absolute",
    top: 30,
    right: 4,
    width: 200,
    maxHeight: "60%",
    overflowY: "auto",
    background: "rgba(15, 15, 30, 0.92)",
    backdropFilter: "blur(6px)",
    border: "1px solid #444",
    borderRadius: 6,
    zIndex: 20,
    fontSize: 11,
    color: "#ddd",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "5px 8px",
    borderBottom: "1px solid #333",
  },
  closeBtn: {
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 14,
    padding: 0,
    lineHeight: 1,
  },
  section: {
    padding: "2px 0",
  },
  sectionTitle: {
    fontSize: 9,
    color: "#888",
    fontWeight: 700,
    padding: "3px 8px",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    padding: "3px 8px",
    transition: "opacity 0.15s",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  actionBtn: {
    background: "none",
    border: "none",
    color: "#aaa",
    cursor: "pointer",
    fontSize: 10,
    padding: "1px 3px",
    fontWeight: 700,
  },
};
