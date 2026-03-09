import { useEffect, useState, useCallback, useRef } from "react";
import type { Socket } from "socket.io-client";

const VOI_PALETTE = [
  "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#42d4f4", "#f032e6", "#ffe119", "#469990", "#dcbeff",
];

export interface ContourLabel {
  value: number;
  name: string;
  color: string;
  contours: Record<string, number[][][]>; // z_index → polyline[]
  voiIndex?: number; // unique per-label VOI number
  /** Per-overlay spatial info for world-coordinate z mapping on MIP */
  rasOrigin?: [number, number, number];
  voxelSizes?: [number, number, number];
  niftiDepth?: number;
}

export interface OverlayData {
  studyUid: string;
  segPath: string;
  labels: ContourLabel[];
  shape: [number, number, number]; // [W, H, D]
  rasOrigin?: [number, number, number]; // NIfTI canonical origin in RAS
  voxelSizes?: [number, number, number]; // NIfTI voxel sizes in mm
  metadata?: { name: string; suv_max?: number; volume_ml?: number; value?: number }[];
  voiIndex: number; // 1-based VOI number
}

export interface UseOverlaysReturn {
  overlays: OverlayData[];
  activeLabels: Set<string>;
  toggleLabel: (name: string) => void;
  selectedLabel: string | null;
  setSelectedLabel: (name: string | null) => void;
}

export function useOverlays(
  socket: Socket | null,
  studyUid: string | null,
  sessionId: string | null = null,
): UseOverlaysReturn {
  const [overlays, setOverlays] = useState<OverlayData[]>([]);
  const [activeLabels, setActiveLabels] = useState<Set<string>>(new Set());
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const fetchedPaths = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Array<{
    study_uid: string; path: string;
    labels: { name: string; suv_max?: number; volume_ml?: number; value?: number }[];
  }>>([]);

  const voiCounter = useRef(0);

  const prevStudyUid = useRef<string | null>(null);

  // Reset when study or session changes
  useEffect(() => {
    setOverlays([]);
    setActiveLabels(new Set());
    setSelectedLabel(null);
    fetchedPaths.current.clear();
    voiCounter.current = 0;
    pendingRef.current = [];

    // If studyUid changed within the same session (e.g. batch mode),
    // re-request overlays for the new study
    if (studyUid && socket && sessionId && prevStudyUid.current !== null && prevStudyUid.current !== studyUid) {
      socket.emit("request-session-overlays", { sessionId, studyUid });
    }
    prevStudyUid.current = studyUid;
  }, [studyUid, sessionId, socket]);

  // Process pending overlays when studyUid becomes available
  const processOverlay = useCallback((data: {
    study_uid: string; path: string;
    labels: { name: string; suv_max?: number; volume_ml?: number; value?: number }[];
  }) => {
    if (fetchedPaths.current.has(data.path)) return;
    fetchedPaths.current.add(data.path);

    const labelNamesParam = data.labels.reduce(
      (acc, l, i) => ({ ...acc, [l.value ?? (i + 1)]: l.name }),
      {} as Record<number, string>,
    );

    const params = new URLSearchParams({
      seg_path: data.path,
      labels: JSON.stringify(labelNamesParam),
    });

    fetch(`/api/overlays/${data.study_uid}/contours?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((contourData: { labels: ContourLabel[]; shape: [number, number, number]; ras_origin?: number[]; voxel_sizes?: number[] }) => {
        const coloredLabels = contourData.labels.map((l) => {
          voiCounter.current += 1;
          const idx = voiCounter.current;
          return { ...l, color: VOI_PALETTE[(idx - 1) % VOI_PALETTE.length], voiIndex: idx };
        });
        const overlay: OverlayData = {
          studyUid: data.study_uid,
          segPath: data.path,
          labels: coloredLabels,
          shape: contourData.shape,
          rasOrigin: contourData.ras_origin as [number, number, number] | undefined,
          voxelSizes: contourData.voxel_sizes as [number, number, number] | undefined,
          metadata: data.labels,
          voiIndex: voiCounter.current,
        };
        setOverlays((prev) => [...prev, overlay]);
        setActiveLabels((prev) => {
          const next = new Set(prev);
          for (const l of contourData.labels) next.add(l.name);
          return next;
        });
      })
      .catch((err) => {
        console.error("Failed to fetch contours:", err);
        fetchedPaths.current.delete(data.path);
      });
  }, []);

  // Flush pending when studyUid arrives
  useEffect(() => {
    if (!studyUid || pendingRef.current.length === 0) return;
    const toProcess = pendingRef.current.filter((d) => d.study_uid === studyUid);
    pendingRef.current = [];
    for (const d of toProcess) processOverlay(d);
  }, [studyUid, processOverlay]);

  // Listen for overlay-available events
  useEffect(() => {
    if (!socket) return;

    const handler = (data: {
      sessionId: string;
      study_uid: string;
      path: string;
      labels: { name: string; suv_max?: number; volume_ml?: number; value?: number }[];
    }) => {
      // If studyUid not yet known, queue it
      if (!studyUid) {
        pendingRef.current.push(data);
        return;
      }
      if (data.study_uid !== studyUid) return;
      processOverlay(data);
    };

    socket.on("overlay-available", handler);
    return () => { socket.off("overlay-available", handler); };
  }, [socket, studyUid, processOverlay]);

  const toggleLabel = useCallback((name: string) => {
    setActiveLabels((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return { overlays, activeLabels, toggleLabel, selectedLabel, setSelectedLabel };
}
