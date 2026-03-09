"""Skill: Automatic lesion detection and quantification using AutoPET-3."""
from __future__ import annotations

import json
import os
from pathlib import Path

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import scan_directory, select_best_series


class QuantifyLesionSkill(BaseSkill):
    name = "quantify_lesion"
    description = (
        "Detect and quantify lesions using AutoPET-3 (nnUNet). "
        "Generates lesion mask, SUV statistics, MIP visualizations, and optional DICOM SEG overlay."
    )
    input_modalities = ["CT", "PT"]

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        study_dir = kwargs.get("study_dir", "")
        tracer = kwargs.get("tracer", "FDG")

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

        output_dir = os.path.join(results_dir, study_uid, "intermediate")
        os.makedirs(output_dir, exist_ok=True)

        # Check for model weights
        from analysis.local_agent import PROJECT_ROOT
        weights_dir = str(PROJECT_ROOT / "weights")
        if not os.path.exists(weights_dir):
            os.makedirs(weights_dir, exist_ok=True)

        from analysis.utils.autopet_wrapper import run_autopet_inference, analyze_prediction_mask

        mask_path = run_autopet_inference(ct_series, pet_series, output_dir, weights_dir)
        if not mask_path:
            return {"status": "error", "message": "AutoPET inference failed. Check weights/ directory."}

        analysis = analyze_prediction_mask(mask_path, pet_series=pet_series, ct_series=ct_series)
        if isinstance(analysis, str):
            return {"status": "error", "message": analysis}

        # Save statistics
        tables_dir = os.path.join(results_dir, study_uid, "tables")
        os.makedirs(tables_dir, exist_ok=True)
        csv_path = os.path.join(tables_dir, "lesion_stats.csv")

        with open(csv_path, "w") as f:
            f.write("lesion_id,suv_max,suv_mean,mtv_ml,tlg\n")
            for les in analysis.get("lesions", []):
                f.write(f"{les['id']},{les['suv_max']:.4f},{les['suv_mean']:.4f},"
                        f"{les['mtv_ml']:.2f},{les['tlg']:.2f}\n")

        # Generate DICOM SEG for viewer overlay
        seg_path = None
        try:
            from analysis.utils.nifti_to_dicomseg import nifti_mask_to_dicomseg

            seg_dir = os.path.join(results_dir, study_uid, "segmentations")
            os.makedirs(seg_dir, exist_ok=True)
            seg_path = os.path.join(seg_dir, "lesion_seg.dcm")

            # Find reference DICOM directory (use CT series files)
            ref_dir = os.path.dirname(ct_series.files[0])
            nifti_mask_to_dicomseg(mask_path, ref_dir, seg_path,
                                    label_name="Lesion", label_description="AutoPET-3 lesion detection")
        except Exception as exc:
            print(f"DICOM SEG conversion failed: {exc}")

        # Build overlay info for viewer.
        # analyze_prediction_mask already saves a SUVmax-ordered labeled mask
        # (_labeled.nii.gz) where label 1 = highest SUVmax.
        overlays = []
        lesions = analysis.get("lesions", [])[:5]
        if mask_path and os.path.exists(mask_path) and lesions:
            relabeled_path = mask_path.replace(".nii", "_labeled.nii")
            if not relabeled_path.endswith(".gz"):
                relabeled_path += ".gz"
            overlay_mask_path = relabeled_path if os.path.exists(relabeled_path) else mask_path

            labels = [{"name": f"Lesion {l['id']}", "suv_max": l["suv_max"], "value": l["id"]}
                      for l in lesions]
            overlays.append({
                "study_uid": study_uid,
                "path": os.path.relpath(overlay_mask_path, results_dir),
                "labels": labels,
            })

        vis_images = [os.path.relpath(p, results_dir) for p in analysis.get("visualization_images", [])]

        return {
            "status": "ok",
            "message": (
                f"Found {analysis['lesion_count']} lesion(s). "
                f"Top lesion SUVmax={analysis['lesions'][0]['suv_max']:.1f}"
                if analysis.get("lesions") else "No lesions detected."
            ),
            "lesion_count": analysis.get("lesion_count", 0),
            "lesions": analysis.get("lesions", []),
            "csv": os.path.relpath(csv_path, results_dir),
            "visualization_images": vis_images,
            "overlays": overlays,
        }
