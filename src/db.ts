import Database from "better-sqlite3";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const DB_PATH = path.join(PROJECT_ROOT, "data", "dicomclaw.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    initTables(db);
  }
  return db;
}

function initTables(db: Database.Database): void {
  db.exec(`
    -- Chat sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity TEXT NOT NULL DEFAULT (datetime('now')),
      message_count INTEGER NOT NULL DEFAULT 0
    );

    -- Chat messages
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Agent runs
    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      result TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- ReAct steps
    CREATE TABLE IF NOT EXISTS react_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      step_type TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    -- Session files (output artifacts)
    CREATE TABLE IF NOT EXISTS session_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_type TEXT NOT NULL DEFAULT 'other',
      file_path TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- DICOM Studies (worklist)
    CREATE TABLE IF NOT EXISTS dicom_studies (
      study_uid TEXT PRIMARY KEY,
      patient_name TEXT,
      patient_id TEXT,
      study_date TEXT,
      study_description TEXT,
      modalities TEXT,
      series_count INTEGER,
      instance_count INTEGER,
      clinical_context TEXT,
      clinical_context_json TEXT,
      indexed_at TEXT DEFAULT (datetime('now'))
    );

    -- DICOM Series
    CREATE TABLE IF NOT EXISTS dicom_series (
      series_uid TEXT PRIMARY KEY,
      study_uid TEXT REFERENCES dicom_studies(study_uid),
      modality TEXT,
      series_description TEXT,
      num_instances INTEGER,
      slice_thickness REAL,
      is_primary INTEGER DEFAULT 0
    );

    -- DICOM Instances (file mapping)
    CREATE TABLE IF NOT EXISTS dicom_instances (
      sop_instance_uid TEXT PRIMARY KEY,
      series_uid TEXT REFERENCES dicom_series(series_uid),
      file_path TEXT,
      instance_number INTEGER
    );

    -- Analysis results metadata
    CREATE TABLE IF NOT EXISTS analysis_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      study_uid TEXT,
      session_id TEXT,
      result_type TEXT,
      file_name TEXT,
      file_path TEXT,
      label_name TEXT,
      metadata TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_react_steps_session ON react_steps(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_files_session ON session_files(session_id);
    CREATE INDEX IF NOT EXISTS idx_dicom_series_study ON dicom_series(study_uid);
    CREATE INDEX IF NOT EXISTS idx_dicom_instances_series ON dicom_instances(series_uid);
    CREATE INDEX IF NOT EXISTS idx_analysis_results_study ON analysis_results(study_uid);
  `);
}

// ── Session helpers ──

export function renameSession(id: string, title: string): void {
  const d = getDb();
  d.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, id);
}

export function getSession(id: string) {
  const d = getDb();
  return d
    .prepare(
      "SELECT id, title, created_at, last_activity, message_count FROM sessions WHERE id = ?",
    )
    .get(id) as
    | { id: string; title: string | null; created_at: string; last_activity: string; message_count: number }
    | undefined;
}

export function deleteSession(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM session_files WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM react_steps WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM agent_runs WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
  d.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function addReactStep(
  sessionId: string,
  iteration: number,
  stepType: string,
  content: string,
): void {
  const d = getDb();
  d.prepare(
    "INSERT INTO react_steps (session_id, iteration, step_type, content) VALUES (?, ?, ?, ?)",
  ).run(sessionId, iteration, stepType, content);
}

// ── Session files ──

export interface SessionFile {
  id: number;
  session_id: string;
  file_name: string;
  file_type: string;
  file_path: string;
  relative_path: string;
  size: number;
  created_at: string;
}

export function addSessionFile(
  sessionId: string,
  fileName: string,
  fileType: string,
  filePath: string,
  relativePath: string,
  size: number,
): void {
  const d = getDb();
  const existing = d
    .prepare("SELECT id FROM session_files WHERE session_id = ? AND relative_path = ?")
    .get(sessionId, relativePath);
  if (existing) return;

  d.prepare(
    "INSERT INTO session_files (session_id, file_name, file_type, file_path, relative_path, size) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sessionId, fileName, fileType, filePath, relativePath, size);
}

export function getSessionFiles(sessionId: string): SessionFile[] {
  const d = getDb();
  return d
    .prepare(
      "SELECT id, session_id, file_name, file_type, file_path, relative_path, size, created_at FROM session_files WHERE session_id = ? ORDER BY created_at DESC",
    )
    .all(sessionId) as SessionFile[];
}

// ── DICOM index helpers ──

export function upsertStudy(study: {
  study_uid: string;
  patient_name: string;
  patient_id: string;
  study_date: string;
  study_description: string;
  modalities: string;
  series_count: number;
  instance_count: number;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO dicom_studies
      (study_uid, patient_name, patient_id, study_date, study_description, modalities, series_count, instance_count, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    study.study_uid,
    study.patient_name,
    study.patient_id,
    study.study_date,
    study.study_description,
    study.modalities,
    study.series_count,
    study.instance_count,
  );
}

export function upsertSeries(series: {
  series_uid: string;
  study_uid: string;
  modality: string;
  series_description: string;
  num_instances: number;
  slice_thickness: number;
  is_primary: number;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO dicom_series
      (series_uid, study_uid, modality, series_description, num_instances, slice_thickness, is_primary)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    series.series_uid,
    series.study_uid,
    series.modality,
    series.series_description,
    series.num_instances,
    series.slice_thickness,
    series.is_primary,
  );
}

export function upsertInstance(instance: {
  sop_instance_uid: string;
  series_uid: string;
  file_path: string;
  instance_number: number;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT OR REPLACE INTO dicom_instances
      (sop_instance_uid, series_uid, file_path, instance_number)
    VALUES (?, ?, ?, ?)
  `).run(
    instance.sop_instance_uid,
    instance.series_uid,
    instance.file_path,
    instance.instance_number,
  );
}

export function getAllStudies() {
  const d = getDb();
  return d.prepare("SELECT * FROM dicom_studies ORDER BY study_date DESC").all();
}

export function getStudySeries(studyUid: string) {
  const d = getDb();
  return d.prepare("SELECT * FROM dicom_series WHERE study_uid = ? ORDER BY modality, series_description").all(studyUid);
}

export function getSeriesInstances(seriesUid: string) {
  const d = getDb();
  return d.prepare("SELECT * FROM dicom_instances WHERE series_uid = ? ORDER BY instance_number").all(seriesUid);
}

export function addAnalysisResult(result: {
  study_uid: string;
  session_id: string;
  result_type: string;
  file_name: string;
  file_path: string;
  label_name?: string;
  metadata?: string;
}): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO analysis_results (study_uid, session_id, result_type, file_name, file_path, label_name, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.study_uid,
    result.session_id,
    result.result_type,
    result.file_name,
    result.file_path,
    result.label_name || null,
    result.metadata || null,
  );
}

export function getStudyResults(studyUid: string) {
  const d = getDb();
  return d.prepare("SELECT * FROM analysis_results WHERE study_uid = ? ORDER BY created_at DESC").all(studyUid);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
