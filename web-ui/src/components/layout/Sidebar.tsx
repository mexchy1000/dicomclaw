import { useState, useEffect } from "react";
import type { DicomStudy, DicomSeriesInfo } from "../../types";

interface Props {
  studies: DicomStudy[];
  selectedStudyUid: string | null;
  onSelectStudy: (uid: string) => void;
  onRefreshStudies: () => void;
  onBatchAnalyze?: () => void;
  /** Cached series selection per study (Anatomical=CT, Functional=PET/SPECT) */
  seriesSelection?: Record<string, { ctSeriesUid: string | null; petSeriesUid: string | null }>;
  onOverrideSeries?: (studyUid: string, role: "ct" | "pet", seriesUid: string) => void;
}

export default function Sidebar({
  studies,
  selectedStudyUid,
  onSelectStudy,
  onRefreshStudies,
  onBatchAnalyze,
  seriesSelection,
  onOverrideSeries,
}: Props) {
  const [expandedStudy, setExpandedStudy] = useState<string | null>(null);
  const [seriesMap, setSeriesMap] = useState<Record<string, DicomSeriesInfo[]>>({});

  // Fetch series list when a study is expanded
  useEffect(() => {
    if (!expandedStudy || seriesMap[expandedStudy]) return;
    fetch(`/api/worklist/${expandedStudy}/series`)
      .then((r) => r.json())
      .then((data: DicomSeriesInfo[]) => {
        setSeriesMap((prev) => ({ ...prev, [expandedStudy]: data }));
      })
      .catch(() => {});
  }, [expandedStudy, seriesMap]);

  const toggleExpand = (uid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setExpandedStudy((prev) => (prev === uid ? null : uid));
  };

  return (
    <aside
      style={{
        width: "var(--sidebar-width)",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-secondary)",
        borderRight: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
          Studies
        </span>
        <button
          onClick={onRefreshStudies}
          style={{ fontSize: 11, color: "var(--accent)", padding: "2px 6px" }}
        >
          Refresh
        </button>
      </div>

      {/* Study list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-muted)" }}>
          {studies.length} studies
        </div>
        {studies.map((study) => {
          const mods = (() => {
            try { return JSON.parse(study.modalities).join(", "); }
            catch { return study.modalities; }
          })();
          const isSelected = study.study_uid === selectedStudyUid;
          const isExpanded = expandedStudy === study.study_uid;
          const seriesList = seriesMap[study.study_uid];
          const sel = seriesSelection?.[study.study_uid];

          return (
            <div key={study.study_uid}>
              <div
                onClick={() => onSelectStudy(study.study_uid)}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  background: isSelected ? "var(--accent-dim)" : "transparent",
                  borderLeft: isSelected ? "3px solid var(--accent)" : "3px solid transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>
                      {study.patient_name || "Unknown"}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {study.study_date || "No date"} &middot; {mods} &middot; {study.instance_count} imgs
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {study.study_description || study.study_uid.slice(0, 30)}
                    </div>
                  </div>
                  {/* Expand button */}
                  <button
                    onClick={(e) => toggleExpand(study.study_uid, e)}
                    title="Show series"
                    style={{
                      width: 20,
                      height: 20,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10,
                      color: "var(--text-muted)",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      flexShrink: 0,
                      transform: isExpanded ? "rotate(90deg)" : "none",
                      transition: "transform 0.15s",
                    }}
                  >
                    &#x25B6;
                  </button>
                </div>

                {/* Auto-detected series badges */}
                {sel && (
                  <div style={{ display: "flex", gap: 4, marginTop: 3 }}>
                    {sel.ctSeriesUid && (
                      <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "rgba(74,158,255,0.15)", color: "#4a9eff" }}>
                        Anatomical
                      </span>
                    )}
                    {sel.petSeriesUid && (
                      <span style={{ fontSize: 9, padding: "1px 4px", borderRadius: 3, background: "rgba(255,180,50,0.15)", color: "#ffb432" }}>
                        Functional
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Expanded series list */}
              {isExpanded && (
                <div style={{ background: "var(--bg-tertiary)", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
                  {!seriesList ? (
                    <div style={{ padding: "6px 16px", fontSize: 11, color: "var(--text-muted)" }}>Loading...</div>
                  ) : seriesList.length === 0 ? (
                    <div style={{ padding: "6px 16px", fontSize: 11, color: "var(--text-muted)" }}>No series</div>
                  ) : (
                    seriesList.map((s) => {
                      const isCt = sel?.ctSeriesUid === s.series_uid;
                      const isPet = sel?.petSeriesUid === s.series_uid;
                      return (
                        <div
                          key={s.series_uid}
                          style={{
                            padding: "4px 16px",
                            fontSize: 11,
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            borderLeft: isCt ? "2px solid #4a9eff" : isPet ? "2px solid #ffb432" : "2px solid transparent",
                          }}
                        >
                          <span style={{
                            fontSize: 10,
                            fontWeight: 600,
                            color: s.modality === "PT" || s.modality === "PET" ? "#ffb432" : s.modality === "CT" ? "#4a9eff" : "var(--text-muted)",
                            width: 20,
                            flexShrink: 0,
                          }}>
                            {s.modality}
                          </span>
                          <span style={{
                            flex: 1,
                            color: "var(--text-primary)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}>
                            {s.series_description || "Unknown"}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)", flexShrink: 0 }}>
                            {s.num_instances}
                          </span>
                          {/* Override buttons — any series can be assigned as Anatomical or Functional */}
                          {onOverrideSeries && (
                            <>
                              <button
                                onClick={(e) => { e.stopPropagation(); onOverrideSeries(study.study_uid, "ct", s.series_uid); }}
                                title="Use as Anatomical"
                                style={{
                                  fontSize: 8, padding: "1px 3px", borderRadius: 2,
                                  background: isCt ? "#4a9eff" : "rgba(74,158,255,0.1)",
                                  color: isCt ? "#fff" : "#4a9eff",
                                  border: "none", cursor: "pointer", flexShrink: 0,
                                  opacity: isCt ? 1 : 0.6,
                                }}
                              >
                                A
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); onOverrideSeries(study.study_uid, "pet", s.series_uid); }}
                                title="Use as Functional"
                                style={{
                                  fontSize: 8, padding: "1px 3px", borderRadius: 2,
                                  background: isPet ? "#ffb432" : "rgba(255,180,50,0.1)",
                                  color: isPet ? "#fff" : "#ffb432",
                                  border: "none", cursor: "pointer", flexShrink: 0,
                                  opacity: isPet ? 1 : 0.6,
                                }}
                              >
                                F
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Batch Analyze button */}
      {onBatchAnalyze && (
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--border)" }}>
          <button
            onClick={onBatchAnalyze}
            style={{
              width: "100%",
              padding: "8px",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              border: "none",
            }}
          >
            Batch Analyze
          </button>
        </div>
      )}
    </aside>
  );
}
