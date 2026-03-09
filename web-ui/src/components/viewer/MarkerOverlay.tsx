/**
 * SVG overlay for the single click marker (yellow circle) and user-drawn VOI spheres.
 * Positioned on top of each Cornerstone viewport cell.
 *
 * For thresholded VOIs, renders the actual isocontour (filled voxels above threshold)
 * instead of a simple dashed circle.
 *
 * VOI elements are interactive: click opens threshold menu, drag moves the VOI.
 * The rest of the overlay is pointerEvents: none so Cornerstone tools still work.
 */
import { useState, useRef, useCallback } from "react";
import type { ViewerMarker, UserVoi } from "../../hooks/useViewerMarkers";

interface Props {
  marker: ViewerMarker | null;
  userVois: UserVoi[];
  worldToCanvas: ((worldPos: [number, number, number]) => [number, number] | null) | null;
  canvasToWorld?: ((canvasPos: [number, number]) => [number, number, number] | null) | null;
  vpSize: { width: number; height: number };
  focalZ?: number;
  sliceThickness?: number;
  vpId?: string;
  canvasOffset?: { x: number; y: number };
  /** Isocontour data getter */
  getSliceIsocontour?: ((
    center: [number, number, number],
    radiusMm: number,
    threshold: { type: "percent" | "absolute"; value: number },
    sliceWorldZ: number,
  ) => { points: Array<[number, number, number]>; spacing: [number, number] } | null) | null;
  /** VOI interaction callbacks */
  onVoiClick?: (voiId: number) => void;
  onVoiDragEnd?: (voiId: number, newCenter: [number, number, number]) => void;
}

interface DragState {
  voiId: number;
  startClientX: number;
  startClientY: number;
  currentDx: number;
  currentDy: number;
  isDragging: boolean;
}

