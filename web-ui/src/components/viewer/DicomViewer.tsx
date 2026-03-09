import { useRef, useEffect, useCallback, useState, useMemo, forwardRef, useImperativeHandle, type KeyboardEvent as ReactKbEvt } from "react";
import { useDicomViewer, type ActiveTool, type OrientationMode } from "../../hooks/useDicomViewer";
import MipCanvas, { type MipCanvasHandle } from "./MipCanvas";
import ContourOverlay from "./ContourOverlay";
import OverlayPanel from "./OverlayPanel";
import MarkerOverlay from "./MarkerOverlay";
import VoiThresholdMenu from "./VoiThresholdMenu";
import VoiListPanel from "./VoiListPanel";
import type { OverlayData } from "../../hooks/useOverlays";
import type { ViewerMarker, UserVoi } from "../../hooks/useViewerMarkers";

export interface DicomViewerHandle {
  captureImages: () => string[];
  /** Get current marker for chat context */
  getMarker: () => ViewerMarker | null;
  /** Get all user VOIs for chat context */
  getUserVois: () => UserVoi[];
}

interface Props {
  studyUid: string | null;
  overlays?: OverlayData[];
  activeLabels?: Set<string>;
  onToggleLabel?: (name: string) => void;
  /** Single marker from useViewerMarkers */
  marker?: ViewerMarker | null;
  markerEnabled?: boolean;
  onSetMarkerEnabled?: (v: boolean) => void;
  userVois?: UserVoi[];
  onSetMarker?: (worldPos: [number, number, number]) => void;
  onAddVoi?: (center: [number, number, number], radiusMm: number) => UserVoi;
  onVoiClick?: (voi: UserVoi) => void;
  onUpdateVoiStats?: (id: number, stats: UserVoi["stats"]) => void;
  onUpdateVoiCenter?: (id: number, center: [number, number, number]) => void;
  onDeleteVoi?: (id: number) => void;
  onToggleVoiVisibility?: (id: number) => void;
  voiToolActive?: boolean;
  onToggleVoiTool?: () => void;
  /** Override series UIDs (Anatomical=CT, Functional=PET) */
  overrideSeries?: { ctSeriesUid?: string | null; petSeriesUid?: string | null } | null;
}

const WL_PRESETS: Record<string, [number, number]> = {
  Abdomen: [-160, 240],
  Lung: [-1400, 200],
  Bone: [-450, 1050],
  Brain: [-20, 80],
};

const PET_COLORMAPS = ["2hot", "Inferno (matplotlib)", "hsv", "jet", "Black-Body Radiation"];

const TOOL_LABELS: Record<ActiveTool, string> = {
  wl: "W/L",
  pan: "Pan",
  zoom: "Zoom",
  scroll: "Scroll",
};

type CellType = "mip" | "fusion" | "pet" | "ct";

const LAYOUTS: Record<string, CellType[]> = {
  "Default": ["mip", "fusion", "pet", "ct"],
  "CT Focus": ["ct", "fusion", "mip", "pet"],
  "PET Focus": ["pet", "fusion", "mip", "ct"],
};

const ORIENT_LABELS: Record<OrientationMode, string> = {
  axial: "Axial",
  sagittal: "Sag",
  coronal: "Cor",
};

