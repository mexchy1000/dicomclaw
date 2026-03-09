"""Skill: Generate Maximum Intensity Projection (MIP) images."""
from __future__ import annotations

import os
from pathlib import Path

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import scan_directory, select_best_series
from analysis.utils.image_proc import create_mip


class GenerateMipSkill(BaseSkill):
    name = "generate_mip"
    description = "Generate MIP (Maximum Intensity Projection) images from a PET series at multiple rotation angles."
    input_modalities = ["PT"]

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        study_dir = kwargs.get("study_dir", "")
        num_angles = int(kwargs.get("num_angles", "36"))

        if not study_uid and not study_dir:
            return {"status": "error", "message": "study_uid or study_dir is required."}

        # Locate the study directory
        if study_dir and os.path.isdir(study_dir):
            study_path = Path(study_dir)
        elif study_uid:
            resolved = resolve_study_dir(study_uid, studies_dir)
            if resolved:
                study_path = Path(resolved)
            else:
                study_path = Path(studies_dir)
        else:
            study_path = Path(studies_dir)

        series_dict = scan_directory(str(study_path))
        if not series_dict:
            return {"status": "error", "message": "No DICOM series found."}

        # Find PET series
        pet_uid = kwargs.get("pet_series_uid")
        if not pet_uid:
            selection = select_best_series(series_dict)
            pet_uid = selection.get("PET")

        if not pet_uid or pet_uid not in series_dict:
            # Fallback: find first PT series
            for uid, s in series_dict.items():
                if s.modality == "PT":
                    pet_uid = uid
                    break

        if not pet_uid or pet_uid not in series_dict:
            return {"status": "error", "message": "No PET series found."}

        pet_series = series_dict[pet_uid]
        output_dir = os.path.join(results_dir, study_uid, "plots", "mip")
        os.makedirs(output_dir, exist_ok=True)

        generated_files = create_mip(pet_series, output_dir, num_angles=num_angles)

        # Relative paths for reporting
        rel_files = [os.path.relpath(f, results_dir) for f in generated_files]

        return {
            "status": "ok",
            "message": f"Generated {len(generated_files)} MIP images.",
            "outputs": rel_files,
            "output_dir": os.path.relpath(output_dir, results_dir),
        }
