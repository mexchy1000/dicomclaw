import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import type { ContourLabel } from "../../hooks/useOverlays";

export interface MipCanvasHandle {
  getCanvas: () => HTMLCanvasElement | null;
}

interface Props {
  petData: Float32Array | null;
  dims: [number, number, number]; // [cols(X), rows(Y), slices(Z)]
  spacing: [number, number, number]; // [sx, sy, sz]
  voiRange: [number, number];
  /** Current position in voxel coordinates for crosshair */
  currentVoxel: [number, number, number] | null;
  /** Called with voxel coordinates on click */
  onMipClick: (vx: number, vy: number, vz: number) => void;
  /** Rotation angle in degrees (0-359), scroll changes this */
  angle: number;
  onAngleChange: (angle: number) => void;
  /** VOI overlay labels to project onto MIP (each label carries its own spatial info) */
  overlayLabels?: ContourLabel[];
  /** Which labels are active/visible */
  activeLabels?: Set<string>;
  /** PET volume origin in LPS world coordinates */
  petVolumeOrigin?: [number, number, number];
  /** PET volume direction matrix (9 elements) */
  petVolumeDirection?: number[];
}

// Hot colormap: black → red → yellow → white
function hotColor(t: number): [number, number, number] {
  const r = Math.min(1, t * 3);
  const g = Math.min(1, Math.max(0, (t - 0.33) * 3));
  const b = Math.min(1, Math.max(0, (t - 0.66) * 3));
  return [r * 255, g * 255, b * 255];
}

/**
 * Canvas-based rotating MIP (Maximum Intensity Projection).
 * Projects PET volume at the given angle around the Z axis.
 * Scroll = rotate angle, Click = navigate to 3D position.
 * Crosshair shows current viewport position.
 */