export default function MarkerOverlay({
  marker,
  userVois,
  worldToCanvas,
  canvasToWorld,
  vpSize,
  focalZ,
  sliceThickness = 5,
  canvasOffset = { x: 0, y: 0 },
  getSliceIsocontour,
  onVoiClick,
  onVoiDragEnd,
}: Props) {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  if (!worldToCanvas || vpSize.width < 10) return null;

  const halfThick = sliceThickness * 2;

  // Convert world to cell-relative CSS pixels
  const w2c = (wp: [number, number, number]): { x: number; y: number } | null => {
    const cp = worldToCanvas(wp);
    if (!cp) return null;
    return { x: cp[0] + canvasOffset.x, y: cp[1] + canvasOffset.y };
  };

  const cellW = vpSize.width + canvasOffset.x;
  const cellH = vpSize.height + canvasOffset.y;

  // VOI pointer handlers
  const handleVoiPointerDown = useCallback((voiId: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state: DragState = {
      voiId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      currentDx: 0,
      currentDy: 0,
      isDragging: false,
    };
    dragRef.current = state;
    setDragState(state);
  }, []);

  const handleVoiPointerMove = useCallback((e: React.PointerEvent) => {
    const ds = dragRef.current;
    if (!ds) return;
    const dx = e.clientX - ds.startClientX;
    const dy = e.clientY - ds.startClientY;
    if (!ds.isDragging && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    const updated = { ...ds, currentDx: dx, currentDy: dy, isDragging: true };
    dragRef.current = updated;
    setDragState(updated);
  }, []);

  const handleVoiPointerUp = useCallback((_e: React.PointerEvent) => {
    const ds = dragRef.current;
    if (!ds) return;
    dragRef.current = null;
    setDragState(null);

    if (ds.isDragging && onVoiDragEnd && worldToCanvas && canvasToWorld) {
      // Compute new center using world-space delta
      const voi = userVois.find((v) => v.id === ds.voiId);
      if (voi) {
        const cp = worldToCanvas(voi.center);
        if (cp) {
          const startWorld = canvasToWorld(cp);
          const endWorld = canvasToWorld([cp[0] + ds.currentDx, cp[1] + ds.currentDy]);
          if (startWorld && endWorld) {
            const newCenter: [number, number, number] = [
              voi.center[0] + (endWorld[0] - startWorld[0]),
              voi.center[1] + (endWorld[1] - startWorld[1]),
              voi.center[2] + (endWorld[2] - startWorld[2]),
            ];
            onVoiDragEnd(ds.voiId, newCenter);
          }
        }
      }
    } else if (!ds.isDragging) {
      // Click
      onVoiClick?.(ds.voiId);
    }
  }, [userVois, worldToCanvas, canvasToWorld, onVoiClick, onVoiDragEnd]);

  const elements: React.ReactNode[] = [];

  // Render VOIs first (behind marker)
  for (const v of userVois) {
    const dragOffset = dragState?.voiId === v.id && dragState.isDragging
      ? { x: dragState.currentDx, y: dragState.currentDy }
      : { x: 0, y: 0 };

    const pos = w2c(v.center);
    if (!pos) continue;
    pos.x += dragOffset.x;
    pos.y += dragOffset.y;

    // Project sphere radius to canvas pixels
    const edgePos = w2c([v.center[0] + v.radiusMm, v.center[1], v.center[2]]);
    let radiusPx = 15;
    if (edgePos) {
      radiusPx = Math.max(5, Math.sqrt((edgePos.x + dragOffset.x - pos.x) ** 2 + (edgePos.y + dragOffset.y - pos.y) ** 2));
    }

    // Check if sphere intersects current slice
    if (focalZ !== undefined) {
      const dist = Math.abs(v.center[2] - focalZ);
      if (dist > v.radiusMm) continue;
      const ratio = Math.sqrt(1 - (dist / v.radiusMm) ** 2);
      radiusPx *= ratio;
    }

    if (pos.x < -50 || pos.y < -50 || pos.x > cellW + 50 || pos.y > cellH + 50) continue;

    // Check if this VOI has a threshold → render isocontour
    const hasThreshold = v.stats?.thresholdType && v.stats?.thresholdValue;
    let isoPath: string | null = null;
    let voxelPxW = 0;
    let voxelPxH = 0;

    if (hasThreshold && getSliceIsocontour && focalZ !== undefined) {
      const iso = getSliceIsocontour(
        v.center,
        v.radiusMm,
        { type: v.stats!.thresholdType!, value: v.stats!.thresholdValue! },
        focalZ,
      );
      if (iso && iso.points.length > 0) {
        // Compute voxel pixel size
        const p0 = w2c(iso.points[0]);
        const pDx = w2c([iso.points[0][0] + iso.spacing[0], iso.points[0][1], iso.points[0][2]]);
        const pDy = w2c([iso.points[0][0], iso.points[0][1] + iso.spacing[1], iso.points[0][2]]);
        if (p0 && pDx && pDy) {
          voxelPxW = Math.max(1, Math.abs(pDx.x - p0.x));
          voxelPxH = Math.max(1, Math.abs(pDy.y - p0.y));

          // Build single SVG path for all voxel rectangles
          const parts: string[] = [];
          for (const pt of iso.points) {
            const sp = w2c(pt);
            if (!sp) continue;
            const rx = sp.x + dragOffset.x - voxelPxW / 2;
            const ry = sp.y + dragOffset.y - voxelPxH / 2;
            parts.push(`M${rx},${ry}h${voxelPxW}v${voxelPxH}h${-voxelPxW}z`);
          }
          if (parts.length > 0) isoPath = parts.join("");
        }
      }
    }

    elements.push(
      <div key={`voi-${v.id}`} style={{
        position: "absolute",
        left: pos.x - radiusPx - 2,
        top: pos.y - radiusPx - 2,
        width: (radiusPx + 2) * 2,
        height: (radiusPx + 2) * 2,
        pointerEvents: "auto",
        cursor: dragState?.voiId === v.id && dragState.isDragging ? "grabbing" : "grab",
      }}
        onPointerDown={(e) => handleVoiPointerDown(v.id, e)}
        onPointerMove={handleVoiPointerMove}
        onPointerUp={handleVoiPointerUp}
      >
        {/* Dashed sphere outline (always shown) */}
        <div style={{
          position: "absolute",
          left: 2,
          top: 2,
          width: radiusPx * 2,
          height: radiusPx * 2,
          borderRadius: "50%",
          border: `1.5px dashed ${v.color}`,
          background: isoPath ? "none" : `${v.color}1e`,
          opacity: isoPath ? 0.4 : 0.85,
          pointerEvents: "none",
        }} />

        {/* Isocontour (thresholded voxels) rendered as SVG */}
        {isoPath && (
          <svg style={{
            position: "absolute",
            left: -(pos.x - radiusPx - 2),
            top: -(pos.y - radiusPx - 2),
            width: cellW,
            height: cellH,
            pointerEvents: "none",
            overflow: "visible",
          }}>
            <path d={isoPath} fill={v.color} fillOpacity={0.35} stroke={v.color} strokeWidth={1} strokeOpacity={0.8} />
          </svg>
        )}

        {/* Label above */}
        <span style={{
          position: "absolute",
          top: -14,
          left: "50%",
          transform: "translateX(-50%)",
          color: v.color,
          fontSize: 10,
          fontWeight: 700,
          whiteSpace: "nowrap",
          textShadow: "0 0 3px #000, 0 0 3px #000",
          pointerEvents: "none",
        }}>
          {v.label}
        </span>

        {/* Stats in center */}
        {v.stats && (
          <span style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#fff",
            fontSize: 9,
            textShadow: "0 0 3px #000, 0 0 3px #000",
            pointerEvents: "none",
            whiteSpace: "nowrap",
          }}>
            {v.stats.suvMax.toFixed(1)}
            {v.stats.thresholdType && (
              <span style={{ color: "#4a9eff", fontSize: 8 }}>
                {" "}{v.stats.volumeMl.toFixed(1)}ml
              </span>
            )}
          </span>
        )}
      </div>,
    );
  }

  // Render marker
  if (marker) {
    const inSlice = focalZ === undefined || Math.abs(marker.worldPos[2] - focalZ) <= halfThick;
    if (inSlice) {
      const pos = w2c(marker.worldPos);
      if (pos && pos.x > -20 && pos.y > -20 && pos.x < cellW + 20 && pos.y < cellH + 20) {
        elements.push(
          <div key="marker" style={{
            position: "absolute",
            left: pos.x - 8,
            top: pos.y - 8,
            width: 16,
            height: 16,
            pointerEvents: "none",
          }}>
            {/* Thin outer ring */}
            <div style={{
              position: "absolute",
              left: 1,
              top: 1,
              width: 14,
              height: 14,
              borderRadius: "50%",
              border: "1px solid #ffd43b",
              opacity: 0.85,
            }} />
            {/* Tiny center dot */}
            <div style={{
              position: "absolute",
              left: 6.5,
              top: 6.5,
              width: 3,
              height: 3,
              borderRadius: "50%",
              background: "#ffd43b",
              opacity: 0.9,
            }} />
            {/* Thin crosshair arms */}
            <div style={{ position: "absolute", left: -5, top: 7.5, width: 5, height: 1, background: "#ffd43b", opacity: 0.6 }} />
            <div style={{ position: "absolute", right: -5, top: 7.5, width: 5, height: 1, background: "#ffd43b", opacity: 0.6 }} />
            <div style={{ position: "absolute", left: 7.5, top: -5, width: 1, height: 5, background: "#ffd43b", opacity: 0.6 }} />
            <div style={{ position: "absolute", left: 7.5, bottom: -5, width: 1, height: 5, background: "#ffd43b", opacity: 0.6 }} />
          </div>,
        );
        if (marker.label) {
          elements.push(
            <div key="marker-label" style={{
              position: "absolute",
              left: pos.x + 14,
              top: pos.y - 8,
              color: "#ffd43b",
              fontSize: 10,
              fontWeight: 600,
              textShadow: "0 0 3px #000, 0 0 3px #000",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}>
              {marker.label}
            </div>,
          );
        }
      }
    }
  }

  if (elements.length === 0) return null;

  return (
    <div style={{
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: 5,
      overflow: "hidden",
    }}>
      {elements}
    </div>
  );
}
