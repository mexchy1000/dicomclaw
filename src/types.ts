// Core types for DICOMclaw

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

export interface AppConfig {
  port: number;
  host: string;
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  openrouterModel: string;
  visionModel: string;
  chatModel: string;
  maxConcurrent: number;
  agentTimeout: number;
  logLevel: string;
  studiesDir: string;
  resultsDir: string;
}

export interface SessionInfo {
  id: string;
  title: string | null;
  created_at: string;
  last_activity: string;
  message_count: number;
}

export interface NewMessage {
  id: string;
  sessionId: string;
  sender: string;
  text: string;
  timestamp: number;
}

export interface AgentResponse {
  sessionId: string;
  text: string;
  timestamp: number;
}

export interface ReactStep {
  type: "iteration" | "thought" | "action" | "observation" | "final" | "plan"
    | "overlay" | "viewer_cmd" | "report" | "progress";
  content: string;
  timestamp: string;
}

export interface DicomStudy {
  study_uid: string;
  patient_name: string;
  patient_id: string;
  study_date: string;
  study_description: string;
  modalities: string;
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
  label_name: string | null;
  metadata: string | null;
  created_at: string;
}
