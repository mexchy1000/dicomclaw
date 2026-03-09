"""Skill: Calculate SUV statistics for a specific organ."""
from __future__ import annotations

import json
import os
from pathlib import Path

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import scan_directory, select_best_series
from analysis.utils.seg_utils import get_organ_suv


class CalcSuvSkill(BaseSkill):
    name = "calc_suv"
    description = (
        "Calculate SUV (Standardized Uptake Value) statistics for a specific organ "
        "using TotalSegmentator segmentation on CT and PET co-registration."
    )
    input_modalities = ["CT", "PT"]

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        study_dir = kwargs.get("study_dir", "")
        organ = kwargs.get("organ", "liver")

        if not study_uid and not study_dir:
            return {"status": "error", "message": "study_uid or study_dir is required."}

        if study_dir and os.path.isdir(study_dir):
            study_path = Path(study_dir)
        elif study_uid:
            resolved = resolve_study_dir(study_uid, studies_dir)
            study_path = Path(resolved) if resolved else Path(studies_dir)
        else:
            study_path = Path(studies_dir)

        series_dict = scan_directory(str(study_path))
        if not series_dict:
            return {"status": "error", "message": "No DICOM series found."}

        # Resolve PET/CT series
        pet_uid = kwargs.get("pet_series_uid")
        ct_uid = kwargs.get("ct_series_uid")

        if not pet_uid or not ct_uid:
            selection = select_best_series(series_dict)
            pet_uid = pet_uid or selection.get("PET")
            ct_uid = ct_uid or selection.get("CT")

        if not pet_uid or pet_uid not in series_dict:
            return {"status": "error", "message": "No suitable PET series found."}
        if not ct_uid or ct_uid not in series_dict:
            return {"status": "error", "message": "No suitable CT series found."}

        ct_series = series_dict[ct_uid]
        pet_series = series_dict[pet_uid]

        output_dir = os.path.join(results_dir, study_uid, "plots")
        os.makedirs(output_dir, exist_ok=True)

        stats = get_organ_suv(ct_series, pet_series, organ, output_dir=output_dir)

        # Save to CSV
        tables_dir = os.path.join(results_dir, study_uid, "tables")
        os.makedirs(tables_dir, exist_ok=True)
        csv_path = os.path.join(tables_dir, f"suv_{organ}.csv")
        with open(csv_path, "w") as f:
            f.write("organ,suv_mean,suv_max,suv_std,volume_ml\n")
            f.write(f"{organ},{stats.get('mean',0):.4f},{stats.get('max',0):.4f},"
                    f"{stats.get('std',0):.4f},{stats.get('volume_ml',0):.2f}\n")

        # Build overlay for viewer
        overlays = []
        mask_path = stats.get("mask_path")
        if mask_path and os.path.exists(mask_path):
            overlays.append({
                "study_uid": study_uid,
                "path": os.path.relpath(mask_path, results_dir),
                "labels": [{"name": organ, "volume_ml": round(stats.get("volume_ml", 0), 1)}],
            })

        return {
            "status": "ok",
            "message": (
                f"{organ} SUV: mean={stats['mean']:.2f}, max={stats['max']:.2f}, "
                f"std={stats.get('std',0):.2f}, volume={stats.get('volume_ml',0):.1f}ml"
            ),
            "stats": stats,
            "csv": os.path.relpath(csv_path, results_dir),
            "overlays": overlays,
        }