const MipCanvas = forwardRef<MipCanvasHandle, Props>(function MipCanvas({
  petData, dims, spacing, voiRange,
  currentVoxel, onMipClick, angle, onAngleChange,
  overlayLabels, activeLabels, petVolumeOrigin, petVolumeDirection,
}: Props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }));

  /** Compute MIP display geometry (fixed diagonal width) */
  const getGeometry = useCallback((cw: number, ch: number) => {
    const [nx, ny, nz] = dims;
    const theta = (angle * Math.PI) / 180;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const maxDepth = Math.ceil(Math.sqrt(nx * nx + ny * ny));
    const outW = maxDepth; // fixed width regardless of angle
    const outH = nz;
    const centerX = (nx - 1) / 2;
    const centerY = (ny - 1) / 2;
    const centerU = (outW - 1) / 2;
    const halfDepth = maxDepth / 2;

    const pxW = Math.min(spacing[0], spacing[1]);
    const physW = outW * pxW;
    const physH = outH * spacing[2];
    const ar = physW / physH;

    let drawW: number, drawH: number, offsetX: number, offsetY: number;
    if (cw / ch > ar) {
      drawH = ch;
      drawW = Math.round(ch * ar);
      offsetX = Math.round((cw - drawW) / 2);
      offsetY = 0;
    } else {
      drawW = cw;
      drawH = Math.round(cw / ar);
      offsetX = 0;
      offsetY = Math.round((ch - drawH) / 2);
    }

    return { outW, outH, centerX, centerY, centerU, maxDepth, halfDepth, cosT, sinT, drawW, drawH, offsetX, offsetY };
  }, [dims, spacing, angle]);

  const renderMip = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !petData || !dims[0]) return;

    const [nx, ny, nz] = dims;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cw = Math.round(rect.width);
    const ch = Math.round(rect.height);
    if (cw < 10 || ch < 10) return;

    canvas.width = cw;
    canvas.height = ch;

    const g = getGeometry(cw, ch);

    // Compute rotated MIP
    const mipData = new Float32Array(g.outW * g.outH);
    for (let z = 0; z < nz; z++) {
      const outZ = nz - 1 - z; // flip: head at top
      const zOff = z * nx * ny;
      for (let u = 0; u < g.outW; u++) {
        let maxVal = 0;
        const du = u - g.centerU;
        for (let t = 0; t < g.maxDepth; t++) {
          const dt = t - g.halfDepth;
          const x = g.centerX + g.cosT * du + g.sinT * dt;
          const y = g.centerY - g.sinT * du + g.cosT * dt;
          const ix = Math.round(x);
          const iy = Math.round(y);
          if (ix >= 0 && ix < nx && iy >= 0 && iy < ny) {
            const v = petData[zOff + iy * nx + ix];
            if (v > maxVal) maxVal = v;
          }
        }
        mipData[outZ * g.outW + u] = maxVal;
      }
    }

    // Colorize
    const imgData = ctx.createImageData(g.outW, g.outH);
    const [vMin, vMax] = voiRange;
    const range = vMax - vMin || 1;
    for (let i = 0; i < mipData.length; i++) {
      const t = Math.max(0, Math.min(1, (mipData[i] - vMin) / range));
      const [r, gb, b] = hotColor(t);
      const off = i * 4;
      imgData.data[off] = r;
      imgData.data[off + 1] = gb;
      imgData.data[off + 2] = b;
      imgData.data[off + 3] = 255;
    }

    const offscreen = document.createElement("canvas");
    offscreen.width = g.outW;
    offscreen.height = g.outH;
    offscreen.getContext("2d")!.putImageData(imgData, 0, 0);

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreen, g.offsetX, g.offsetY, g.drawW, g.drawH);

    // Crosshair from currentVoxel
    if (currentVoxel && nz > 1) {
      const [vx, vy, vz] = currentVoxel;

      // Horizontal line: Z position (flipped: head=high z at top)
      const zRatio = Math.max(0, Math.min(1, (nz - 1 - vz) / (nz - 1)));
      const lineY = g.offsetY + zRatio * g.drawH;

      // Vertical line: project (vx, vy) onto MIP horizontal axis
      const du = g.cosT * (vx - g.centerX) - g.sinT * (vy - g.centerY);
      const uRatio = Math.max(0, Math.min(1, (du + g.centerU) / (g.outW - 1)));
      const lineX = g.offsetX + uRatio * g.drawW;

      ctx.strokeStyle = "cyan";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);

      // Horizontal
      ctx.beginPath();
      ctx.moveTo(g.offsetX, lineY);
      ctx.lineTo(g.offsetX + g.drawW, lineY);
      ctx.stroke();

      // Vertical
      ctx.beginPath();
      ctx.moveTo(lineX, g.offsetY);
      ctx.lineTo(lineX, g.offsetY + g.drawH);
      ctx.stroke();

      ctx.setLineDash([]);
    }

    // VOI overlay projection onto MIP
    if (overlayLabels && activeLabels) {
      const [nx, ny, nz] = dims;

      // Compute PET volume z-range in world coordinates (LPS S = RAS S)
      const dirZ = petVolumeDirection?.[8] ?? 1; // z-component of k-direction
      const petZStart = petVolumeOrigin?.[2] ?? 0;
      const petZEnd = petZStart + (nz - 1) * spacing[2] * dirZ;
      const petZMin = Math.min(petZStart, petZEnd);
      const petZMax = Math.max(petZStart, petZEnd);
      const petZRange = petZMax - petZMin || 1;

      /** Convert NIfTI z-index to MIP screen Y using world coordinates */
      const niftiZToScreenY = (niftiZ: number, label: typeof overlayLabels[0]): number => {
        if (label.rasOrigin && label.voxelSizes) {
          // World-coordinate mapping: NIfTI RAS+ z → PET volume fraction
          const worldZ = label.rasOrigin[2] + niftiZ * label.voxelSizes[2];
          const frac = (worldZ - petZMin) / petZRange; // 0=inferior, 1=superior
          const yRatio = 1 - frac; // top=superior in MIP
          return g.offsetY + yRatio * g.drawH;
        }
        // Fallback: proportional mapping (old behavior)
        const depth = label.niftiDepth || nz;
        const yRatio = 1 - niftiZ / Math.max(depth - 1, 1);
        return g.offsetY + yRatio * g.drawH;
      };

      for (const label of overlayLabels) {
        if (!activeLabels.has(label.name)) continue;
        const col = label.color;
        ctx.save();
        ctx.globalAlpha = 0.35;
        // For each z-slice that has contours, project contour points onto MIP plane
        for (const zKey of Object.keys(label.contours)) {
          const niftiZ = parseInt(zKey, 10);
          if (isNaN(niftiZ)) continue;
          const screenY = niftiZToScreenY(niftiZ, label);
          // Skip if outside MIP display area
          if (screenY < g.offsetY - 5 || screenY > g.offsetY + g.drawH + 5) continue;

          const polylines = label.contours[zKey];
          for (const poly of polylines) {
            if (poly.length < 2) continue;
            const screenXs: number[] = [];
            for (const [cx, cy] of poly) {
              const vx = (1 - cx) * (nx - 1);
              const vy = (1 - cy) * (ny - 1);
              const du = g.cosT * (vx - g.centerX) - g.sinT * (vy - g.centerY);
              const uRatio = (du + g.centerU) / Math.max(g.outW - 1, 1);
              screenXs.push(g.offsetX + uRatio * g.drawW);
            }
            const minX = Math.max(g.offsetX, Math.min(...screenXs));
            const maxX = Math.min(g.offsetX + g.drawW, Math.max(...screenXs));
            if (maxX > minX) {
              ctx.fillStyle = col;
              const bandH = Math.max(1, g.drawH / g.outH);
              ctx.fillRect(minX, screenY - bandH / 2, maxX - minX, bandH);
            }
          }
        }
        // Draw outline border for the projected region
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        const allPoints: [number, number][] = [];
        for (const zKey of Object.keys(label.contours)) {
          const niftiZ = parseInt(zKey, 10);
          if (isNaN(niftiZ)) continue;
          const screenY = niftiZToScreenY(niftiZ, label);
          if (screenY < g.offsetY - 5 || screenY > g.offsetY + g.drawH + 5) continue;
          const polylines = label.contours[zKey];
          for (const poly of polylines) {
            if (poly.length < 2) continue;
            let minU = Infinity, maxU = -Infinity;
            for (const [cx, cy] of poly) {
              const vx = (1 - cx) * (nx - 1);
              const vy = (1 - cy) * (ny - 1);
              const du = g.cosT * (vx - g.centerX) - g.sinT * (vy - g.centerY);
              const uRatio = (du + g.centerU) / Math.max(g.outW - 1, 1);
              const sx = g.offsetX + uRatio * g.drawW;
              if (sx < minU) minU = sx;
              if (sx > maxU) maxU = sx;
            }
            allPoints.push([minU, screenY]);
            allPoints.push([maxU, screenY]);
          }
        }
        // Draw left and right silhouette edges
        if (allPoints.length > 0) {
          const byY = new Map<number, { min: number; max: number }>();
          for (const [x, y] of allPoints) {
            const entry = byY.get(y);
            if (entry) {
              entry.min = Math.min(entry.min, x);
              entry.max = Math.max(entry.max, x);
            } else {
              byY.set(y, { min: x, max: x });
            }
          }
          const sorted = [...byY.entries()].sort((a, b) => a[0] - b[0]);
          if (sorted.length > 1) {
            ctx.beginPath();
            ctx.moveTo(sorted[0][1].min, sorted[0][0]);
            for (let i = 1; i < sorted.length; i++) {
              ctx.lineTo(sorted[i][1].min, sorted[i][0]);
            }
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sorted[0][1].max, sorted[0][0]);
            for (let i = 1; i < sorted.length; i++) {
              ctx.lineTo(sorted[i][1].max, sorted[i][0]);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }

    // Angle label
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "10px monospace";
    ctx.fillText(`${angle}°`, g.offsetX + 4, g.offsetY + g.drawH - 4);
  }, [petData, dims, spacing, voiRange, currentVoxel, angle, getGeometry, overlayLabels, activeLabels, petVolumeOrigin, petVolumeDirection]);

  useEffect(() => { renderMip(); }, [renderMip]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => renderMip());
    observer.observe(container);
    return () => observer.disconnect();
  }, [renderMip]);

  // Wheel = rotate angle (cycles 0-359)
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const step = 10;
      const delta = e.deltaY > 0 ? step : -step;
      onAngleChange(((angle + delta) % 360 + 360) % 360);
    },
    [angle, onAngleChange],
  );

  // Click = navigate to 3D voxel position (trace ray to find max intensity voxel)
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !petData || !dims[0]) return;

      const [nx, ny, nz] = dims;
      if (nz <= 1) return;

      const cw = canvas.width;
      const ch = canvas.height;
      const g = getGeometry(cw, ch);

      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const relX = (clickX - g.offsetX) / g.drawW;
      const relY = (clickY - g.offsetY) / g.drawH;
      if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

      // Z from vertical (flipped: top=head=high z)
      const vz = Math.round((nz - 1) * (1 - relY));
      const z = Math.max(0, Math.min(nz - 1, vz));
      const zOff = z * nx * ny;

      // Trace ray at this z-slice to find the max intensity voxel
      const u = relX * (g.outW - 1);
      const du = u - g.centerU;
      let bestX = g.centerX + g.cosT * du;
      let bestY = g.centerY - g.sinT * du;
      let bestVal = -1;

      for (let t = 0; t < g.maxDepth; t++) {
        const dt = t - g.halfDepth;
        const x = g.centerX + g.cosT * du + g.sinT * dt;
        const y = g.centerY - g.sinT * du + g.cosT * dt;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix >= 0 && ix < nx && iy >= 0 && iy < ny) {
          const v = petData[zOff + iy * nx + ix];
          if (v > bestVal) {
            bestVal = v;
            bestX = x;
            bestY = y;
          }
        }
      }

      onMipClick(
        Math.max(0, Math.min(nx - 1, Math.round(bestX))),
        Math.max(0, Math.min(ny - 1, Math.round(bestY))),
        Math.max(0, Math.min(nz - 1, z)),
      );
    },
    [petData, dims, getGeometry, onMipClick],
  );

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative", cursor: "crosshair" }}
    >
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onWheel={handleWheel}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
});

export default MipCanvas;
