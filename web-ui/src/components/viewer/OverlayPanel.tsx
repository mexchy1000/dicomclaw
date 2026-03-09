import { useState, useCallback, type CSSProperties } from "react";
import type { OverlayData } from "../../hooks/useOverlays";

interface Props {
  overlays: OverlayData[];
  activeLabels: Set<string>;
  onToggle: (name: string) => void;
}

interface PopupInfo {
  name: string;
  displayName: string;
  color: string;
  suv_max?: number;
  volume_ml?: number;
  x: number;
  y: number;
}

export default function OverlayPanel({ overlays, activeLabels, onToggle }: Props) {
  const [popup, setPopup] = useState<PopupInfo | null>(null);

  const showPopup = useCallback(
    (e: React.MouseEvent, displayName: string, name: string, color: string, meta?: { suv_max?: number; volume_ml?: number }) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPopup({
        name,
        displayName,
        color,
        suv_max: meta?.suv_max,
        volume_ml: meta?.volume_ml,
        x: rect.left,
        y: rect.top - 10,
      });
    },
    [],
  );

  if (overlays.length === 0) return null;

  // Collect all labels with per-label VOI numbering
  const allLabels: { name: string; displayName: string; color: string; meta?: { suv_max?: number; volume_ml?: number } }[] = [];
  for (const ov of overlays) {
    for (const label of ov.labels) {
      if (allLabels.some((l) => l.name === label.name)) continue;
      const meta = ov.metadata?.find((m) => m.name === label.name);
      const voiNum = label.voiIndex ?? ov.voiIndex;
      allLabels.push({
        name: label.name,
        displayName: `VOI${voiNum}: ${label.name}`,
        color: label.color,
        meta,
      });
    }
  }

  return (
    <>
      <div style={styles.container}>
        {allLabels.map((l) => {
          const active = activeLabels.has(l.name);
          return (
            <button
              key={l.name}
              onClick={(e) => showPopup(e, l.displayName, l.name, l.color, l.meta)}
              onDoubleClick={() => onToggle(l.name)}
              onContextMenu={(e) => { e.preventDefault(); onToggle(l.name); }}
              style={{
                ...styles.badge,
                borderColor: l.color,
                opacity: active ? 1 : 0.4,
                background: active ? `${l.color}22` : "transparent",
              }}
              title="Click: info | Double-click/Right: toggle"
            >
              <span style={{ ...styles.dot, background: l.color }} />
              {l.displayName}
            </button>
          );
        })}
      </div>

      {popup && (
        <div
          style={{ ...styles.popup, left: popup.x, bottom: window.innerHeight - popup.y + 4 }}
          onMouseLeave={() => setPopup(null)}
        >
          <div style={styles.popupHeader}>
            <span style={{ ...styles.dot, background: popup.color, width: 8, height: 8 }} />
            <strong>{popup.displayName}</strong>
            <button onClick={() => setPopup(null)} style={styles.popupClose}>&times;</button>
          </div>
          <div style={styles.popupBody}>
            {popup.volume_ml != null && (
              <div style={styles.popupRow}>
                <span style={styles.popupLabel}>Volume</span>
                <span>{popup.volume_ml.toFixed(1)} ml</span>
              </div>
            )}
            {popup.suv_max != null && (
              <div style={styles.popupRow}>
                <span style={styles.popupLabel}>SUVmax</span>
                <span>{popup.suv_max.toFixed(2)}</span>
              </div>
            )}
            {popup.volume_ml == null && popup.suv_max == null && (
              <div style={{ color: "#888", fontSize: 10 }}>No quantitative data</div>
            )}
          </div>
          <div style={styles.popupActions}>
            <button
              onClick={() => { onToggle(popup.name); setPopup(null); }}
              style={styles.popupToggle}
            >
              {activeLabels.has(popup.name) ? "Hide" : "Show"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    position: "absolute",
    bottom: 4,
    left: 4,
    display: "flex",
    flexWrap: "wrap",
    gap: 3,
    zIndex: 10,
    maxWidth: "80%",
  },
  badge: {
    display: "flex",
    alignItems: "center",
    gap: 3,
    padding: "1px 6px",
    fontSize: 9,
    fontWeight: 600,
    color: "#ddd",
    border: "1px solid",
    borderRadius: 10,
    cursor: "pointer",
    background: "transparent",
    transition: "opacity 0.15s",
    whiteSpace: "nowrap",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    display: "inline-block",
    flexShrink: 0,
  },
  popup: {
    position: "fixed",
    minWidth: 180,
    background: "rgba(20, 20, 40, 0.92)",
    backdropFilter: "blur(8px)",
    border: "1px solid #555",
    borderRadius: 6,
    boxShadow: "0 4px 16px rgba(0,0,0,0.6)",
    zIndex: 100,
    fontSize: 11,
    color: "#ddd",
  },
  popupHeader: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 8px",
    borderBottom: "1px solid #444",
    fontSize: 12,
  },
  popupClose: {
    marginLeft: "auto",
    background: "none",
    border: "none",
    color: "#888",
    cursor: "pointer",
    fontSize: 14,
    padding: 0,
    lineHeight: 1,
  },
  popupBody: {
    padding: "6px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  popupRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
  },
  popupLabel: {
    color: "#888",
    fontSize: 10,
  },
  popupActions: {
    padding: "4px 8px 6px",
    borderTop: "1px solid #444",
    display: "flex",
    justifyContent: "flex-end",
  },
  popupToggle: {
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 3,
    background: "rgba(255,255,255,0.1)",
    color: "#ccc",
    border: "1px solid #555",
    cursor: "pointer",
  },
};
