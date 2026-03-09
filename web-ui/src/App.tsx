import { useState, useEffect, useRef, useCallback } from "react";
import { useSocket } from "./hooks/useSocket";
import { useSessions } from "./hooks/useSessions";
import { useChat } from "./hooks/useChat";
import { useReactSteps } from "./hooks/useReactSteps";
import { useSessionFiles } from "./hooks/useSessionFiles";
import { useAgentStatus } from "./hooks/useAgentStatus";
import { useWorklist } from "./hooks/useWorklist";
import { useSettings } from "./hooks/useSettings";
import { useOverlays } from "./hooks/useOverlays";
import { useBatch } from "./hooks/useBatch";
import Header from "./components/layout/Header";
import Sidebar from "./components/layout/Sidebar";
import ChatPanel from "./components/chat/ChatPanel";
import ResultsPanel from "./components/panels/ResultsPanel";
import SettingsPanel from "./components/panels/SettingsPanel";
import DicomViewer, { type DicomViewerHandle } from "./components/viewer/DicomViewer";
import ImageLightbox from "./components/common/ImageLightbox";
import BatchPanel from "./components/panels/BatchPanel";
import { useViewerMarkers } from "./hooks/useViewerMarkers";
import { initCornerstone } from "./lib/cornerstoneSetup";
import type { Skill } from "./types";
import type { ChatMode } from "./components/chat/InputArea";

type RightTab = "chat" | "results";

