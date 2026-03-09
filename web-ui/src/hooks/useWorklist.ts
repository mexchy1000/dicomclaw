import { useState, useEffect, useCallback } from "react";
import type { Socket } from "socket.io-client";
import type { DicomStudy, DicomSeriesInfo } from "../types";

interface SeriesSelection {
  ctSeriesUid: string | null;
  petSeriesUid: string | null;
}

function pickBestSeries(seriesList: DicomSeriesInfo[]): SeriesSelection {
  const skip = ["scout", "topogram", "dose", "report", "localizer", "mip", "screen"];

  const ctCandidates = seriesList
    .filter((s) => s.modality === "CT" && !skip.some((k) => s.series_description.toLowerCase().includes(k)))
    .sort((a, b) => {
      const sc = (s: DicomSeriesInfo) => {
        const d = s.series_description.toLowerCase();
        return s.num_instances + (d.includes("std") || d.includes("standard") || d.includes("stnd") ? 5000 : 0)
          + (d.includes("cap") ? 3000 : 0) - (d.includes("lung") ? 3000 : 0);
      };
      return sc(b) - sc(a);
    });

  const petCandidates = seriesList
    .filter((s) => (s.modality === "PT" || s.modality === "PET") && !skip.some((k) => s.series_description.toLowerCase().includes(k)))
    .sort((a, b) => {
      const sc = (s: DicomSeriesInfo) => {
        const d = s.series_description.toLowerCase();
        return s.num_instances + (d.includes("ac") ? 10000 : 0) - (d.includes("nac") || d.includes("uncorrect") ? 20000 : 0)
          + (d.includes("wb") || d.includes("whole") ? 5000 : 0) + (d.includes("3d") ? 2000 : 0);
      };
      return sc(b) - sc(a);
    });

  return {
    ctSeriesUid: ctCandidates[0]?.series_uid || null,
    petSeriesUid: petCandidates[0]?.series_uid || null,
  };
}

export function useWorklist(socket: Socket | null) {
  const [studies, setStudies] = useState<DicomStudy[]>([]);
  const [selectedStudyUid, setSelectedStudyUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [seriesSelection, setSeriesSelection] = useState<Record<string, SeriesSelection>>({});

  const fetchStudies = useCallback(() => {
    setLoading(true);
    fetch("/api/worklist")
      .then((r) => r.json())
      .then((data: DicomStudy[]) => setStudies(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchStudies();
  }, [fetchStudies]);

  // Listen for index updates
  useEffect(() => {
    if (!socket) return;
    const handleIndexUpdated = () => {
      fetchStudies();
    };
    socket.on("dicom-index-updated", handleIndexUpdated);
    return () => {
      socket.off("dicom-index-updated", handleIndexUpdated);
    };
  }, [socket, fetchStudies]);

  // Auto-detect best series when a study is selected
  const selectStudy = useCallback(
    (studyUid: string) => {
      setSelectedStudyUid(studyUid);
      if (socket) {
        socket.emit("select-study", { studyUid });
      }
      // Auto-detect series if not already cached
      if (!seriesSelection[studyUid]) {
        fetch(`/api/worklist/${studyUid}/series`)
          .then((r) => r.json())
          .then((data: DicomSeriesInfo[]) => {
            const sel = pickBestSeries(data);
            setSeriesSelection((prev) => ({ ...prev, [studyUid]: sel }));
          })
          .catch(() => {});
      }
    },
    [socket, seriesSelection],
  );

  const overrideSeries = useCallback((studyUid: string, role: "ct" | "pet", seriesUid: string) => {
    setSeriesSelection((prev) => ({
      ...prev,
      [studyUid]: {
        ...prev[studyUid],
        [role === "ct" ? "ctSeriesUid" : "petSeriesUid"]: seriesUid,
      },
    }));
  }, []);

  const selectedStudy = studies.find((s) => s.study_uid === selectedStudyUid) || null;
  const selectedSeries = selectedStudyUid ? seriesSelection[selectedStudyUid] || null : null;

  return {
    studies,
    selectedStudyUid,
    selectedStudy,
    selectStudy,
    loading,
    refreshStudies: fetchStudies,
    seriesSelection,
    overrideSeries,
    selectedSeries,
  };
}
