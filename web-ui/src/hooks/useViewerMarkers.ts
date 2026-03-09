/**
 * Shared state for click marker and user-drawn VOIs on the DICOM viewer.
 *
 * Marker: single yellow circle placed by clicking on any viewport.
 *   Clicking elsewhere moves it; only one marker at a time.
 * VOIs: spheres drawn by drag on PET/Fusion, with auto-threshold refinement.
 */
import { useState, useCallback, useRef } from "react";

export interface ViewerMarker {
  /** World LPS coordinates */
  worldPos: [number, number, number];
  /** Label shown next to marker */
  label?: string;
}

export interface UserVoi {
  id: number;
  /** Center in world LPS coordinates */
  center: [number, number, number];
  /** Radius in mm */
  radiusMm: number;
  /** Label */
  label: string;
  /** Color */
  color: string;
  /** Visible on viewer */
  visible: boolean;
  /** SUV stats (filled after threshold) */
  stats?: {
    suvMax: number;
    suvMean: number;
    volumeMl: number;
    thresholdType?: "percent" | "absolute";
    thresholdValue?: number;
  };
}

const VOI_COLORS = [
  "#ff6b6b", "#51cf66", "#339af0", "#fcc419", "#cc5de8",
  "#20c997", "#ff922b", "#845ef7", "#22b8cf", "#f06595",
];

export function useViewerMarkers() {
  /** Single marker — replaced on each click */
  const [marker, setMarkerState] = useState<ViewerMarker | null>(null);
  /** Whether marker tool is enabled (default ON) */
  const [markerEnabled, setMarkerEnabled] = useState(true);
  const [userVois, setUserVois] = useState<UserVoi[]>([]);
  const nextManualVoiId = useRef(1);

  const setMarker = useCallback((worldPos: [number, number, number], label?: string) => {
    setMarkerState({ worldPos, label });
  }, []);

  const clearMarker = useCallback(() => setMarkerState(null), []);

  const addVoi = useCallback((center: [number, number, number], radiusMm: number): UserVoi => {
    const num = nextManualVoiId.current++;
    const color = VOI_COLORS[(num - 1) % VOI_COLORS.length];
    const voi: UserVoi = {
      id: num,
      center,
      radiusMm,
      label: `VOI-m${String(num).padStart(3, "0")}`,
      color,
      visible: true,
    };
    setUserVois((prev) => [...prev, voi]);
    return voi;
  }, []);

  const updateVoiStats = useCallback((id: number, stats: UserVoi["stats"]) => {
    setUserVois((prev) =>
      prev.map((v) => (v.id === id ? { ...v, stats } : v)),
    );
  }, []);

  const updateVoiCenter = useCallback((id: number, center: [number, number, number]) => {
    setUserVois((prev) =>
      prev.map((v) => (v.id === id ? { ...v, center, stats: undefined } : v)),
    );
  }, []);

  const updateVoiRadius = useCallback((id: number, radiusMm: number) => {
    setUserVois((prev) =>
      prev.map((v) => (v.id === id ? { ...v, radiusMm } : v)),
    );
  }, []);

  const removeVoi = useCallback((id: number) => {
    setUserVois((prev) => prev.filter((v) => v.id !== id));
  }, []);

  const toggleVoiVisibility = useCallback((id: number) => {
    setUserVois((prev) =>
      prev.map((v) => (v.id === id ? { ...v, visible: !v.visible } : v)),
    );
  }, []);

  return {
    marker, setMarker, clearMarker,
    markerEnabled, setMarkerEnabled,
    userVois, addVoi, updateVoiStats, updateVoiCenter, updateVoiRadius, removeVoi,
    toggleVoiVisibility,
  };
}
