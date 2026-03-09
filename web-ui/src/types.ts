// Frontend type definitions for DICOMclaw

export interface Session {
  id: string;
  group_name: string;
  title: string | null;
  created_at: string;
  last_activity: string;
  message_count: number;
}

export interface Message {
  id?: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  plots?: string;
}

export interface ReactStep {
  type:
    | "iteration"
    | "thought"
    | "action"
    | "observation"
    | "final"
    | "plan"
    | "overlay"
    | "viewer_cmd"
    | "report"
    | "progress";
  content: string;
  timestamp: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
}

export interface SessionFile {
  id: number;
  session_id: string;
  file_name: string;
  file_type: string;
  file_path: string;
  relative_path: string;
  size: number;
  created_at: string;
  url: string;
}

// DICOM-specific types
export interface DicomStudy {
  study_uid: string;
  patient_name: string;
  patient_id: string;
  study_date: string;
  study_description: string;
  modalities: string; // JSON array
  series_count: number;
  instance_count: number;
  indexed_at: string;
}

export interface DicomSeriesInfo {
  series_uid: string;
  study_uid: string;
  modality: string;
  series_description: string;
  num_instances: number;
  slice_thickness: number;
  is_primary: number;
}

export interface AnalysisResult {
  id: number;
  study_uid: string;
  session_id: string;
  result_type: string;
  file_name: string;
  file_path: string;
  label_name: string;
  metadata: string;
  created_at: string;
}

export interface OverlayInfo {
  study_uid: string;
  path: string;
  labels: { name: string; suv_max?: number; volume_ml?: number }[];
}

export interface AppSettings {
  openrouterApiKey: string;
  openrouterModel: string;
  visionModel: string;
  chatModel: string;
}
