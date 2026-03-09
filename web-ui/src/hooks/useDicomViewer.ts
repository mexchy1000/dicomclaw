import { useRef, useState, useCallback } from "react";
import {
  RenderingEngine,
  Enums as CoreEnums,
  volumeLoader,
  setVolumesForViewports,
  cache,
  type Types as CoreTypes,
} from "@cornerstonejs/core";
import {
  ToolGroupManager,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  Enums as ToolEnums,
  type Types as ToolTypes,
} from "@cornerstonejs/tools";

const ENGINE_ID = "dclaw";
const TG_ID = "dclaw-tg";
const VOL_NEW_IMAGE = "CORNERSTONE_VOLUME_NEW_IMAGE";
const CAMERA_MODIFIED = "CORNERSTONE_CAMERA_MODIFIED";

interface SeriesInfo {
  series_uid: string;
  modality: string;
  series_description: string;
  num_instances: number;
}

export type ActiveTool = "wl" | "pan" | "zoom" | "scroll";
export type OrientationMode = "axial" | "sagittal" | "coronal";

export interface VpCanvasFns {
  worldToCanvas: (worldPos: [number, number, number]) => [number, number] | null;
  canvasToWorld: (canvasPos: [number, number]) => [number, number, number] | null;
  vpSize: { width: number; height: number };
  focalZ: number;
}

export interface UseDicomViewerReturn {
  isLoading: boolean;
  error: string | null;
  debugLog: string[];
  ctSeriesUid: string | null;
  petSeriesUid: string | null;
  petVoiRange: [number, number];
  fusionOpacity: number;
  currentSliceIndex: number;
  totalSlices: number;
  orientation: OrientationMode;
  petVolumeData: Float32Array | null;
  petVolumeDims: [number, number, number];
  petVolumeSpacing: [number, number, number];
  petVolumeOrigin: [number, number, number];
  petVolumeDirection: number[];
  currentVoxel: [number, number, number] | null;
  renderingEngineRef: React.MutableRefObject<RenderingEngine | null>;
  loadStudy: (studyUid: string, els: ViewportEls, overrideSeries?: { ctSeriesUid?: string | null; petSeriesUid?: string | null }) => Promise<void>;
  cleanup: () => void;
  setCtVoi: (lower: number, upper: number) => void;
  setPetVoi: (lower: number, upper: number) => void;
  setPetColormap: (name: string) => void;
  setFusionOpacity: (opacity: number) => void;
  resetViewports: () => void;
  activeTool: ActiveTool;
  setActiveTool: (tool: ActiveTool) => void;
  setOrientation: (mode: OrientationMode) => void;
  navigateToVoxel: (vx: number, vy: number, vz: number) => void;
  captureViewportImages: (mipCanvas?: HTMLCanvasElement | null) => string[];
  /** Per-overlay contour rects: overlayKey → vpId → rect */
  contourRects: Record<string, Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }>>;
  updateContourRectsWithNifti: (overlayKey: string, rasOrigin: [number, number, number], voxelSizes: [number, number, number], shape: [number, number, number]) => void;
  removeOverlayRects: (overlayKey: string) => void;
  /** Get world↔canvas conversion functions for a viewport */
  getVpCanvasFns: (vpId: string) => VpCanvasFns | null;
  /** Convert canvas click to world LPS coordinates */
  canvasToWorldForVp: (vpId: string, canvasX: number, canvasY: number) => [number, number, number] | null;
  /** Convert mouse clientX/clientY to world LPS using actual canvas bounds */
  clickToWorld: (vpId: string, clientX: number, clientY: number) => [number, number, number] | null;
  /** Convert PET voxel coords to world LPS */
  voxelToWorld: (vx: number, vy: number, vz: number) => [number, number, number] | null;
  /** Get SUV value at world position from PET volume */
  getSuvAtWorld: (worldPos: [number, number, number]) => number | null;
  /** Compute SUV stats within a sphere, optionally with threshold for isometabolic volume */
  getSphereStats: (center: [number, number, number], radiusMm: number, threshold?: { type: "percent" | "absolute"; value: number }) => { suvMax: number; suvMean: number; volumeMl: number; voxelCount: number } | null;
  /** Get thresholded voxel positions on a single slice for isocontour visualization */
  getSliceIsocontour: (center: [number, number, number], radiusMm: number, threshold: { type: "percent" | "absolute"; value: number }, sliceWorldZ: number) => { points: Array<[number, number, number]>; spacing: [number, number] } | null;
}

export type ViewportEls = {
  ct: HTMLDivElement | null;
  pet: HTMLDivElement | null;
  fusionCt: HTMLDivElement | null;
  fusionPet: HTMLDivElement | null;
};

