/**
 * Popup menu for auto-threshold VOI refinement (isometabolic volume).
 * Appears when clicking on a drawn VOI sphere.
 *
 * % of SUVmax: voxels with SUV >= SUVmax * (value/100) are counted
 * Absolute SUV: voxels with SUV >= value are counted
 */
import { useState } from "react";
import type { UserVoi } from "../../hooks/useViewerMarkers";

interface Props {
  voi: UserVoi;
  position: { x: number; y: number };
  onApplyThreshold: (voiId: number, type: "percent" | "absolute", value: number) => void;
  onDelete: (voiId: number) => void;
  onClose: () => void;
}

export default function VoiThresholdMenu({ voi, position, onApplyThreshold, onDelete, onClose }: Props) {
  const [threshType, setThreshType] = useState<"percent" | "absolute">(
    voi.stats?.thresholdType || "percent"
  );
  const [threshValue, setThreshValue] = useState(
    voi.stats?.thresholdValue?.toString() || "40"
  );

  const handleApply = () => {
    const val = parseFloat(threshValue);
    if (isNaN(val) || val <= 0) return;
    onApplyThreshold(voi.id, threshType, val);
    onClose();
  };

  const cutoffLabel = voi.stats
    ? threshType === "percent"
      ? `Cutoff: SUV ≥ ${(voi.stats.suvMax * (parseFloat(threshValue) || 40) / 100).toFixed(2)}`
      : `Cutoff: SUV ≥ ${threshValue}`
    : null;

  return (
    <div
      style={{
        position: "absolute",
        left: Math.min(position.x, window.innerWidth - 220),
        top: Math.min(position.y, window.innerHeight - 300),
        background: "#1a1a2e",
        border: "1px solid #444",
        borderRadius: 8,
        padding: 10,
        zIndex: 100,
        width: 210,
        boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        fontSize: 12,
        color: "#ddd",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, color: voi.color }}>{voi.label}</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", cursor: "pointer", fontSize: 14 }}>
          ×
        </button>
      </div>

      {/* Stats */}
      {voi.stats && (
        <div style={{ fontSize: 10, color: "#aaa", marginBottom: 8, lineHeight: 1.6 }}>
          SUVmax: <b style={{ color: "#fff" }}>{voi.stats.suvMax.toFixed(2)}</b> | SUVmean: {voi.stats.suvMean.toFixed(2)}<br />
          Volume: <b style={{ color: "#fff" }}>{voi.stats.volumeMl.toFixed(1)} ml</b>
          {voi.stats.thresholdType && (
            <>
              <br />
              <span style={{ color: "#4a9eff" }}>
                Threshold: {voi.stats.thresholdValue}{voi.stats.thresholdType === "percent" ? "%" : " SUV"}
              </span>
            </>
          )}
        </div>
      )}

      {/* Threshold type */}
      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: "#888", marginBottom: 4 }}>
          Isometabolic Volume Threshold
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 3, cursor: "pointer" }}>
          <input type="radio" checked={threshType === "percent"} onChange={() => setThreshType("percent")}
            style={{ accentColor: voi.color }} />
          <span>% of SUVmax</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="radio" checked={threshType === "absolute"} onChange={() => setThreshType("absolute")}
            style={{ accentColor: voi.color }} />
          <span>Absolute SUV</span>
        </label>
      </div>

      {/* Threshold value */}
      <div style={{ display: "flex", gap: 4, marginBottom: 4 }}>
        <input
          value={threshValue}
          onChange={(e) => setThreshValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
          style={{
            flex: 1,
            background: "#222",
            border: "1px solid #555",
            borderRadius: 4,
            padding: "4px 6px",
            color: "#fff",
            fontSize: 12,
            outline: "none",
          }}
          placeholder={threshType === "percent" ? "e.g. 40" : "e.g. 2.5"}
          autoFocus
        />
        <span style={{ alignSelf: "center", color: "#888", fontSize: 11 }}>
          {threshType === "percent" ? "%" : "SUV"}
        </span>
      </div>

      {/* Cutoff preview */}
      {cutoffLabel && (
        <div style={{ fontSize: 9, color: "#888", marginBottom: 8 }}>
          {cutoffLabel}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: "flex", gap: 4 }}>
        <button
          onClick={handleApply}
          style={{
            flex: 1,
            padding: "5px 0",
            borderRadius: 4,
            background: voi.color,
            color: "#fff",
            border: "none",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Apply
        </button>
        <button
          onClick={() => { onDelete(voi.id); onClose(); }}
          style={{
            padding: "5px 8px",
            borderRadius: 4,
            background: "#333",
            color: "#f66",
            border: "1px solid #f66",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Del
        </button>
      </div>
    </div>
  );
}