const DicomViewer = forwardRef<DicomViewerHandle, Props>(function DicomViewer({
  studyUid, overlays = [], activeLabels = new Set(), onToggleLabel,
  marker = null, markerEnabled = true, onSetMarkerEnabled,
  userVois = [],
  onSetMarker, onAddVoi, onVoiClick, onUpdateVoiStats, onUpdateVoiCenter, onDeleteVoi, onToggleVoiVisibility,
  voiToolActive = false, onToggleVoiTool,
  overrideSeries,
}, ref) {
  const ctRef = useRef<HTMLDivElement>(null);
  const petRef = useRef<HTMLDivElement>(null);
  const fusionCtRef = useRef<HTMLDivElement>(null);
  const fusionPetRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const prevStudyUid = useRef<string | null>(null);
  const mipCanvasRef = useRef<MipCanvasHandle>(null);
  // Cell refs for canvas offset calculation
  const ctCellRef = useRef<HTMLDivElement>(null);
  const petCellRef = useRef<HTMLDivElement>(null);
  const fusCellRef = useRef<HTMLDivElement>(null);

  const {
    isLoading, error, debugLog,
    renderingEngineRef, loadStudy, cleanup,
    setCtVoi, setPetVoi, setPetColormap,
    setFusionOpacity, resetViewports,
    activeTool, setActiveTool,
    petVoiRange, fusionOpacity,
    currentSliceIndex, totalSlices,
    orientation, setOrientation,
    petVolumeData, petVolumeDims, petVolumeSpacing,
    petVolumeOrigin, petVolumeDirection,
    currentVoxel, navigateToVoxel,
    captureViewportImages, contourRects, updateContourRectsWithNifti,
    getVpCanvasFns, clickToWorld, voxelToWorld, getSphereStats, getSliceIsocontour,
  } = useDicomViewer();

  // Click-vs-drag detection: record pointer start position
  const pointerStartRef = useRef<{ x: number; y: number; time: number; vpId: string } | null>(null);

  // VOI drawing state
  const [voiDragStart, setVoiDragStart] = useState<{ vpId: string; canvasX: number; canvasY: number; worldPos: [number, number, number] } | null>(null);
  const [voiDragRadius, setVoiDragRadius] = useState(0);
  const [thresholdMenuVoi, setThresholdMenuVoi] = useState<UserVoi | null>(null);
  const [thresholdMenuPos, setThresholdMenuPos] = useState({ x: 0, y: 0 });
  const [voiListOpen, setVoiListOpen] = useState(false);

  useImperativeHandle(ref, () => ({
    captureImages: () => captureViewportImages(mipCanvasRef.current?.getCanvas()),
    getMarker: () => marker,
    getUserVois: () => userVois,
  }), [captureViewportImages, marker, userVois]);

  const [activeWlPreset, setActiveWlPreset] = useState("Abdomen");
  const [activePetColormap, setActivePetColormap] = useState("2hot");
  const [editingSuvMax, setEditingSuvMax] = useState(false);
  const [suvMaxInput, setSuvMaxInput] = useState("");
  const [activeLayout, setActiveLayout] = useState("Default");
  const [mipAngle, setMipAngle] = useState(0);
  const suvInputRef = useRef<HTMLInputElement>(null);

  const prevOverrideRef = useRef<string | null>(null);

  useEffect(() => {
    if (!studyUid) return;
    const overrideKey = overrideSeries ? `${overrideSeries.ctSeriesUid || ""}|${overrideSeries.petSeriesUid || ""}` : "";
    const isNewStudy = studyUid !== prevStudyUid.current;
    const isNewOverride = overrideKey !== prevOverrideRef.current && prevOverrideRef.current !== null;
    if (!isNewStudy && !isNewOverride) return;
    prevStudyUid.current = studyUid;
    prevOverrideRef.current = overrideKey;
    const timer = setTimeout(() => {
      loadStudy(studyUid, {
        ct: ctRef.current,
        pet: petRef.current,
        fusionCt: fusionCtRef.current,
        fusionPet: fusionPetRef.current,
      }, overrideSeries || undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [studyUid, loadStudy, overrideSeries]);

  useEffect(() => () => { cleanup(); prevStudyUid.current = null; }, [cleanup]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    let timer: ReturnType<typeof setTimeout>;
    const doResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const e = renderingEngineRef.current;
        if (!e) return;
        // keepCamera=true: Cornerstone internally saves camera, resets for new
        // viewport size, then restores the saved camera. This preserves
        // zoom/pan/scroll and aspect ratio across all viewports.
        e.resize(true, true);
      }, 100);
    };
    const observer = new ResizeObserver(doResize);
    observer.observe(grid);
    window.addEventListener("resize", doResize);
    return () => { observer.disconnect(); window.removeEventListener("resize", doResize); clearTimeout(timer); };
  }, [renderingEngineRef]);

  const handleWlPreset = useCallback((preset: string) => {
    setActiveWlPreset(preset);
    const [lo, hi] = WL_PRESETS[preset];
    setCtVoi(lo, hi);
  }, [setCtVoi]);

  const handlePetColormap = useCallback((cmap: string) => {
    setActivePetColormap(cmap);
    setPetColormap(cmap);
  }, [setPetColormap]);

  const handleSuvMaxClick = useCallback(() => {
    setEditingSuvMax(true);
    setSuvMaxInput(String(petVoiRange[1]));
    setTimeout(() => suvInputRef.current?.focus(), 50);
  }, [petVoiRange]);

  const commitSuvMax = useCallback(() => {
    const val = parseFloat(suvMaxInput);
    if (!isNaN(val) && val > 0) {
      setPetVoi(0, val);
    }
    setEditingSuvMax(false);
  }, [suvMaxInput, setPetVoi]);

  const handleSuvKeyDown = useCallback((e: ReactKbEvt<HTMLInputElement>) => {
    if (e.key === "Enter") commitSuvMax();
    if (e.key === "Escape") setEditingSuvMax(false);
  }, [commitSuvMax]);

  const handleReset = useCallback(() => {
    setActiveWlPreset("Abdomen");
    setActivePetColormap("2hot");
    setCtVoi(-160, 240);
    setPetVoi(0, 8);
    setPetColormap("2hot");
    setFusionOpacity(0.5);
    setOrientation("axial");
    setActiveLayout("Default");
    setMipAngle(0);
    resetViewports();
  }, [setCtVoi, setPetVoi, setPetColormap, setFusionOpacity, setOrientation, resetViewports]);

  // For MIP overlay, merge all labels (MIP doesn't need per-overlay rects)
  const allContourLabels = useMemo(
    () => overlays.flatMap((o) => o.labels.map((l) => ({
      ...l,
      rasOrigin: o.rasOrigin,
      voxelSizes: o.voxelSizes,
      niftiDepth: o.shape[2],
    }))),
    [overlays],
  );

  // Register per-overlay spatial references for accurate contour positioning
  useEffect(() => {
    if (overlays.length === 0) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const ov of overlays) {
      if (ov.rasOrigin && ov.voxelSizes) {
        const t = setTimeout(() => updateContourRectsWithNifti(ov.segPath, ov.rasOrigin!, ov.voxelSizes!, ov.shape), 500);
        timers.push(t);
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [overlays, updateContourRectsWithNifti]);

  // ============================
  // Click-vs-drag detection
  // ============================
  // We add onPointerDown/onPointerUp to cell divs WITHOUT preventing/stopping
  // propagation, so Cornerstone tools (W/L, Pan, Zoom, Scroll) continue to work.
  // A "click" is detected post-hoc: distance < 5px and elapsed < 500ms.

  const handlePointerDown = useCallback((vpId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return; // left button only
    pointerStartRef.current = { x: e.clientX, y: e.clientY, time: Date.now(), vpId };

    // If VOI tool is active, start drag for sphere drawing
    if (voiToolActive && onAddVoi) {
      const worldPos = clickToWorld(vpId, e.clientX, e.clientY);
      if (worldPos) {
        setVoiDragStart({ vpId, canvasX: e.clientX, canvasY: e.clientY, worldPos });
        setVoiDragRadius(0);
      }
    }
  }, [voiToolActive, onAddVoi, clickToWorld]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!voiDragStart || !voiToolActive) return;
    const dx = e.clientX - voiDragStart.canvasX;
    const dy = e.clientY - voiDragStart.canvasY;
    const pxDist = Math.sqrt(dx * dx + dy * dy);
    const mmPerPx = petVolumeSpacing ? Math.min(petVolumeSpacing[0], petVolumeSpacing[1]) : 3;
    setVoiDragRadius(pxDist * mmPerPx * 0.5);
  }, [voiDragStart, voiToolActive, petVolumeSpacing]);

  const handlePointerUp = useCallback((vpId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;

    // VOI tool: finish drag
    if (voiToolActive && voiDragStart && voiDragStart.vpId === vpId && onAddVoi) {
      const radius = Math.max(voiDragRadius, 5);
      const voi = onAddVoi(voiDragStart.worldPos, radius);
      if (getSphereStats && onUpdateVoiStats) {
        const stats = getSphereStats(voiDragStart.worldPos, radius);
        if (stats) {
          onUpdateVoiStats(voi.id, {
            suvMax: stats.suvMax,
            suvMean: stats.suvMean,
            volumeMl: stats.volumeMl,
          });
        }
      }
      setVoiDragStart(null);
      setVoiDragRadius(0);
      pointerStartRef.current = null;
      return;
    }

    // Click detection for marker placement
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start || start.vpId !== vpId) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const elapsed = Date.now() - start.time;

    // Only treat as click if minimal movement and quick
    if (dist > 5 || elapsed > 500) return;

    if (!voiToolActive && markerEnabled && onSetMarker) {
      const worldPos = clickToWorld(vpId, e.clientX, e.clientY);
      if (worldPos) {
        onSetMarker(worldPos);
      }
    }
  }, [voiToolActive, voiDragStart, voiDragRadius, markerEnabled, clickToWorld, onSetMarker, onAddVoi, getSphereStats, onUpdateVoiStats]);

  // MIP click → navigate AND set marker
  const handleMipClick = useCallback((vx: number, vy: number, vz: number) => {
    navigateToVoxel(vx, vy, vz);
    if (markerEnabled && onSetMarker) {
      const worldPos = voxelToWorld(vx, vy, vz);
      if (worldPos) {
        onSetMarker(worldPos);
      }
    }
  }, [navigateToVoxel, markerEnabled, onSetMarker, voxelToWorld]);

  // Handle VOI click → refresh base stats (preserving threshold) then show menu
  const handleVoiThreshClick = useCallback((voi: UserVoi) => {
    if (getSphereStats && onUpdateVoiStats) {
      // If VOI already has threshold settings, recompute WITH those settings
      const threshold = voi.stats?.thresholdType
        ? { type: voi.stats.thresholdType, value: voi.stats.thresholdValue! }
        : undefined;
      const stats = getSphereStats(voi.center, voi.radiusMm, threshold);
      if (stats) {
        const updated = {
          suvMax: stats.suvMax,
          suvMean: stats.suvMean,
          volumeMl: stats.volumeMl,
          thresholdType: voi.stats?.thresholdType,
          thresholdValue: voi.stats?.thresholdValue,
        };
        onUpdateVoiStats(voi.id, updated);
        // Pass updated voi to menu so it shows fresh stats
        setThresholdMenuVoi({ ...voi, stats: updated as any });
        setThresholdMenuPos({ x: 100, y: 100 });
        onVoiClick?.(voi);
        return;
      }
    }
    setThresholdMenuVoi(voi);
    setThresholdMenuPos({ x: 100, y: 100 });
    onVoiClick?.(voi);
  }, [getSphereStats, onUpdateVoiStats, onVoiClick]);

  const handleApplyThreshold = useCallback((voiId: number, type: "percent" | "absolute", value: number) => {
    const voi = userVois.find((v) => v.id === voiId);
    if (!voi || !getSphereStats || !onUpdateVoiStats) return;
    // Compute thresholded stats (isometabolic volume)
    const threshStats = getSphereStats(voi.center, voi.radiusMm, { type, value });
    if (!threshStats) return;
    const updated = {
      suvMax: threshStats.suvMax,
      suvMean: threshStats.suvMean,
      volumeMl: threshStats.volumeMl,
      thresholdType: type,
      thresholdValue: value,
    };
    onUpdateVoiStats(voiId, updated);
    // Update menu VOI so it reflects the new stats immediately
    setThresholdMenuVoi((prev) => prev && prev.id === voiId ? { ...voi, stats: updated as any } : prev);
    console.log(`[VOI Threshold] id=${voiId} type=${type} value=${value} → SUVmax=${threshStats.suvMax.toFixed(2)} vol=${threshStats.volumeMl.toFixed(2)}ml (${threshStats.voxelCount} voxels)`);
  }, [userVois, getSphereStats, onUpdateVoiStats]);

  // Handle VOI drag end → move VOI center and recompute stats
  const handleVoiDragEnd = useCallback((voiId: number, newCenter: [number, number, number]) => {
    if (!onUpdateVoiCenter) return;
    onUpdateVoiCenter(voiId, newCenter);
    // Recompute stats at new position
    if (getSphereStats && onUpdateVoiStats) {
      const voi = userVois.find((v) => v.id === voiId);
      if (voi) {
        const threshold = voi.stats?.thresholdType
          ? { type: voi.stats.thresholdType, value: voi.stats.thresholdValue! }
          : undefined;
        const stats = getSphereStats(newCenter, voi.radiusMm, threshold);
        if (stats) {
          onUpdateVoiStats(voiId, {
            suvMax: stats.suvMax,
            suvMean: stats.suvMean,
            volumeMl: stats.volumeMl,
            thresholdType: voi.stats?.thresholdType,
            thresholdValue: voi.stats?.thresholdValue,
          });
        }
      }
    }
  }, [onUpdateVoiCenter, getSphereStats, onUpdateVoiStats, userVois]);

  const layout = LAYOUTS[activeLayout] || LAYOUTS["Default"];

  // Only show visible VOIs on the overlay
  const visibleVois = useMemo(() => userVois.filter((v) => v.visible), [userVois]);

  // Compute canvas-to-cell offset for accurate marker positioning.
  // The SVG overlay fills the cell, but worldToCanvas returns coordinates
  // relative to the Cornerstone canvas. We need the offset from canvas to cell.
  const getCanvasOffset = useCallback((vpId: string, cellRef: React.RefObject<HTMLDivElement | null>): { x: number; y: number } => {
    try {
      const eng = renderingEngineRef.current;
      if (!eng || !cellRef.current) return { x: 0, y: 0 };
      const vp = eng.getViewport(vpId) as any;
      const canvas = vp?.getCanvas?.();
      if (!canvas) return { x: 0, y: 0 };
      const cellRect = cellRef.current.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      return {
        x: canvasRect.left - cellRect.left,
        y: canvasRect.top - cellRect.top,
      };
    } catch { return { x: 0, y: 0 }; }
  }, [renderingEngineRef]);

  // Marker/VOI overlay for a viewport
  const renderMarkerOverlay = (vpId: string, cellRef: React.RefObject<HTMLDivElement | null>) => {
    const fns = getVpCanvasFns(vpId);
    if (!fns) return null;
    const offset = getCanvasOffset(vpId, cellRef);
    return (
      <MarkerOverlay
        marker={marker}
        userVois={visibleVois}
        worldToCanvas={fns.worldToCanvas}
        canvasToWorld={fns.canvasToWorld}
        vpSize={fns.vpSize}
        focalZ={fns.focalZ}
        sliceThickness={petVolumeSpacing?.[2] || 5}
        vpId={vpId}
        canvasOffset={offset}
        getSliceIsocontour={getSliceIsocontour}
        onVoiClick={handleVoiThreshClick ? (id) => {
          const voi = userVois.find((v) => v.id === id);
          if (voi) handleVoiThreshClick(voi);
        } : undefined}
        onVoiDragEnd={handleVoiDragEnd}
      />
    );
  };

  // Cell event props: pointerDown/Up for click detection, doesn't block Cornerstone
  const cellEvents = (vpId: string) => ({
    onPointerDown: (e: React.PointerEvent) => handlePointerDown(vpId, e),
    onPointerMove: handlePointerMove,
    onPointerUp: (e: React.PointerEvent) => handlePointerUp(vpId, e),
  });

  // VOI drag visual feedback: compute circle position and radius in CSS pixels
  const voiDragCircle = useMemo(() => {
    if (!voiDragStart || voiDragRadius < 2) return null;
    return { center: voiDragStart.worldPos, radiusMm: voiDragRadius };
  }, [voiDragStart, voiDragRadius]);

  // Render per-overlay contour overlays for a viewport
  const renderContourOverlays = (vpId: string) => {
    if (orientation !== "axial" || overlays.length === 0) return null;
    return overlays.map((ov) => {
      if (!ov.labels.some((l) => activeLabels.has(l.name))) return null;
      // Use per-overlay rects, falling back to __default
      const rectMap = contourRects[ov.segPath] || contourRects.__default;
      const imageRect = rectMap?.[vpId];
      return (
        <ContourOverlay
          key={ov.segPath}
          labels={ov.labels}
          activeLabels={activeLabels}
          sliceIndex={currentSliceIndex}
          totalSlices={totalSlices}
          niftiDepth={ov.shape[2]}
          orientation={orientation}
          imageRect={imageRect}
        />
      );
    });
  };

  const renderCell = (type: CellType, idx: number) => {
    const showContours = orientation === "axial" && allContourLabels.length > 0;
    const cursorStyle = voiToolActive ? "crosshair" : undefined;

    if (type === "mip") {
      return (
        <div key={`cell-${idx}`} style={styles.cell}>
          <span style={styles.label}>MIP (PET)</span>
          <MipCanvas
            ref={mipCanvasRef}
            petData={petVolumeData}
            dims={petVolumeDims}
            spacing={petVolumeSpacing}
            voiRange={petVoiRange}
            currentVoxel={currentVoxel}
            onMipClick={handleMipClick}
            angle={mipAngle}
            onAngleChange={setMipAngle}
            overlayLabels={allContourLabels}
            activeLabels={activeLabels}
            petVolumeOrigin={petVolumeOrigin}
            petVolumeDirection={petVolumeDirection}
          />
        </div>
      );
    }

    if (type === "pet") {
      return (
        <div key={`cell-${idx}`} ref={petCellRef}
          style={{ ...styles.cell, cursor: cursorStyle }} {...cellEvents("pet-vp")}>
          <span style={styles.label}>PET (SUV)</span>
          <div ref={petRef} style={styles.vp} />
          {showContours && renderContourOverlays("pet-vp")}
          {renderMarkerOverlay("pet-vp", petCellRef)}
          {/* VOI drag feedback */}
          {voiDragCircle && voiDragStart?.vpId === "pet-vp" && (
            <VoiDragFeedback vpId="pet-vp" center={voiDragCircle.center}
              radiusMm={voiDragCircle.radiusMm} getVpCanvasFns={getVpCanvasFns}
              canvasOffset={getCanvasOffset("pet-vp", petCellRef)} />
          )}
          <div style={{ ...styles.colorbar, pointerEvents: "auto", cursor: "pointer" }}
            onClick={handleSuvMaxClick} title="Click to set SUV max">
            <div style={styles.cbGrad} />
            <div style={styles.cbLabels}>
              {editingSuvMax ? (
                <input ref={suvInputRef}
                  value={suvMaxInput}
                  onChange={(e) => setSuvMaxInput(e.target.value)}
                  onKeyDown={handleSuvKeyDown}
                  onBlur={commitSuvMax}
                  onClick={(e) => e.stopPropagation()}
                  style={styles.suvInput}
                />
              ) : (
                <span style={{ fontWeight: 700 }}>{petVoiRange[1]}</span>
              )}
              <span>{((petVoiRange[0] + petVoiRange[1]) / 2).toFixed(1)}</span>
              <span>{petVoiRange[0]}</span>
            </div>
          </div>
        </div>
      );
    }

    if (type === "fusion") {
      return (
        <div key={`cell-${idx}`} ref={fusCellRef}
          style={{ ...styles.cell, cursor: cursorStyle }} {...cellEvents("fus-ct-vp")}>
          <span style={styles.label}>Fusion ({Math.round(fusionOpacity * 100)}%)</span>
          <div ref={fusionCtRef} style={{
            ...styles.vp,
            opacity: 1 - fusionOpacity * 0.8,
          }} />
          <div ref={fusionPetRef} style={{
            ...styles.vpOverlay,
            opacity: fusionOpacity,
          }} />
          {showContours && renderContourOverlays("fus-ct-vp")}
          {renderMarkerOverlay("fus-ct-vp", fusCellRef)}
          {/* VOI drag feedback */}
          {voiDragCircle && voiDragStart?.vpId === "fus-ct-vp" && (
            <VoiDragFeedback vpId="fus-ct-vp" center={voiDragCircle.center}
              radiusMm={voiDragCircle.radiusMm} getVpCanvasFns={getVpCanvasFns}
              canvasOffset={getCanvasOffset("fus-ct-vp", fusCellRef)} />
          )}
        </div>
      );
    }

    // CT
    return (
      <div key={`cell-${idx}`} ref={ctCellRef}
        style={{ ...styles.cell, cursor: cursorStyle }} {...cellEvents("ct-vp")}>
        <span style={styles.label}>CT</span>
        <div ref={ctRef} style={styles.vp} />
        {showContours && renderContourOverlays("ct-vp")}
        {renderMarkerOverlay("ct-vp", ctCellRef)}
      </div>
    );
  };

  if (!studyUid) {
    return <div style={styles.emptyContainer}>Select a study from the worklist</div>;
  }

  return (
    <div style={styles.wrapper}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolGroup}>
          <span style={styles.tl}>Mouse:</span>
          {(Object.keys(TOOL_LABELS) as ActiveTool[]).map((t) => (
            <button key={t} onClick={() => setActiveTool(t)}
              style={{ ...styles.btn, ...(activeTool === t ? styles.btnOn : {}) }}>
              {TOOL_LABELS[t]}
            </button>
          ))}
        </div>
        <div style={styles.sep} />
        <div style={styles.toolGroup}>
          <span style={styles.tl}>W/L:</span>
          {Object.keys(WL_PRESETS).map((p) => (
            <button key={p} onClick={() => handleWlPreset(p)}
              style={{ ...styles.btn, ...(activeWlPreset === p ? styles.btnOn : {}) }}>
              {p}
            </button>
          ))}
        </div>
        <div style={styles.sep} />
        <div style={styles.toolGroup}>
          <span style={styles.tl}>PET:</span>
          {PET_COLORMAPS.map((c) => (
            <button key={c} onClick={() => handlePetColormap(c)}
              style={{ ...styles.btn, ...(activePetColormap === c ? styles.btnOn : {}) }}>
              {c.replace(" (matplotlib)", "")}
            </button>
          ))}
        </div>
        <div style={styles.sep} />
        <div style={styles.toolGroup}>
          <span style={styles.tl}>Fusion:</span>
          <input type="range" min={0} max={100} value={Math.round(fusionOpacity * 100)}
            onChange={(e) => setFusionOpacity(parseInt(e.target.value) / 100)}
            style={{ width: 50, height: 12, accentColor: "#4a9eff" }} />
          <span style={{ fontSize: 8, color: "#888" }}>{Math.round(fusionOpacity * 100)}%</span>
        </div>
        <div style={styles.sep} />
        <div style={styles.toolGroup}>
          <span style={styles.tl}>Orient:</span>
          {(Object.keys(ORIENT_LABELS) as OrientationMode[]).map((o) => (
            <button key={o} onClick={() => setOrientation(o)}
              style={{ ...styles.btn, ...(orientation === o ? styles.btnOn : {}) }}>
              {ORIENT_LABELS[o]}
            </button>
          ))}
        </div>
        <div style={styles.sep} />
        <div style={styles.toolGroup}>
          <span style={styles.tl}>Layout:</span>
          <select
            value={activeLayout}
            onChange={(e) => setActiveLayout(e.target.value)}
            style={styles.selectBtn}
          >
            {Object.keys(LAYOUTS).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
        <div style={styles.sep} />
        <div style={styles.toolGroup}>
          {/* Marker toggle */}
          {onSetMarkerEnabled && (
            <button
              onClick={() => onSetMarkerEnabled(!markerEnabled)}
              style={{ ...styles.btn, ...(markerEnabled ? { background: "#ffd43b", color: "#000", borderColor: "#ffd43b" } : {}) }}
              title={markerEnabled ? "Marker ON (click to disable)" : "Marker OFF (click to enable)"}
            >
              Mkr
            </button>
          )}
          {/* VOI tool */}
          {onToggleVoiTool && (
            <button onClick={onToggleVoiTool}
              style={{ ...styles.btn, ...(voiToolActive ? { background: "#f06595", color: "#fff", borderColor: "#f06595" } : {}) }}>
              VOI
            </button>
          )}
          {/* VOI list */}
          <button
            onClick={() => setVoiListOpen(!voiListOpen)}
            style={{ ...styles.btn, ...(voiListOpen ? styles.btnOn : {}) }}
            title="VOI List"
          >
            List
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button onClick={handleReset} style={styles.btn}>Reset</button>
        {isLoading && <span style={{ fontSize: 10, color: "#4a9eff" }}>Loading...</span>}
      </div>

      {error && <div style={styles.errorBanner}>{error}</div>}

      {/* 2x2 Grid — wrapped to maintain 1:1 aspect ratio per cell */}
      <div style={styles.gridOuter}>
        <div ref={gridRef} style={styles.grid}>
          {layout.map((type, idx) => renderCell(type, idx))}
        </div>
      </div>

      {overlays.length > 0 && onToggleLabel && (
        <OverlayPanel
          overlays={overlays}
          activeLabels={activeLabels}
          onToggle={onToggleLabel}
        />
      )}

      {/* VOI list panel */}
      {voiListOpen && onDeleteVoi && onToggleVoiVisibility && (
        <VoiListPanel
          userVois={userVois}
          onToggleVoiVisibility={onToggleVoiVisibility}
          onDeleteVoi={onDeleteVoi}
          onVoiClick={handleVoiThreshClick}
          overlays={overlays}
          activeLabels={activeLabels}
          onToggleLabel={onToggleLabel}
          onClose={() => setVoiListOpen(false)}
        />
      )}

      {/* VOI threshold menu popup */}
      {thresholdMenuVoi && onDeleteVoi && (
        <VoiThresholdMenu
          voi={thresholdMenuVoi}
          position={thresholdMenuPos}
          onApplyThreshold={handleApplyThreshold}
          onDelete={(id) => { onDeleteVoi(id); setThresholdMenuVoi(null); }}
          onClose={() => setThresholdMenuVoi(null)}
        />
      )}

      {/* VOI mode active indicator */}
      {voiToolActive && (
        <div style={{
          position: "absolute", top: 30, left: "50%", transform: "translateX(-50%)",
          background: "rgba(240, 101, 149, 0.9)", color: "#fff",
          padding: "3px 12px", borderRadius: 12, fontSize: 11, fontWeight: 700,
          zIndex: 30, pointerEvents: "none",
          animation: "pulse 2s infinite",
        }}>
          VOI Drawing Mode — Drag on PET/Fusion to draw sphere
        </div>
      )}

      <div style={styles.hint}>
        Left: {TOOL_LABELS[activeTool]} | Middle: Pan | Right: Zoom | Wheel: Scroll
        {markerEnabled && " | Click: marker"}
        {voiToolActive && " | VOI: drag to draw sphere"}
        {marker && ` | Pos: (${marker.worldPos.map((c) => c.toFixed(0)).join(",")})`}
        {userVois.length > 0 && ` | VOIs: ${userVois.length}`}
        {debugLog.length > 0 && ` | ${debugLog[debugLog.length - 1]}`}
      </div>
    </div>
  );
});