export default function App() {
  const { socket } = useSocket();
  const {
    sessions, currentSessionId, currentSession,
    createSession, selectSession, deleteSession, refreshSessions,
    findSessionByTitle,
  } = useSessions(socket);
  const { messages, isTyping, sendMessage, addLocalMessage } = useChat(socket, currentSessionId);
  const { steps, currentIteration, plan, isActive, approvePlan, modifyPlan, rejectPlan } =
    useReactSteps(socket, currentSessionId);
  const { files } = useSessionFiles(socket, currentSessionId);
  const { status: agentStatus, queueSize, cancelAgent } = useAgentStatus(socket);
  const { studies, selectedStudyUid, selectedStudy, selectStudy, refreshStudies, seriesSelection, overrideSeries, selectedSeries } =
    useWorklist(socket);
  const { settings, updateSettings } = useSettings();
  const { overlays, activeLabels, toggleLabel } = useOverlays(socket, selectedStudyUid, currentSessionId);
  const {
    marker, setMarker, clearMarker, markerEnabled, setMarkerEnabled: rawSetMarkerEnabled,
    userVois, addVoi, updateVoiStats, updateVoiCenter, removeVoi,
    toggleVoiVisibility,
  } = useViewerMarkers();
  // When disabling marker, also clear existing marker
  const setMarkerEnabled = useCallback((v: boolean) => {
    rawSetMarkerEnabled(v);
    if (!v) clearMarker();
  }, [rawSetMarkerEnabled, clearMarker]);
  const batch = useBatch(socket);
  const [voiToolActive, setVoiToolActive] = useState(false);

  const cornerstoneInitialized = useRef(false);
  useEffect(() => {
    if (!cornerstoneInitialized.current) {
      cornerstoneInitialized.current = true;
      initCornerstone().catch((err) => console.error("Cornerstone init failed:", err));
    }
  }, []);

  const viewerRef = useRef<DicomViewerHandle>(null);
  const [chatMode, setChatMode] = useState<ChatMode>("agent");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("chat");
  const [batchOpen, setBatchOpen] = useState(false);

  useEffect(() => {
    fetch("/api/skills").then((r) => r.json()).then(setSkills).catch(() => {});
  }, []);

  useEffect(() => {
    if (messages.length === 1) refreshSessions();
  }, [messages.length, refreshSessions]);

  // Auto-switch to results tab when files arrive
  useEffect(() => {
    if (files.length > 0) setRightTab("results");
  }, [files.length]);

  // When batch starts, switch to batch session
  useEffect(() => {
    if (batch.batchSessionId) {
      selectSession(batch.batchSessionId);
      setRightTab("chat");
      setBatchOpen(false);
    }
  }, [batch.batchSessionId, selectSession]);

  // Study selection → PTID-based session (skip session switch in batch mode)
  const handleSelectStudy = useCallback((uid: string) => {
    selectStudy(uid);

    // In batch mode, stay in the batch session — just change the viewer
    if (currentSessionId.startsWith("batch-")) return;

    // Find patient_id from studies
    const study = studies.find((s) => s.study_uid === uid);
    const ptid = study?.patient_id;

    if (ptid) {
      // Check if session already exists for this patient
      const existing = findSessionByTitle(ptid);
      if (existing) {
        selectSession(existing.id);
      } else {
        createSession(ptid);
      }
    } else {
      createSession(); // UNKNOWN counter
    }
  }, [selectStudy, studies, findSessionByTitle, selectSession, createSession, currentSessionId]);

  // Build context string for @ mentions (VOIs and Study info)
  const buildVoiContext = useCallback((text: string): string => {
    const parts: string[] = [];

    // VOI mentions — match @VOI<N> or @VOI-m<N>
    const voiRefs = text.match(/@VOI[-\w]*/gi);
    if (voiRefs) {
      for (const ref of voiRefs) {
        const raw = ref.replace(/^@/i, "");

        // Check manual VOIs first (label like VOI-m001)
        const manualVoi = userVois.find((v) => v.label.toLowerCase() === raw.toLowerCase());
        if (manualVoi) {
          const stats = manualVoi.stats
            ? ` SUVmax=${manualVoi.stats.suvMax.toFixed(2)}, SUVmean=${manualVoi.stats.suvMean.toFixed(2)}, Vol=${manualVoi.stats.volumeMl.toFixed(1)}ml`
            : "";
          parts.push(`${manualVoi.label}: center=(${manualVoi.center.map((c) => c.toFixed(1)).join(",")}), radius=${manualVoi.radiusMm.toFixed(1)}mm${stats}`);
          continue;
        }

        // Check overlay VOIs (voiIndex like VOI1, VOI2)
        const idMatch = raw.match(/^VOI(\d+)$/i);
        if (idMatch) {
          const voiIdx = parseInt(idMatch[1], 10);
          for (const ov of overlays) {
            const label = ov.labels.find((l) => l.voiIndex === voiIdx);
            if (label) {
              const meta = ov.metadata?.find((m) => m.name === label.name);
              const statStr = meta?.suv_max ? ` SUVmax=${meta.suv_max.toFixed(2)}` : "";
              const volStr = meta?.volume_ml ? `, Vol=${meta.volume_ml.toFixed(1)}ml` : "";
              parts.push(`VOI${voiIdx}: ${label.name} (mask: ${ov.segPath}, label=${label.value}${statStr}${volStr})`);
              break;
            }
          }
        }
      }
    }

    // Study mentions — @Study(...) or @study_uid=...
    const studyMentions = text.match(/@Study\([^)]+\)/gi);
    if (studyMentions) {
      for (const ref of studyMentions) {
        const inner = ref.replace(/@Study\(/i, "").replace(/\)$/, "");
        // Find matching study by patient_name or study_uid
        const matchedStudy = studies.find((s) =>
          s.patient_name === inner || s.study_uid === inner || s.patient_id === inner
        );
        if (matchedStudy) {
          parts.push(`Study: ${matchedStudy.patient_name}, ID=${matchedStudy.patient_id}, UID=${matchedStudy.study_uid}, Date=${matchedStudy.study_date}`);
        }
      }
    } else if (text.match(/@Study\b|@PatientID\b|@StudyDate\b/i) && selectedStudy) {
      parts.push(`Study: ${selectedStudy.patient_name}, ID=${selectedStudy.patient_id}, Date=${selectedStudy.study_date}, Desc=${selectedStudy.study_description}`);
    }

    return parts.length > 0 ? `\n[Context: ${parts.join("; ")}]` : "";
  }, [userVois, overlays, selectedStudy, studies]);

  // Build marker context string
  const buildMarkerContext = useCallback((): string => {
    if (!marker) return "";
    return `\n[Marker: (${marker.worldPos.map((c) => c.toFixed(1)).join(",")})]`;
  }, [marker]);

  const handleSendMessage = useCallback(async (text: string) => {
    const voiCtx = buildVoiContext(text);
    const markerCtx = buildMarkerContext();

    if (chatMode === "chat") {
      const images = viewerRef.current?.captureImages() || [];
      addLocalMessage({ role: "user", content: text, timestamp: new Date().toISOString() });

      try {
        const resp = await fetch("/api/chat-vlm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: currentSessionId,
            message: text + voiCtx + markerCtx,
            studyUid: selectedStudyUid,
            images,
          }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          console.error("VLM chat error:", data.error);
        }
      } catch (err) {
        console.error("VLM chat failed:", err);
      }
      return;
    }

    // Agent mode — only VOI context via @mentions, no marker coordinates
    let fullText = text + voiCtx;
    if (selectedStudyUid && !fullText.includes(selectedStudyUid)) {
      const studyName = selectedStudy?.patient_name || "Unknown";
      let ctx = `[Context: study_uid=${selectedStudyUid}, patient=${studyName}`;
      if (selectedSeries?.ctSeriesUid) ctx += `, ct_series=${selectedSeries.ctSeriesUid}`;
      if (selectedSeries?.petSeriesUid) ctx += `, pet_series=${selectedSeries.petSeriesUid}`;
      ctx += `]`;
      fullText = ctx + "\n" + fullText;
    }
    sendMessage(fullText);
  }, [chatMode, currentSessionId, selectedStudyUid, selectedStudy, selectedSeries, sendMessage, addLocalMessage, buildVoiContext, buildMarkerContext]);

  return (
    <div style={appStyles.root}>
      {/* Header */}
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        sessionTitle={currentSession?.title}
        agentStatus={agentStatus}
        queueSize={queueSize}
        onCancelAgent={() => cancelAgent(currentSessionId)}
        selectedStudy={selectedStudy?.patient_name}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main 3-column layout */}
      <div style={appStyles.main}>
        {/* Left: Sidebar (Studies only) */}
        {sidebarOpen && (
          <Sidebar
            studies={studies}
            selectedStudyUid={selectedStudyUid}
            onSelectStudy={handleSelectStudy}
            onRefreshStudies={refreshStudies}
            onBatchAnalyze={() => setBatchOpen(true)}
            seriesSelection={seriesSelection}
            onOverrideSeries={overrideSeries}
          />
        )}

        {/* Center: DICOM Viewer (always present, shows placeholder if no study) */}
        <div style={appStyles.center}>
          <DicomViewer
            ref={viewerRef}
            studyUid={selectedStudyUid}
            overlays={overlays}
            activeLabels={activeLabels}
            onToggleLabel={toggleLabel}
            marker={marker}
            markerEnabled={markerEnabled}
            onSetMarkerEnabled={setMarkerEnabled}
            userVois={userVois}
            onSetMarker={setMarker}
            onAddVoi={addVoi}
            onVoiClick={() => {}}
            onUpdateVoiStats={updateVoiStats}
            onUpdateVoiCenter={updateVoiCenter}
            onDeleteVoi={removeVoi}
            onToggleVoiVisibility={toggleVoiVisibility}
            voiToolActive={voiToolActive}
            onToggleVoiTool={() => setVoiToolActive((v) => !v)}
            overrideSeries={selectedSeries}
          />
        </div>

        {/* Right: Chat / Results tabbed panel */}
        <div style={appStyles.rightPanel}>
          {/* Tab bar */}
          <div style={appStyles.tabBar}>
            <button
              onClick={() => setRightTab("chat")}
              style={{ ...appStyles.tab, ...(rightTab === "chat" ? appStyles.tabActive : {}) }}
            >
              Chat
              {isTyping && <span style={appStyles.dot} />}
            </button>
            <button
              onClick={() => setRightTab("results")}
              style={{ ...appStyles.tab, ...(rightTab === "results" ? appStyles.tabActive : {}) }}
            >
              Results
              {files.length > 0 && (
                <span style={appStyles.badge}>{files.length}</span>
              )}
            </button>
          </div>

          {/* Tab content */}
          <div style={appStyles.tabContent}>
            {rightTab === "chat" ? (
              <ChatPanel
                messages={messages}
                isTyping={isTyping}
                onSendMessage={handleSendMessage}
                reactSteps={steps}
                currentIteration={currentIteration}
                isReactActive={isActive}
                plan={plan}
                onApprovePlan={approvePlan}
                onModifyPlan={modifyPlan}
                onRejectPlan={rejectPlan}
                skills={skills}
                onImageClick={setLightboxSrc}
                sessions={sessions}
                currentSessionId={currentSessionId}
                currentSessionTitle={currentSession?.title ?? null}
                onNewSession={() => createSession()}
                onSelectSession={selectSession}
                onDeleteSession={deleteSession}
                chatMode={chatMode}
                onToggleMode={() => setChatMode((m) => m === "agent" ? "chat" : "agent")}
                userVois={userVois}
                overlayVois={overlays}
                studyInfo={studies.map((s) => ({
                  label: s.patient_name || s.study_uid.slice(0, 12),
                  detail: `${s.patient_id || ""} ${s.study_date || ""}`.trim(),
                  value: `Study(${s.patient_name || s.study_uid})`,
                }))}
              />
            ) : (
              <ResultsPanel
                files={files}
                sessionId={currentSessionId}
                onClose={() => setRightTab("chat")}
                onImageClick={setLightboxSrc}
              />
            )}
          </div>
        </div>
      </div>

      {/* Batch Analysis modal */}
      {batchOpen && (
        <BatchPanel
          studies={studies}
          onClose={() => setBatchOpen(false)}
          onStartBatch={(prompt) => {
            batch.startBatch(prompt, studies.map((s) => s.study_uid));
          }}
          isRunning={batch.isRunning}
        />
      )}

      {/* Settings modal */}
      {settingsOpen && (
        <SettingsPanel settings={settings} onUpdate={updateSettings} onClose={() => setSettingsOpen(false)} />
      )}

      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
    </div>
  );
}

const appStyles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    overflow: "hidden",
    backgroundColor: "var(--bg-primary)",
  },
  main: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "#000",
  },
  rightPanel: {
    width: 380,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    borderLeft: "1px solid var(--border)",
    background: "var(--bg-primary)",
    minHeight: 0,
  },
  tabBar: {
    display: "flex",
    borderBottom: "1px solid var(--border)",
    background: "var(--bg-secondary)",
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: "6px 0",
    fontSize: 12,
    fontWeight: 600,
    background: "transparent",
    color: "var(--text-muted)",
    border: "none",
    borderBottom: "2px solid transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  tabActive: {
    color: "var(--accent, #4a9eff)",
    borderBottomColor: "var(--accent, #4a9eff)",
  },
  tabContent: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    overflow: "hidden",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--accent, #4a9eff)",
    display: "inline-block",
    animation: "pulse 1s infinite",
  },
  badge: {
    fontSize: 9,
    background: "var(--accent, #4a9eff)",
    color: "#fff",
    borderRadius: 8,
    padding: "0 5px",
    minWidth: 14,
    textAlign: "center" as const,
  },
};
