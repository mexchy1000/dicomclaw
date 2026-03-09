"""Skill: Scan DICOM directory and select best series."""
from __future__ import annotations

import json
from pathlib import Path

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import DicomSeries, scan_directory, select_best_series


class ScanDicomSkill(BaseSkill):
    name = "scan_dicom"
    description = "Scan a DICOM study directory, list all series, and optionally auto-select the best PET/CT pair."
    input_modalities = []

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        study_dir = kwargs.get("study_dir", "")
        auto_select = kwargs.get("auto_select", "true").lower() == "true"

        # Determine scan path
        scan_path = Path(studies_dir)
        if study_dir and Path(study_dir).exists():
            scan_path = Path(study_dir)
        elif study_uid:
            resolved = resolve_study_dir(study_uid, studies_dir)
            if resolved:
                scan_path = Path(resolved)

        if not scan_path.exists():
            return {"status": "error", "message": f"Path not found: {scan_path}"}

        series_dict = scan_directory(str(scan_path))
        if not series_dict:
            return {"status": "error", "message": "No DICOM series found."}

        # Build summary
        series_info = []
        for uid, s in series_dict.items():
            series_info.append({
                "series_uid": uid,
                "modality": s.modality,
                "description": s.description,
                "num_files": len(s.files),
                "slice_thickness": s.metadata.get("SliceThickness", 0),
                "image_type": s.metadata.get("ImageType", []),
            })

        result: dict = {
            "status": "ok",
            "message": f"Found {len(series_info)} series.",
            "series": series_info,
        }

        if auto_select and len(series_dict) > 1:
            selection = select_best_series(series_dict)
            result["selected"] = selection
            result["message"] += f" Selected PET={selection.get('PET')}, CT={selection.get('CT')}"

        return result