/** Visual feedback while dragging to create a VOI sphere */
function VoiDragFeedback({ vpId, center, radiusMm, getVpCanvasFns, canvasOffset }: {
  vpId: string;
  center: [number, number, number];
  radiusMm: number;
  getVpCanvasFns: (id: string) => import("../../hooks/useDicomViewer").VpCanvasFns | null;
  canvasOffset: { x: number; y: number };
}) {
  const fns = getVpCanvasFns(vpId);
  if (!fns) return null;
  const cp = fns.worldToCanvas(center);
  if (!cp) return null;
  const cx = cp[0] + canvasOffset.x;
  const cy = cp[1] + canvasOffset.y;
  // Project radius
  const edgeP = fns.worldToCanvas([center[0] + radiusMm, center[1], center[2]]);
  let rpx = 20;
  if (edgeP) {
    rpx = Math.max(5, Math.sqrt((edgeP[0] + canvasOffset.x - cx) ** 2 + (edgeP[1] + canvasOffset.y - cy) ** 2));
  }
  return (
    <div style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 6, overflow: "hidden" }}>
      <div style={{
        position: "absolute",
        left: cx - rpx,
        top: cy - rpx,
        width: rpx * 2,
        height: rpx * 2,
        borderRadius: "50%",
        border: "2px dashed #f06595",
        background: "rgba(240,101,149,0.15)",
      }} />
      <div style={{
        position: "absolute",
        left: cx,
        top: cy - rpx - 18,
        transform: "translateX(-50%)",
        color: "#f06595",
        fontSize: 10,
        fontWeight: 700,
        textShadow: "0 0 3px #000",
        whiteSpace: "nowrap",
      }}>
        {radiusMm.toFixed(0)}mm
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { flex: 1, display: "flex", flexDirection: "column", background: "#000", minHeight: 0, position: "relative" },
  emptyContainer: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "#1a1a1a", color: "#888", fontSize: 13 },
  toolbar: { display: "flex", alignItems: "center", gap: 4, padding: "2px 6px", background: "#111", borderBottom: "1px solid #333", flexWrap: "wrap" as const, minHeight: 26 },
  toolGroup: { display: "flex", alignItems: "center", gap: 2 },
  tl: { fontSize: 9, color: "#888", marginRight: 2, fontWeight: 600 },
  sep: { width: 1, height: 14, background: "#444" },
  btn: { padding: "1px 4px", fontSize: 9, background: "#222", color: "#ccc", border: "1px solid #444", borderRadius: 3, cursor: "pointer" },
  btnOn: { background: "#4a9eff", color: "#fff", borderColor: "#4a9eff" },
  selectBtn: { padding: "1px 4px", fontSize: 9, background: "#222", color: "#ccc", border: "1px solid #444", borderRadius: 3, cursor: "pointer", outline: "none" },
  errorBanner: { padding: "3px 8px", fontSize: 11, background: "#331111", color: "#f66", borderBottom: "1px solid #552222" },
  gridOuter: {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
    background: "#000", minHeight: 0, overflow: "hidden",
  },
  grid: {
    display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 1,
    // aspect-ratio: 1 makes the grid square. It will size based on the
    // constrained dimension (height if container is wide, width if tall).
    aspectRatio: "1", height: "100%", maxWidth: "100%",
  },
  cell: { position: "relative", background: "#000", overflow: "hidden", minHeight: 0 },
  label: { position: "absolute", top: 3, left: 5, fontSize: 10, color: "#4a9eff", fontWeight: 600, zIndex: 3, pointerEvents: "none", textShadow: "0 0 4px #000" },
  vp: { width: "100%", height: "100%" },
  vpOverlay: {
    position: "absolute", top: 0, left: 0, width: "100%", height: "100%",
    mixBlendMode: "screen",
    pointerEvents: "none",
  },
  colorbar: { position: "absolute", top: 16, right: 6, width: 18, height: "60%", display: "flex", gap: 2, zIndex: 3, pointerEvents: "none" },
  cbGrad: { width: 8, flex: 1, borderRadius: 2, background: "linear-gradient(to bottom, #fff, #ff0, #f80, #f00, #800, #000)", border: "1px solid rgba(255,255,255,0.3)" },
  cbLabels: { display: "flex", flexDirection: "column", justifyContent: "space-between", fontSize: 8, color: "#ccc", textShadow: "0 0 3px #000" },
  suvInput: { width: 28, fontSize: 9, padding: "1px 2px", background: "#222", color: "#fff", border: "1px solid #4a9eff", borderRadius: 2, textAlign: "center" as const, outline: "none" },
  hint: { padding: "2px 8px", fontSize: 9, color: "#555", background: "#0a0a0a", borderTop: "1px solid #222", textAlign: "center" as const },
};

export default DicomViewer;