function pickBest(list: SeriesInfo[]) {
  const skip = ["scout", "topogram", "dose", "report", "localizer", "mip", "screen"];
  const ct = [...list]
    .filter((s) => s.modality === "CT" && !skip.some((k) => s.series_description.toLowerCase().includes(k)))
    .sort((a, b) => {
      const sc = (s: SeriesInfo) => {
        const d = s.series_description.toLowerCase();
        return s.num_instances + (d.includes("std") || d.includes("standard") || d.includes("stnd") ? 5000 : 0) + (d.includes("cap") ? 3000 : 0) - (d.includes("lung") ? 3000 : 0);
      };
      return sc(b) - sc(a);
    });
  const pet = [...list]
    .filter((s) => (s.modality === "PT" || s.modality === "PET") && !skip.some((k) => s.series_description.toLowerCase().includes(k)))
    .sort((a, b) => {
      const sc = (s: SeriesInfo) => {
        const d = s.series_description.toLowerCase();
        return s.num_instances + (d.includes("ac") ? 10000 : 0) - (d.includes("nac") || d.includes("uncorrect") ? 20000 : 0) + (d.includes("wb") || d.includes("whole") ? 5000 : 0) + (d.includes("3d") ? 2000 : 0);
      };
      return sc(b) - sc(a);
    });
  return { ct: ct[0] || null, pet: pet[0] || null };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const TOOL_NAME_MAP: Record<ActiveTool, string> = {
  wl: WindowLevelTool.toolName,
  pan: PanTool.toolName,
  zoom: ZoomTool.toolName,
  scroll: StackScrollTool.toolName,
};

const ORIENT_MAP: Record<OrientationMode, CoreEnums.OrientationAxis> = {
  axial: CoreEnums.OrientationAxis.AXIAL,
  sagittal: CoreEnums.OrientationAxis.SAGITTAL,
  coronal: CoreEnums.OrientationAxis.CORONAL,
};

export function useDicomViewer(): UseDicomViewerReturn {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [ctSeriesUid, setCtSeriesUid] = useState<string | null>(null);
  const [petSeriesUid, setPetSeriesUid] = useState<string | null>(null);
  const [petVoiRange, setPetVoiRange] = useState<[number, number]>([0, 8]);
  const [fusionOpacity, setFusionOpacityState] = useState(0.5);
  const [activeTool, setActiveToolState] = useState<ActiveTool>("scroll");
  const [currentSliceIndex, setCurrentSliceIndex] = useState(0);
  const [totalSlices, setTotalSlices] = useState(0);
  const [orientation, setOrientationState] = useState<OrientationMode>("axial");
  const [petVolumeData, setPetVolumeData] = useState<Float32Array | null>(null);
  const [petVolumeDims, setPetVolumeDims] = useState<[number, number, number]>([0, 0, 0]);
  const [petVolumeSpacing, setPetVolumeSpacing] = useState<[number, number, number]>([1, 1, 1]);
  const [petVolumeOrigin, setPetVolumeOrigin] = useState<[number, number, number]>([0, 0, 0]);
  const [petVolumeDirection, setPetVolumeDirection] = useState<number[]>([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const [currentVoxel, setCurrentVoxel] = useState<[number, number, number] | null>(null);

  const engineRef = useRef<RenderingEngine | null>(null);
  const tgRef = useRef<ToolTypes.IToolGroup | null>(null);
  const resizeTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const syncListeners = useRef<Array<{ el: HTMLDivElement; handler: EventListener }>>([]);
  const syncingRef = useRef(false);
  const vpIdsRef = useRef<string[]>([]);
  const petVolumeIdRef = useRef("");
  const ctVolumeIdRef = useRef("");
  const mipPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const niftiSpatialRefs = useRef<Map<string, { rasOrigin: [number, number, number]; voxelSizes: [number, number, number]; shape: [number, number, number] }>>(new Map());
  const [contourRects, setContourRects] = useState<Record<string, Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }>>>({});
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Set error with auto-dismiss after timeout (default 6s). Pass 0 for persistent. */
  const showError = useCallback((msg: string, timeout = 6000) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    if (timeout > 0) {
      errorTimerRef.current = setTimeout(() => setError(null), timeout);
    }
  }, []);

  const log = (msg: string) => {
    console.log("[V]", msg);
    setDebugLog((p) => [...p.slice(-29), msg]);
  };

  const cleanup = useCallback(() => {
    resizeTimers.current.forEach(clearTimeout);
    resizeTimers.current = [];
    if (mipPollTimer.current) { clearTimeout(mipPollTimer.current); mipPollTimer.current = null; }
    for (const { el, handler } of syncListeners.current) {
      el.removeEventListener(VOL_NEW_IMAGE, handler);
      el.removeEventListener(CAMERA_MODIFIED, handler);
    }
    syncListeners.current = [];
    vpIdsRef.current = [];
    try { if (tgRef.current) ToolGroupManager.destroyToolGroup(TG_ID); } catch { /**/ }
    tgRef.current = null;
    try { engineRef.current?.destroy(); } catch { /**/ }
    engineRef.current = null;
    try { cache.purgeCache(); } catch { /**/ }
    petVolumeIdRef.current = "";
    ctVolumeIdRef.current = "";
    setContourRects({});
    setCtSeriesUid(null);
    setPetSeriesUid(null);
    setError(null);
    setDebugLog([]);
    setPetVolumeData(null);
    setPetVolumeDims([0, 0, 0]);
    setCurrentVoxel(null);
  }, []);

  const setActiveTool = useCallback((tool: ActiveTool) => {
    setActiveToolState(tool);
    const tg = tgRef.current;
    if (!tg) return;
    for (const name of Object.values(TOOL_NAME_MAP)) {
      try { tg.setToolPassive(name); } catch { /**/ }
    }
    tg.setToolActive(TOOL_NAME_MAP[tool], {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }],
    });
    if (tool !== "pan") {
      tg.setToolActive(PanTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }],
      });
    }
    if (tool !== "zoom") {
      tg.setToolActive(ZoomTool.toolName, {
        bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }],
      });
    }
    tg.setToolActive(StackScrollTool.toolName, {
      bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }],
    });
  }, []);

  /** Poll for PET volume scalar data (volume loads progressively) */
  const pollMipData = useCallback((volId: string, attempt: number) => {
    if (attempt > 30) { log("MIP: gave up after 30 attempts"); return; }
    try {
      const vol = cache.getVolume(volId) as any;
      if (!vol) {
        log(`MIP #${attempt}: not in cache`);
        mipPollTimer.current = setTimeout(() => pollMipData(volId, attempt + 1), 2000);
        return;
      }
      // Check if volume has finished loading
      const loaded = vol.loadStatus?.loaded;
      if (!loaded) {
        log(`MIP #${attempt}: loading...`);
        mipPollTimer.current = setTimeout(() => pollMipData(volId, attempt + 1), 2000);
        return;
      }
      // Use voxelManager.getCompleteScalarDataArray() — works for streaming volumes
      let scalars: ArrayLike<number> | null = null;
      try {
        scalars = vol.voxelManager?.getCompleteScalarDataArray?.();
      } catch { /**/ }
      if (!scalars) {
        // Fallback: try imageData (vtkImageData)
        try {
          scalars = vol.imageData?.getPointData?.()?.getScalars?.()?.getData?.();
        } catch { /**/ }
      }
      if (!scalars || scalars.length === 0) {
        log(`MIP #${attempt}: no data yet`);
        mipPollTimer.current = setTimeout(() => pollMipData(volId, attempt + 1), 2000);
        return;
      }
      const dims = vol.dimensions as [number, number, number];
      const sp = vol.spacing as [number, number, number];
      setPetVolumeData(new Float32Array(scalars as Float32Array));
      setPetVolumeDims(dims);
      setPetVolumeSpacing(sp);
      setTotalSlices(dims[2]);
      const dir = vol.direction as number[];
      const ori = vol.origin as number[];
      if (ori) setPetVolumeOrigin(ori as [number, number, number]);
      if (dir) setPetVolumeDirection(dir);
      log(`MIP ready: ${dims.join("x")} sp=${sp.map((v: number) => v.toFixed(2))} dir=[${dir?.slice(0,3).map((v: number) => v.toFixed(2))},...] ori=[${ori?.map((v: number) => v.toFixed(1))}]`);
    } catch (e) {
      log(`MIP #${attempt} err: ${e}`);
      mipPollTimer.current = setTimeout(() => pollMipData(volId, attempt + 1), 2000);
    }
  }, []);

  const loadStudy = useCallback(async (studyUid: string, els: ViewportEls, overrideSeries?: { ctSeriesUid?: string | null; petSeriesUid?: string | null }) => {
    cleanup();
    setIsLoading(true);

    try {
      log(`Study …${studyUid.slice(-12)}`);

      const series: SeriesInfo[] = await (await fetch(`/api/worklist/${studyUid}/series`)).json();
      const auto = pickBest(series);

      // Use override series UIDs if provided, otherwise fall back to auto-detected
      const ctUid = overrideSeries?.ctSeriesUid || auto.ct?.series_uid || null;
      const petUid = overrideSeries?.petSeriesUid || auto.pet?.series_uid || null;
      const ct = ctUid ? series.find((s) => s.series_uid === ctUid) || null : null;
      const pet = petUid ? series.find((s) => s.series_uid === petUid) || null : null;

      log(`Anatomical: ${ct?.series_description || "NONE"} (${ct?.num_instances || 0})`);
      log(`Functional: ${pet?.series_description || "NONE"} (${pet?.num_instances || 0})`);
      if (!ct && !pet) { showError("No CT/PET series found"); setIsLoading(false); return; }
      setCtSeriesUid(ct?.series_uid || null);
      setPetSeriesUid(pet?.series_uid || null);

      const getIds = async (uid: string) => (await fetch(`/api/worklist/${studyUid}/series/${uid}/imageIds`)).json() as Promise<string[]>;
      const [ctIds, petIds] = await Promise.all([ct ? getIds(ct.series_uid) : [], pet ? getIds(pet.series_uid) : []]);
      log(`IDs: CT=${ctIds.length} PET=${petIds.length}`);

      // Wait for layout
      await delay(400);
      const ctRect = els.ct?.getBoundingClientRect();
      if (ctRect && ctRect.height < 100) {
        log(`Layout wait (h=${Math.round(ctRect.height)})...`);
        await delay(600);
      }

      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;

      const hasCt = ctIds.length > 0;
      const hasPet = petIds.length > 0;

      // --- Create volumes (load starts streaming in background) ---
      const ctVolumeId = `cornerstoneStreamingImageVolume:ct-${studyUid}`;
      const petVolumeId = `cornerstoneStreamingImageVolume:pet-${studyUid}`;
      petVolumeIdRef.current = petVolumeId;
      ctVolumeIdRef.current = ctVolumeId;

      if (hasCt) {
        log("Creating CT volume...");
        const ctVol = await volumeLoader.createAndCacheVolume(ctVolumeId, { imageIds: ctIds }) as any;
        ctVol.load();
      }
      if (hasPet) {
        log("Creating PET volume...");
        const petVol = await volumeLoader.createAndCacheVolume(petVolumeId, { imageIds: petIds }) as any;
        petVol.load();
      }

      // --- Enable volume viewports ---
      const allVpIds: string[] = [];
      const enableVp = (id: string, el: HTMLDivElement | null, hasData: boolean) => {
        if (!el || !hasData) return;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) {
          log(`SKIP ${id}: too small ${Math.round(r.width)}x${Math.round(r.height)}`);
          return;
        }
        try {
          engine.enableElement({
            viewportId: id,
            element: el,
            type: CoreEnums.ViewportType.ORTHOGRAPHIC,
            defaultOptions: {
              background: [0, 0, 0] as CoreTypes.Point3,
              orientation: CoreEnums.OrientationAxis.AXIAL,
            },
          });
          allVpIds.push(id);
        } catch (e) {
          log(`WARN: enableElement ${id} failed: ${e}`);
        }
      };

      enableVp("ct-vp", els.ct, hasCt);
      enableVp("pet-vp", els.pet, hasPet);
      enableVp("fus-ct-vp", els.fusionCt, hasCt);
      enableVp("fus-pet-vp", els.fusionPet, hasPet);
      vpIdsRef.current = allVpIds;
      log(`Viewports: ${allVpIds.join(", ")}`);

      if (!allVpIds.length) { showError("No viewports enabled"); setIsLoading(false); return; }

      // --- Tools ---
      const tg = ToolGroupManager.createToolGroup(TG_ID);
      if (tg) {
        tgRef.current = tg;
        tg.addTool(WindowLevelTool.toolName);
        tg.addTool(PanTool.toolName);
        tg.addTool(ZoomTool.toolName);
        tg.addTool(StackScrollTool.toolName);
        tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Primary }] });
        tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Auxiliary }] });
        tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Secondary }] });
        tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: ToolEnums.MouseBindings.Wheel }] });
        allVpIds.forEach((id) => tg.addViewport(id, ENGINE_ID));
      }

      // --- Set volumes for viewports ---
      const ctVpIds = allVpIds.filter((id) => id === "ct-vp" || id === "fus-ct-vp");
      const petVpIds = allVpIds.filter((id) => id === "pet-vp" || id === "fus-pet-vp");

      if (hasCt && ctVpIds.length > 0) {
        try {
          await setVolumesForViewports(engine, [{ volumeId: ctVolumeId }], ctVpIds);
          for (const id of ctVpIds) {
            const vp = engine.getViewport(id) as any;
            vp.setProperties?.({ voiRange: { lower: -160, upper: 240 } });
          }
        } catch (e) {
          log(`WARN: CT viewport setup failed: ${e}`);
        }
      }
      if (hasPet && petVpIds.length > 0) {
        try {
          await setVolumesForViewports(engine, [{ volumeId: petVolumeId }], petVpIds);
          for (const id of petVpIds) {
            const vp = engine.getViewport(id) as any;
            vp.setProperties?.({ voiRange: { lower: 0, upper: 8 } });
            try { vp.setProperties?.({ colormap: { name: "2hot" } }); } catch { /**/ }
          }
        } catch (e) {
          log(`WARN: PET viewport setup failed: ${e}`);
        }
      }
      log("Volumes set on viewports");

      // Track total slices from CT
      if (hasCt) setTotalSlices(ctIds.length);

      // --- Scroll sync via volume events ---
      const onScroll = (sourceId: string) => (_evt: Event) => {
        if (syncingRef.current) return;
        syncingRef.current = true;
        try {
          const eng = engineRef.current;
          if (!eng) return;
          const srcVp = eng.getViewport(sourceId) as any;
          const idx = srcVp?.getSliceIndex?.() ?? 0;
          const total = srcVp?.getNumberOfSlices?.() ?? 0;
          if (sourceId === "ct-vp" || sourceId === "fus-ct-vp") {
            setCurrentSliceIndex(idx);
            if (total > 0) setTotalSlices(total);
          }
          // Sync focal point to other viewports
          const focalPoint = srcVp?.getCamera?.()?.focalPoint;
          if (!focalPoint) return;
          for (const id of allVpIds) {
            if (id === sourceId) continue;
            try {
              const tgtVp = eng.getViewport(id) as any;
              tgtVp.jumpToWorld?.(focalPoint);
            } catch { /**/ }
          }
          // Track voxel position for MIP crosshair
          try {
            const vol = cache.getVolume(petVolumeIdRef.current) as any;
            if (vol?.imageData?.worldToIndex) {
              const ijk = vol.imageData.worldToIndex(focalPoint);
              setCurrentVoxel([ijk[0], ijk[1], ijk[2]]);
              console.log(`[MIP-Sync] world=(${focalPoint.map((v: number) => v.toFixed(1))}) → ijk=(${ijk.map((v: number) => v.toFixed(1))})`);
            }
          } catch { /**/ }
          // Update contour rects for overlay positioning
          updateContourRects();
        } finally {
          syncingRef.current = false;
        }
      };

      // Compute image→canvas rect per viewport for contour overlay positioning.
      // The SVG viewBox "0 0 100 100" maps as:
      //   SVG (0,0) = contour (x=1,y=1) = NIfTI RAS+ (Right, Anterior) = LPS (X_min, Y_min)
      //   SVG (100,100) = contour (x=0,y=0) = NIfTI RAS+ (Left, Posterior) = LPS (X_max, Y_max)
      // So imageRect must map SVG origin → canvas position of LPS(X_min,Y_min).
      const computeVpRect = (vpId: string) => {
        const eng = engineRef.current;
        if (!eng) return null;
        const volId = ctVolumeIdRef.current || petVolumeIdRef.current;
        if (!volId) return null;
        try {
          const vp = eng.getViewport(vpId) as any;
          if (typeof vp?.worldToCanvas !== "function") return null;
          const vol = cache.getVolume(volId) as any;
          if (!vol?.origin || !vol?.spacing || !vol?.dimensions || !vol?.direction) return null;

          const o = vol.origin as number[];
          const s = vol.spacing as number[];
          const dm = vol.dimensions as number[];
          const dir = vol.direction as number[];

          // Convert volume index to world (LPS): world = origin + direction * diag(spacing) * ijk
          const i2w = (i: number, j: number, k: number): [number, number, number] => [
            o[0] + dir[0] * s[0] * i + dir[1] * s[1] * j + dir[2] * s[2] * k,
            o[1] + dir[3] * s[0] * i + dir[4] * s[1] * j + dir[5] * s[2] * k,
            o[2] + dir[6] * s[0] * i + dir[7] * s[1] * j + dir[8] * s[2] * k,
          ];

          // Compute 4 in-plane corners → find LPS bounding box
          const corners = [
            i2w(0, 0, 0),
            i2w(dm[0] - 1, 0, 0),
            i2w(0, dm[1] - 1, 0),
            i2w(dm[0] - 1, dm[1] - 1, 0),
          ];
          const lpsXs = corners.map((c) => c[0]);
          const lpsYs = corners.map((c) => c[1]);
          const lpsXMin = Math.min(...lpsXs); // most Right
          const lpsXMax = Math.max(...lpsXs); // most Left
          const lpsYMin = Math.min(...lpsYs); // most Anterior
          const lpsYMax = Math.max(...lpsYs); // most Posterior

          // Use camera focal Z for the world point's Z
          const camera = vp.getCamera?.();
          const focalZ = camera?.focalPoint?.[2] ?? corners[0][2];

          // Map the two SVG corner world points to canvas:
          // SVG (0,0) = LPS (X_min, Y_min) = most Right + Anterior
          const p0 = vp.worldToCanvas([lpsXMin, lpsYMin, focalZ]) as [number, number];
          // SVG (100,100) = LPS (X_max, Y_max) = most Left + Posterior
          const p1 = vp.worldToCanvas([lpsXMax, lpsYMax, focalZ]) as [number, number];

          if (!p0 || !p1) return null;

          console.log("[V] computeVpRect", vpId, {
            origin: [o[0].toFixed(1), o[1].toFixed(1), o[2].toFixed(1)],
            dims: dm, dir: Array.from(dir).map(d => d.toFixed(2)),
            lpsBounds: { xMin: lpsXMin.toFixed(1), xMax: lpsXMax.toFixed(1), yMin: lpsYMin.toFixed(1), yMax: lpsYMax.toFixed(1) },
            focalZ: focalZ.toFixed(1),
            p0: [p0[0].toFixed(1), p0[1].toFixed(1)],
            p1: [p1[0].toFixed(1), p1[1].toFixed(1)],
          });

          const w = p1[0] - p0[0];
          const h = p1[1] - p0[1];
          // For standard radiological axial view, w>0 and h>0.
          // If flipped, use absolute values (SVG preserveAspectRatio=none handles it).
          const rect = {
            x: w > 0 ? p0[0] : p1[0],
            y: h > 0 ? p0[1] : p1[1],
            w: Math.abs(w),
            h: Math.abs(h),
            // Track if axes are flipped so ContourOverlay can compensate
            flipX: w < 0,
            flipY: h < 0,
          };
          return rect.w > 1 && rect.h > 1 ? rect : null;
        } catch (e) {
          console.warn("[V] contourRect err:", vpId, e);
          return null;
        }
      };

      const computeRectsForSpatialRef = (
        rasOrigin: [number, number, number],
        voxelSizes: [number, number, number],
        shape: [number, number, number],
      ): Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }> => {
        const [W, H] = shape;
        const niftiCornerToLps = (i: number, j: number): [number, number] => [
          -(rasOrigin[0] + i * voxelSizes[0]),
          -(rasOrigin[1] + j * voxelSizes[1]),
        ];
        const c00 = niftiCornerToLps(0, 0);
        const c10 = niftiCornerToLps(W - 1, 0);
        const c01 = niftiCornerToLps(0, H - 1);
        const c11 = niftiCornerToLps(W - 1, H - 1);
        const lpsXMin = Math.min(c00[0], c10[0], c01[0], c11[0]);
        const lpsXMax = Math.max(c00[0], c10[0], c01[0], c11[0]);
        const lpsYMin = Math.min(c00[1], c10[1], c01[1], c11[1]);
        const lpsYMax = Math.max(c00[1], c10[1], c01[1], c11[1]);
        const eng = engineRef.current;
        if (!eng) return {};
        const result: Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }> = {};
        for (const vpId of allVpIds) {
          try {
            const vp = eng.getViewport(vpId) as any;
            if (typeof vp?.worldToCanvas !== "function") continue;
            const camera = vp.getCamera?.();
            const focalZ = camera?.focalPoint?.[2] ?? 0;
            const p0 = vp.worldToCanvas([lpsXMin, lpsYMin, focalZ]) as [number, number];
            const p1 = vp.worldToCanvas([lpsXMax, lpsYMax, focalZ]) as [number, number];
            if (!p0 || !p1) continue;
            const w = p1[0] - p0[0];
            const h = p1[1] - p0[1];
            const rect = { x: w > 0 ? p0[0] : p1[0], y: h > 0 ? p0[1] : p1[1], w: Math.abs(w), h: Math.abs(h), flipX: w < 0, flipY: h < 0 };
            if (rect.w > 1 && rect.h > 1) result[vpId] = rect;
          } catch { /**/ }
        }
        return result;
      };

      const updateContourRects = () => {
        if (niftiSpatialRefs.current.size > 0) {
          const allRects: Record<string, Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }>> = {};
          for (const [key, ref] of niftiSpatialRefs.current) {
            const rects = computeRectsForSpatialRef(ref.rasOrigin, ref.voxelSizes, ref.shape);
            if (Object.keys(rects).length > 0) allRects[key] = rects;
          }
          if (Object.keys(allRects).length > 0) setContourRects(allRects);
          return;
        }
        // Fallback: use DICOM volume bounds (keyed as "__default")
        const vpRects: Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }> = {};
        for (const id of allVpIds) {
          const r = computeVpRect(id);
          if (r) vpRects[id] = r;
        }
        if (Object.keys(vpRects).length > 0) setContourRects({ __default: vpRects });
      };

      for (const id of allVpIds) {
        try {
          const vp = engine.getViewport(id);
          const el = vp.element;
          const handler = onScroll(id) as EventListener;
          el.addEventListener(VOL_NEW_IMAGE, handler);
          syncListeners.current.push({ el, handler });
          // Track camera changes (zoom/pan) for contour overlay
          const camHandler = (() => updateContourRects()) as EventListener;
          el.addEventListener(CAMERA_MODIFIED, camHandler);
          syncListeners.current.push({ el, handler: camHandler });
        } catch { /**/ }
      }

      // Camera sync: link zoom/pan/scroll across all viewports (CT, PET, Fusion).
      // When any viewport's camera changes, propagate to all others.
      const cameraSyncSource = { current: "" };
      const syncAllCameras = (sourceId: string) => {
        if (!engineRef.current) return;
        if (cameraSyncSource.current) return; // prevent recursion
        cameraSyncSource.current = sourceId;
        try {
          const srcVp = engineRef.current.getViewport(sourceId) as any;
          const srcCam = srcVp?.getCamera?.();
          if (!srcCam) return;
          for (const id of allVpIds) {
            if (id === sourceId) continue;
            try {
              const tgt = engineRef.current!.getViewport(id) as any;
              tgt.setCamera?.(srcCam);
              tgt.render?.();
            } catch { /**/ }
          }
        } finally {
          cameraSyncSource.current = "";
        }
      };

      // Listen for camera changes on all viewports for full sync
      for (const id of allVpIds) {
        if (id === "fus-pet-vp") continue; // PET overlay is slave to fus-ct-vp
        try {
          const el = engine.getViewport(id).element;
          const camSyncHandler = (() => syncAllCameras(id)) as EventListener;
          el.addEventListener(CAMERA_MODIFIED, camSyncHandler);
          syncListeners.current.push({ el: el as HTMLDivElement, handler: camSyncHandler });
        } catch { /**/ }
      }

      log(`Sync: ${allVpIds.length} viewports`);

      // --- Initial frame: reset camera on primary CT, sync all others ---
      // This runs once at load time. Subsequent resize events use keepCamera=true
      // via the ResizeObserver in DicomViewer.tsx.
      const initialFrame = () => {
        try {
          if (!engineRef.current) return;
          engineRef.current.resize(true, false);
          const primaryId = allVpIds.includes("ct-vp") ? "ct-vp"
            : allVpIds.includes("fus-ct-vp") ? "fus-ct-vp"
            : allVpIds[0];
          try {
            const primaryVp = engineRef.current.getViewport(primaryId) as any;
            primaryVp?.resetCamera();
          } catch { /**/ }
          try {
            const primaryCam = (engineRef.current.getViewport(primaryId) as any)?.getCamera?.();
            if (primaryCam) {
              for (const id of allVpIds) {
                if (id === primaryId) continue;
                try {
                  const tgt = engineRef.current.getViewport(id) as any;
                  tgt.setCamera?.(primaryCam);
                } catch { /**/ }
              }
            }
          } catch { /**/ }
          engineRef.current.renderViewports(allVpIds);
        } catch (e) {
          console.warn("[V] initialFrame error (non-fatal):", e);
        }
      };
      initialFrame();
      resizeTimers.current = [
        setTimeout(initialFrame, 200),
        setTimeout(() => { initialFrame(); updateContourRects(); }, 600),
        setTimeout(() => { initialFrame(); updateContourRects(); }, 1500),
      ];

      // --- Start polling for MIP data ---
      if (hasPet) {
        mipPollTimer.current = setTimeout(() => pollMipData(petVolumeId, 0), 2000);
      }

      log("Done!");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(msg);
      log(`FATAL: ${msg}`);
    } finally {
      setIsLoading(false);
    }
  }, [cleanup, pollMipData]);

  // --- Orientation switching ---
  const setOrientation = useCallback((mode: OrientationMode) => {
    setOrientationState(mode);
    const eng = engineRef.current;
    if (!eng) return;
    const axis = ORIENT_MAP[mode];
    log(`Orientation → ${mode} (${axis})`);
    // Set orientation on all viewports
    for (const id of vpIdsRef.current) {
      try {
        const vp = eng.getViewport(id) as any;
        if (!vp.setOrientation) {
          log(`${id}: no setOrientation method`);
          continue;
        }
        vp.setOrientation(axis);
      } catch (e) {
        log(`${id} orient err: ${e}`);
      }
    }
    // Reset camera on primary CT viewport only, then sync to all others
    const primaryId = vpIdsRef.current.includes("ct-vp") ? "ct-vp"
      : vpIdsRef.current.includes("fus-ct-vp") ? "fus-ct-vp"
      : vpIdsRef.current[0];
    try {
      const primaryVp = eng.getViewport(primaryId) as any;
      primaryVp.resetCamera();
      const primaryCam = primaryVp.getCamera?.();
      if (primaryCam) {
        for (const id of vpIdsRef.current) {
          if (id === primaryId) continue;
          try {
            const tgt = eng.getViewport(id) as any;
            tgt.setCamera?.(primaryCam);
            tgt.render?.();
          } catch { /**/ }
        }
      }
      primaryVp.render();
    } catch (e) {
      log(`Reset err: ${e}`);
    }
    // Update total slices
    setTimeout(() => {
      try {
        const refVp = eng.getViewport(vpIdsRef.current[0]) as any;
        const n = refVp?.getNumberOfSlices?.() || 0;
        if (n > 0) {
          setTotalSlices(n);
          setCurrentSliceIndex(0);
          log(`Orient ${mode}: ${n} slices`);
        }
      } catch { /**/ }
    }, 100);
  }, []);

  // --- Navigate to 3D voxel position (from MIP click) ---
  const navigateToVoxel = useCallback((vx: number, vy: number, vz: number) => {
    const eng = engineRef.current;
    if (!eng) return;
    syncingRef.current = true;
    try {
      const vol = cache.getVolume(petVolumeIdRef.current) as any;
      if (!vol?.imageData?.indexToWorld) return;
      const worldPoint = vol.imageData.indexToWorld([vx, vy, vz]);
      for (const id of vpIdsRef.current) {
        try {
          const vp = eng.getViewport(id) as any;
          vp.jumpToWorld?.(worldPoint);
        } catch { /**/ }
      }
      setCurrentVoxel([vx, vy, vz]);
    } catch { /**/ }
    finally {
      syncingRef.current = false;
    }
    // Update slice index after navigation settles
    setTimeout(() => {
      try {
        const refVp = eng.getViewport(vpIdsRef.current[0]) as any;
        const idx = refVp?.getSliceIndex?.() ?? 0;
        const total = refVp?.getNumberOfSlices?.() ?? 0;
        setCurrentSliceIndex(idx);
        if (total > 0) setTotalSlices(total);
      } catch { /**/ }
    }, 50);
  }, []);

  const setCtVoi = useCallback((lo: number, hi: number) => {
    const eng = engineRef.current;
    if (!eng) return;
    for (const id of ["ct-vp", "fus-ct-vp"]) {
      try {
        const vp = eng.getViewport(id) as any;
        vp?.setProperties?.({ voiRange: { lower: lo, upper: hi } });
        vp?.render?.();
      } catch { /**/ }
    }
  }, []);

  const setPetVoi = useCallback((lo: number, hi: number) => {
    setPetVoiRange([lo, hi]);
    const eng = engineRef.current;
    if (!eng) return;
    for (const id of ["pet-vp", "fus-pet-vp"]) {
      try {
        const vp = eng.getViewport(id) as any;
        vp?.setProperties?.({ voiRange: { lower: lo, upper: hi } });
        vp?.render?.();
      } catch { /**/ }
    }
  }, []);

  const setPetColormap = useCallback((name: string) => {
    const eng = engineRef.current;
    if (!eng) return;
    for (const id of ["pet-vp", "fus-pet-vp"]) {
      try {
        const vp = eng.getViewport(id) as any;
        vp?.setProperties?.({ colormap: { name } });
        vp?.render?.();
      } catch { /**/ }
    }
  }, []);

  const setFusionOpacity = useCallback((opacity: number) => {
    setFusionOpacityState(opacity);
    // CSS opacity is handled in DicomViewer component
  }, []);

  const resetViewports = useCallback(() => {
    const e = engineRef.current;
    if (!e) return;
    e.resize(true, false);
    // Reset camera on primary CT viewport only, then sync to all others
    const ids = vpIdsRef.current;
    const primaryId = ids.includes("ct-vp") ? "ct-vp"
      : ids.includes("fus-ct-vp") ? "fus-ct-vp"
      : ids[0];
    try {
      const primaryVp = e.getViewport(primaryId) as any;
      primaryVp?.resetCamera();
      const cam = primaryVp?.getCamera?.();
      if (cam) {
        for (const id of ids) {
          if (id === primaryId) continue;
          try { const vp = e.getViewport(id) as any; vp?.setCamera?.(cam); vp?.render?.(); } catch { /**/ }
        }
      }
      primaryVp?.render?.();
    } catch { /**/ }
  }, []);

  /**
   * Recompute contour rects using NIfTI affine (origin + voxel sizes in RAS).
   * This is more accurate than using DICOM volume bounds because the NIfTI
   * canonical axes are known (RAS+) and the affine maps voxels directly to world.
   */
  const updateContourRectsWithNifti = useCallback((
    overlayKey: string,
    rasOrigin: [number, number, number],
    voxelSizes: [number, number, number],
    shape: [number, number, number],
  ) => {
    // Store for re-use on CAMERA_MODIFIED
    niftiSpatialRefs.current.set(overlayKey, { rasOrigin, voxelSizes, shape });

    const eng = engineRef.current;
    if (!eng) return;
    const [W, H] = shape;

    const niftiCornerToLps = (i: number, j: number): [number, number] => {
      const rasX = rasOrigin[0] + i * voxelSizes[0];
      const rasY = rasOrigin[1] + j * voxelSizes[1];
      return [-rasX, -rasY];
    };

    const c00 = niftiCornerToLps(0, 0);
    const c10 = niftiCornerToLps(W - 1, 0);
    const c01 = niftiCornerToLps(0, H - 1);
    const c11 = niftiCornerToLps(W - 1, H - 1);

    const lpsXMin = Math.min(c00[0], c10[0], c01[0], c11[0]);
    const lpsXMax = Math.max(c00[0], c10[0], c01[0], c11[0]);
    const lpsYMin = Math.min(c00[1], c10[1], c01[1], c11[1]);
    const lpsYMax = Math.max(c00[1], c10[1], c01[1], c11[1]);

    const vpRects: Record<string, { x: number; y: number; w: number; h: number; flipX?: boolean; flipY?: boolean }> = {};

    for (const vpId of vpIdsRef.current) {
      try {
        const vp = eng.getViewport(vpId) as any;
        if (typeof vp?.worldToCanvas !== "function") continue;
        const camera = vp.getCamera?.();
        const focalZ = camera?.focalPoint?.[2] ?? 0;

        const p0 = vp.worldToCanvas([lpsXMin, lpsYMin, focalZ]) as [number, number];
        const p1 = vp.worldToCanvas([lpsXMax, lpsYMax, focalZ]) as [number, number];
        if (!p0 || !p1) continue;

        const w = p1[0] - p0[0];
        const h = p1[1] - p0[1];
        const rect = {
          x: w > 0 ? p0[0] : p1[0],
          y: h > 0 ? p0[1] : p1[1],
          w: Math.abs(w),
          h: Math.abs(h),
          flipX: w < 0,
          flipY: h < 0,
        };
        if (rect.w > 1 && rect.h > 1) vpRects[vpId] = rect;
      } catch { /**/ }
    }
    if (Object.keys(vpRects).length > 0) {
      setContourRects((prev) => ({ ...prev, [overlayKey]: vpRects }));
      console.log("[V] niftiContourRect", overlayKey, Object.keys(vpRects).length, "viewports");
    }
  }, []);

  const removeOverlayRects = useCallback((overlayKey: string) => {
    niftiSpatialRefs.current.delete(overlayKey);
    setContourRects((prev) => {
      const next = { ...prev };
      delete next[overlayKey];
      return next;
    });
  }, []);

  /** Capture current viewport canvases as base64 data URLs for VLM chat. */
  const captureViewportImages = useCallback((mipCanvas?: HTMLCanvasElement | null): string[] => {
    const images: string[] = [];
    const eng = engineRef.current;

    // Capture MIP canvas if provided
    if (mipCanvas) {
      try { images.push(mipCanvas.toDataURL("image/png")); } catch { /**/ }
    }

    // Capture Cornerstone viewports
    if (eng) {
      for (const id of vpIdsRef.current) {
        try {
          const vp = eng.getViewport(id);
          const canvas = vp.getCanvas();
          if (canvas) images.push(canvas.toDataURL("image/png"));
        } catch { /**/ }
      }
    }

    return images;
  }, []);

  /** Get world↔canvas conversion for a specific viewport */
  const getVpCanvasFns = useCallback((vpId: string): VpCanvasFns | null => {
    const eng = engineRef.current;
    if (!eng) return null;
    try {
      const vp = eng.getViewport(vpId) as any;
      if (!vp || typeof vp.worldToCanvas !== "function") return null;
      const canvas = vp.getCanvas?.();
      const camera = vp.getCamera?.();
      // IMPORTANT: worldToCanvas returns CSS pixel coordinates.
      // canvas.width/height are physical pixels (scaled by DPR).
      // Use CSS dimensions for SVG viewBox so coordinates match.
      const cssRect = canvas?.getBoundingClientRect?.();
      const cssW = cssRect?.width || canvas?.clientWidth || 0;
      const cssH = cssRect?.height || canvas?.clientHeight || 0;
      return {
        worldToCanvas: (wp: [number, number, number]) => {
          try { return vp.worldToCanvas(wp) as [number, number]; } catch { return null; }
        },
        canvasToWorld: (cp: [number, number]) => {
          try { return vp.canvasToWorld(cp) as [number, number, number]; } catch { return null; }
        },
        vpSize: { width: cssW, height: cssH },
        focalZ: camera?.focalPoint?.[2] ?? 0,
      };
    } catch { return null; }
  }, []);

  /** Convert canvas pixel coords to world LPS for a viewport */
  const canvasToWorldForVp = useCallback((vpId: string, canvasX: number, canvasY: number): [number, number, number] | null => {
    const fns = getVpCanvasFns(vpId);
    if (!fns) return null;
    return fns.canvasToWorld([canvasX, canvasY]);
  }, [getVpCanvasFns]);

  /** Convert mouse clientX/clientY to world LPS using actual Cornerstone canvas bounds */
  const clickToWorld = useCallback((vpId: string, clientX: number, clientY: number): [number, number, number] | null => {
    const eng = engineRef.current;
    if (!eng) return null;
    try {
      const vp = eng.getViewport(vpId) as any;
      const canvas = vp.getCanvas?.();
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      // CSS pixel offset from canvas top-left
      const cx = clientX - rect.left;
      const cy = clientY - rect.top;
      const worldPos = vp.canvasToWorld([cx, cy]) as [number, number, number];

      // Debug: round-trip check
      if (worldPos) {
        const backToCanvas = vp.worldToCanvas(worldPos) as [number, number];
        console.log("[Marker Debug]", vpId, {
          click: { clientX, clientY },
          canvasRect: { l: rect.left.toFixed(0), t: rect.top.toFixed(0), w: rect.width.toFixed(0), h: rect.height.toFixed(0) },
          cssOffset: { cx: cx.toFixed(1), cy: cy.toFixed(1) },
          canvasPhysical: { w: canvas.width, h: canvas.height },
          canvasCSS: { w: canvas.clientWidth, h: canvas.clientHeight },
          dpr: window.devicePixelRatio,
          worldPos: worldPos.map((c: number) => c.toFixed(1)),
          roundTrip: backToCanvas ? [backToCanvas[0].toFixed(1), backToCanvas[1].toFixed(1)] : null,
        });
      }

      return worldPos;
    } catch { return null; }
  }, []);

  /** Convert PET voxel coordinates to world LPS */
  const voxelToWorld = useCallback((vx: number, vy: number, vz: number): [number, number, number] | null => {
    try {
      const vol = cache.getVolume(petVolumeIdRef.current) as any;
      if (!vol?.imageData?.indexToWorld) return null;
      const wp = vol.imageData.indexToWorld([vx, vy, vz]);
      return [wp[0], wp[1], wp[2]];
    } catch { return null; }
  }, []);

  /** Get SUV value at a world position from PET volume */
  const getSuvAtWorld = useCallback((worldPos: [number, number, number]): number | null => {
    try {
      const vol = cache.getVolume(petVolumeIdRef.current) as any;
      if (!vol?.imageData) return null;
      const ijk = vol.imageData.worldToIndex(worldPos);
      const dims = vol.dimensions as number[];
      const i = Math.round(ijk[0]), j = Math.round(ijk[1]), k = Math.round(ijk[2]);
      if (i < 0 || j < 0 || k < 0 || i >= dims[0] || j >= dims[1] || k >= dims[2]) return null;
      let scalars: ArrayLike<number> | null = null;
      try { scalars = vol.voxelManager?.getCompleteScalarDataArray?.(); } catch { /**/ }
      if (!scalars) try { scalars = vol.imageData.getPointData().getScalars().getData(); } catch { /**/ }
      if (!scalars) return null;
      return scalars[k * dims[0] * dims[1] + j * dims[0] + i] ?? null;
    } catch { return null; }
  }, []);

  /**
   * Compute SUV statistics within a sphere, optionally with threshold.
   * Without threshold: stats for all voxels in the sphere.
   * With threshold: first finds SUVmax in sphere, then only counts voxels
   * above the threshold cutoff (isometabolic volume).
   *   thresholdType "percent": cutoff = SUVmax * (thresholdValue / 100)
   *   thresholdType "absolute": cutoff = thresholdValue
   */
  const getSphereStats = useCallback((
    center: [number, number, number],
    radiusMm: number,
    threshold?: { type: "percent" | "absolute"; value: number },
  ) => {
    try {
      const vol = cache.getVolume(petVolumeIdRef.current) as any;
      if (!vol?.imageData) return null;
      const dims = vol.dimensions as [number, number, number];
      const spacing = vol.spacing as [number, number, number];
      let scalars: ArrayLike<number> | null = null;
      try { scalars = vol.voxelManager?.getCompleteScalarDataArray?.(); } catch { /**/ }
      if (!scalars) try { scalars = vol.imageData.getPointData().getScalars().getData(); } catch { /**/ }
      if (!scalars) return null;

      const cijk = vol.imageData.worldToIndex(center);
      const ci = cijk[0], cj = cijk[1], ck = cijk[2];
      const ri = Math.ceil(radiusMm / spacing[0]);
      const rj = Math.ceil(radiusMm / spacing[1]);
      const rk = Math.ceil(radiusMm / spacing[2]);

      const kMin = Math.max(0, Math.round(ck) - rk);
      const kMax = Math.min(dims[2] - 1, Math.round(ck) + rk);
      const jMin = Math.max(0, Math.round(cj) - rj);
      const jMax = Math.min(dims[1] - 1, Math.round(cj) + rj);
      const iMin = Math.max(0, Math.round(ci) - ri);
      const iMax = Math.min(dims[0] - 1, Math.round(ci) + ri);

      // Pass 1: find SUVmax within sphere (always needed)
      let sphereMax = -Infinity;
      const r2 = radiusMm * radiusMm;
      for (let k = kMin; k <= kMax; k++) {
        for (let j = jMin; j <= jMax; j++) {
          for (let i = iMin; i <= iMax; i++) {
            const dx = (i - ci) * spacing[0];
            const dy = (j - cj) * spacing[1];
            const dz = (k - ck) * spacing[2];
            if (dx * dx + dy * dy + dz * dz <= r2) {
              const val = scalars[k * dims[0] * dims[1] + j * dims[0] + i];
              if (val > sphereMax) sphereMax = val;
            }
          }
        }
      }
      if (sphereMax <= 0) return null;

      // Determine cutoff
      let cutoff = 0;
      if (threshold) {
        cutoff = threshold.type === "percent"
          ? sphereMax * (threshold.value / 100)
          : threshold.value;
      }

      // Pass 2: compute stats for voxels within sphere AND above cutoff
      let suvMax = -Infinity, suvSum = 0, count = 0;
      for (let k = kMin; k <= kMax; k++) {
        for (let j = jMin; j <= jMax; j++) {
          for (let i = iMin; i <= iMax; i++) {
            const dx = (i - ci) * spacing[0];
            const dy = (j - cj) * spacing[1];
            const dz = (k - ck) * spacing[2];
            if (dx * dx + dy * dy + dz * dz <= r2) {
              const val = scalars[k * dims[0] * dims[1] + j * dims[0] + i];
              if (val >= cutoff) {
                if (val > suvMax) suvMax = val;
                suvSum += val;
                count++;
              }
            }
          }
        }
      }

      if (count === 0) return null;
      const voxelVolMl = (spacing[0] * spacing[1] * spacing[2]) / 1000;
      return {
        suvMax,
        suvMean: suvSum / count,
        volumeMl: count * voxelVolMl,
        voxelCount: count,
      };
    } catch { return null; }
  }, []);

  /** Get thresholded voxel world positions on a specific slice (for isocontour rendering) */
  const getSliceIsocontour = useCallback((
    center: [number, number, number],
    radiusMm: number,
    threshold: { type: "percent" | "absolute"; value: number },
    sliceWorldZ: number,
  ): { points: Array<[number, number, number]>; spacing: [number, number] } | null => {
    try {
      const vol = cache.getVolume(petVolumeIdRef.current) as any;
      if (!vol?.imageData) return null;
      const dims = vol.dimensions as [number, number, number];
      const spacing = vol.spacing as [number, number, number];
      let scalars: ArrayLike<number> | null = null;
      try { scalars = vol.voxelManager?.getCompleteScalarDataArray?.(); } catch { /**/ }
      if (!scalars) try { scalars = vol.imageData.getPointData().getScalars().getData(); } catch { /**/ }
      if (!scalars) return null;

      const cijk = vol.imageData.worldToIndex(center);
      const ci = cijk[0], cj = cijk[1], ck = cijk[2];

      // Find slice index for the given world Z
      const sliceIdx = vol.imageData.worldToIndex([center[0], center[1], sliceWorldZ]);
      const sliceK = Math.round(sliceIdx[2]);
      if (sliceK < 0 || sliceK >= dims[2]) return null;

      const r2 = radiusMm * radiusMm;
      const dz = (sliceK - ck) * spacing[2];
      if (dz * dz > r2) return null; // slice doesn't intersect sphere

      const ri = Math.ceil(radiusMm / spacing[0]);
      const rj = Math.ceil(radiusMm / spacing[1]);
      const rk = Math.ceil(radiusMm / spacing[2]);

      const kMin = Math.max(0, Math.round(ck) - rk);
      const kMax = Math.min(dims[2] - 1, Math.round(ck) + rk);
      const jMin = Math.max(0, Math.round(cj) - rj);
      const jMax = Math.min(dims[1] - 1, Math.round(cj) + rj);
      const iMin = Math.max(0, Math.round(ci) - ri);
      const iMax = Math.min(dims[0] - 1, Math.round(ci) + ri);

      // Pass 1: find SUVmax in full sphere
      let sphereMax = -Infinity;
      for (let k = kMin; k <= kMax; k++) {
        for (let j = jMin; j <= jMax; j++) {
          for (let i = iMin; i <= iMax; i++) {
            const dx = (i - ci) * spacing[0];
            const dy = (j - cj) * spacing[1];
            const dzz = (k - ck) * spacing[2];
            if (dx * dx + dy * dy + dzz * dzz <= r2) {
              const val = scalars[k * dims[0] * dims[1] + j * dims[0] + i];
              if (val > sphereMax) sphereMax = val;
            }
          }
        }
      }
      if (sphereMax <= 0) return null;

      const cutoff = threshold.type === "percent"
        ? sphereMax * (threshold.value / 100)
        : threshold.value;

      // Pass 2: collect voxels on this slice within sphere AND above cutoff
      const points: Array<[number, number, number]> = [];
      const k = sliceK;
      for (let j = jMin; j <= jMax; j++) {
        for (let i = iMin; i <= iMax; i++) {
          const dx = (i - ci) * spacing[0];
          const dy = (j - cj) * spacing[1];
          if (dx * dx + dy * dy + dz * dz <= r2) {
            const val = scalars[k * dims[0] * dims[1] + j * dims[0] + i];
            if (val >= cutoff) {
              const wp = vol.imageData.indexToWorld([i, j, k]);
              points.push([wp[0], wp[1], wp[2]]);
            }
          }
        }
      }

      return points.length > 0 ? { points, spacing: [spacing[0], spacing[1]] } : null;
    } catch { return null; }
  }, []);

  return {
    isLoading, error, debugLog, ctSeriesUid, petSeriesUid,
    petVoiRange, fusionOpacity, currentSliceIndex, totalSlices,
    orientation, petVolumeData, petVolumeDims, petVolumeSpacing,
    petVolumeOrigin, petVolumeDirection,
    currentVoxel,
    renderingEngineRef: engineRef, loadStudy, cleanup,
    setCtVoi, setPetVoi, setPetColormap, setFusionOpacity, resetViewports,
    activeTool, setActiveTool, setOrientation, navigateToVoxel,
    captureViewportImages, contourRects, updateContourRectsWithNifti, removeOverlayRects,
    getVpCanvasFns, canvasToWorldForVp, clickToWorld, voxelToWorld, getSuvAtWorld, getSphereStats, getSliceIsocontour,
  };
}
