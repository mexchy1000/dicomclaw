import { useMemo } from "react";
import type { ContourLabel } from "../../hooks/useOverlays";
import type { OrientationMode } from "../../hooks/useDicomViewer";

interface Props {
  labels: ContourLabel[];
  activeLabels: Set<string>;
  sliceIndex: number;
  totalSlices: number;
  niftiDepth: number;
  /** If true, NIfTI z-order is reversed relative to DICOM */
  reverseZ?: boolean;
  /** Current orientation - contours only shown in axial */
  orientation?: OrientationMode;
  /** Where the full image maps to on the canvas (pixels). When provided, contours follow zoom/pan. */
  imageRect?: { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean } | null;
}

/**
 * SVG overlay that renders segmentation contours on top of a viewport.
 * Coordinates are normalized 0..1 from the contour extraction.
 * When imageRect is provided, the SVG is positioned to match the viewport's
 * current zoom/pan state so contours track the image.
 */
export default function ContourOverlay({
  labels,
  activeLabels,
  sliceIndex,
  totalSlices,
  niftiDepth,
  reverseZ = true,
  orientation = "axial",
  imageRect,
}: Props) {
  // Only render in axial orientation (contours are axial-only)
  if (orientation !== "axial") return null;
  // Map DICOM slice index → NIfTI z-index
  const niftiZ = useMemo(() => {
    if (niftiDepth <= 0 || totalSlices <= 0) return -1;
    // Proportional mapping when slice counts differ
    const ratio = sliceIndex / Math.max(totalSlices - 1, 1);
    const z = Math.round(ratio * (niftiDepth - 1));
    return reverseZ ? niftiDepth - 1 - z : z;
  }, [sliceIndex, totalSlices, niftiDepth, reverseZ]);

  const paths = useMemo(() => {
    if (niftiZ < 0) return [];
    const zKey = String(niftiZ);
    const result: { key: string; d: string; color: string }[] = [];

    for (const label of labels) {
      if (!activeLabels.has(label.name)) continue;
      const sliceContours = label.contours[zKey];
      if (!sliceContours) continue;

      for (let ci = 0; ci < sliceContours.length; ci++) {
        const polyline = sliceContours[ci];
        if (polyline.length < 3) continue;

        const parts: string[] = [];
        for (let i = 0; i < polyline.length; i++) {
          const [x, y] = polyline[i];
          // Flip both axes: NIfTI RAS+ (X+=Right, Y+=Anterior)
          // → Cornerstone display (x: Right→Left, y: Anterior→Posterior)
          const fx = (1 - x) * 100;
          const fy = (1 - y) * 100;
          const cmd = i === 0 ? "M" : "L";
          parts.push(`${cmd}${fx.toFixed(2)},${fy.toFixed(2)}`);
        }
        parts.push("Z");

        result.push({
          key: `${label.name}-${niftiZ}-${ci}`,
          d: parts.join(" "),
          color: label.color,
        });
      }
    }
    return result;
  }, [labels, activeLabels, niftiZ]);

  if (paths.length === 0) return null;

  // When imageRect is available, position SVG to match the viewport's image rendering.
  // This makes contours follow zoom/pan correctly.
  // When not available, fall back to filling the entire cell (legacy behavior).
  // Build CSS transform for axis flips (when direction matrix causes inversion)
  const flipTransform = imageRect
    ? [
        imageRect.flipX ? "scaleX(-1)" : "",
        imageRect.flipY ? "scaleY(-1)" : "",
      ].filter(Boolean).join(" ") || undefined
    : undefined;

  const svgStyle: React.CSSProperties = imageRect && imageRect.w > 0 && imageRect.h > 0
    ? {
        position: "absolute",
        left: imageRect.x,
        top: imageRect.y,
        width: imageRect.w,
        height: imageRect.h,
        pointerEvents: "none",
        zIndex: 4,
        overflow: "visible",
        transform: flipTransform,
        transformOrigin: "center center",
      }
    : {
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 4,
      };

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={svgStyle}
    >
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill={p.color}
          fillOpacity={0.08}
          stroke={p.color}
          strokeWidth="0.3"
          strokeLinejoin="round"
          opacity={0.85}
        />
      ))}
    </svg>
  );
}
