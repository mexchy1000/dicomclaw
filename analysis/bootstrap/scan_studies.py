"""DICOM directory scanner → SQLite index builder.

Usage:
  python -m analysis.bootstrap.scan_studies --studies-dir data/studies
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

try:
    import pydicom
except ImportError:
    print("pydicom not installed. Run: pip install pydicom")
    sys.exit(1)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = PROJECT_ROOT / "data" / "dicomclaw.db"

# Add project root to path for clinical context import
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from analysis.utils.clinical_context import extract_study_context, extract_context_json


def scan_studies(studies_dir: str) -> None:
    studies_path = Path(studies_dir)
    if not studies_path.exists():
        print(f"Studies directory not found: {studies_dir}")
        return

    # Collect DICOM headers grouped by StudyInstanceUID → SeriesInstanceUID
    study_map: dict[str, dict] = {}
    series_map: dict[str, dict] = {}
    instance_map: dict[str, dict] = {}

    file_count = 0
    print(f"Scanning {studies_path} for DICOM files...")

    for root, _dirs, files in os.walk(studies_path):
        for fname in files:
            if fname.startswith("."):
                continue
            fpath = os.path.join(root, fname)
            try:
                ds = pydicom.dcmread(fpath, stop_before_pixels=True, force=True)
                if not hasattr(ds, "StudyInstanceUID") or not hasattr(ds, "SeriesInstanceUID"):
                    continue

                study_uid = str(ds.StudyInstanceUID)
                series_uid = str(ds.SeriesInstanceUID)
                sop_uid = str(getattr(ds, "SOPInstanceUID", f"unknown-{file_count}"))

                # Study level
                if study_uid not in study_map:
                    study_map[study_uid] = {
                        "study_uid": study_uid,
                        "patient_name": str(getattr(ds, "PatientName", "Unknown")),
                        "patient_id": str(getattr(ds, "PatientID", "")),
                        "study_date": str(getattr(ds, "StudyDate", "")),
                        "study_description": str(getattr(ds, "StudyDescription", "")),
                        "modalities": set(),
                        "series_uids": set(),
                        "instance_count": 0,
                    }

                modality = str(getattr(ds, "Modality", "Unknown"))
                study_map[study_uid]["modalities"].add(modality)
                study_map[study_uid]["series_uids"].add(series_uid)
                study_map[study_uid]["instance_count"] += 1

                # Series level
                if series_uid not in series_map:
                    st = getattr(ds, "SliceThickness", 0.0)
                    if st is None or st == "":
                        st = 0.0
                    series_map[series_uid] = {
                        "series_uid": series_uid,
                        "study_uid": study_uid,
                        "modality": modality,
                        "series_description": str(getattr(ds, "SeriesDescription", "")),
                        "num_instances": 0,
                        "slice_thickness": float(st),
                        "is_primary": 0,
                    }
                series_map[series_uid]["num_instances"] += 1

                # Instance level
                instance_number = int(getattr(ds, "InstanceNumber", 0) or 0)
                instance_map[sop_uid] = {
                    "sop_instance_uid": sop_uid,
                    "series_uid": series_uid,
                    "file_path": os.path.abspath(fpath),
                    "instance_number": instance_number,
                }

                file_count += 1
            except Exception:
                continue

    print(f"Found {file_count} DICOM files in {len(study_map)} studies, {len(series_map)} series")

    # Build a map of study_uid → directory paths (for clinical context extraction)
    # We find the study root by looking at where instance files are located
    study_dirs: dict[str, str] = {}
    for inst in instance_map.values():
        series = series_map.get(inst["series_uid"])
        if series:
            study_uid = series["study_uid"]
            if study_uid not in study_dirs:
                # Use the parent directory of the first instance file
                # Walk up to find the study-level directory
                inst_dir = os.path.dirname(inst["file_path"])
                # The study dir is typically at studies_path/<study_name>/
                # Find the shallowest subdirectory under studies_path that contains this file
                rel = os.path.relpath(inst_dir, studies_path)
                top_dir = rel.split(os.sep)[0]
                study_dirs[study_uid] = str(studies_path / top_dir)

    # Extract clinical context for each study
    study_contexts: dict[str, dict] = {}
    for study_uid, study_dir in study_dirs.items():
        try:
            ctx = extract_study_context(study_dir)
            study_contexts[study_uid] = ctx
            print(f"  Clinical context extracted for {study_uid[:20]}...")
        except Exception as e:
            print(f"  Warning: Failed to extract clinical context for {study_uid[:20]}: {e}")

    # Write to SQLite
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    cur = conn.cursor()

    # Ensure tables exist (in case the Node.js backend hasn't run yet)
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS dicom_studies (
            study_uid TEXT PRIMARY KEY,
            patient_name TEXT, patient_id TEXT,
            study_date TEXT, study_description TEXT,
            modalities TEXT, series_count INTEGER, instance_count INTEGER,
            clinical_context TEXT, clinical_context_json TEXT,
            indexed_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS dicom_series (
            series_uid TEXT PRIMARY KEY,
            study_uid TEXT REFERENCES dicom_studies(study_uid),
            modality TEXT, series_description TEXT,
            num_instances INTEGER, slice_thickness REAL, is_primary INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS dicom_instances (
            sop_instance_uid TEXT PRIMARY KEY,
            series_uid TEXT REFERENCES dicom_series(series_uid),
            file_path TEXT, instance_number INTEGER
        );
        CREATE TABLE IF NOT EXISTS analysis_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            study_uid TEXT, session_id TEXT, result_type TEXT,
            file_name TEXT, file_path TEXT, label_name TEXT, metadata TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_dicom_series_study ON dicom_series(study_uid);
        CREATE INDEX IF NOT EXISTS idx_dicom_instances_series ON dicom_instances(series_uid);
        CREATE INDEX IF NOT EXISTS idx_analysis_results_study ON analysis_results(study_uid);
    """)

    # Upsert studies
    for study in study_map.values():
        modalities_json = json.dumps(sorted(study["modalities"]))
        ctx = study_contexts.get(study["study_uid"])
        clinical_context = ctx.get("clinical_summary", "") if ctx else ""
        clinical_context_json_str = json.dumps(ctx, indent=2, default=str) if ctx else ""
        cur.execute(
            """INSERT OR REPLACE INTO dicom_studies
               (study_uid, patient_name, patient_id, study_date, study_description,
                modalities, series_count, instance_count, clinical_context, clinical_context_json, indexed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
            (
                study["study_uid"],
                study["patient_name"],
                study["patient_id"],
                study["study_date"],
                study["study_description"],
                modalities_json,
                len(study["series_uids"]),
                study["instance_count"],
                clinical_context,
                clinical_context_json_str,
            ),
        )

    # Upsert series
    for series in series_map.values():
        cur.execute(
            """INSERT OR REPLACE INTO dicom_series
               (series_uid, study_uid, modality, series_description, num_instances, slice_thickness, is_primary)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                series["series_uid"],
                series["study_uid"],
                series["modality"],
                series["series_description"],
                series["num_instances"],
                series["slice_thickness"],
                series["is_primary"],
            ),
        )

    # Upsert instances
    for inst in instance_map.values():
        cur.execute(
            """INSERT OR REPLACE INTO dicom_instances
               (sop_instance_uid, series_uid, file_path, instance_number)
               VALUES (?, ?, ?, ?)""",
            (
                inst["sop_instance_uid"],
                inst["series_uid"],
                inst["file_path"],
                inst["instance_number"],
            ),
        )

    # Remove stale studies whose directories no longer exist on disk
    cur.execute("SELECT study_uid FROM dicom_studies")
    all_db_uids = {row[0] for row in cur.fetchall()}
    scanned_uids = set(study_map.keys())
    stale_uids = all_db_uids - scanned_uids
    for uid in stale_uids:
        cur.execute("DELETE FROM dicom_instances WHERE series_uid IN (SELECT series_uid FROM dicom_series WHERE study_uid = ?)", (uid,))
        cur.execute("DELETE FROM dicom_series WHERE study_uid = ?", (uid,))
        cur.execute("DELETE FROM dicom_studies WHERE study_uid = ?", (uid,))
        print(f"  Removed stale study: {uid[:30]}...")

    conn.commit()
    conn.close()
    print(f"Index written to {DB_PATH}")


def main():
    parser = argparse.ArgumentParser(description="DICOMclaw - DICOM Study Indexer")
    parser.add_argument("--studies-dir", required=True, help="Path to DICOM studies directory")
    args = parser.parse_args()
    scan_studies(args.studies_dir)


if __name__ == "__main__":
    main()
