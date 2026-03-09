"""Skill: Organ segmentation using TotalSegmentator."""
from __future__ import annotations

import os
from pathlib import Path

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import scan_directory, select_best_series


class SegmentOrganSkill(BaseSkill):
    name = "segment_organ"
    description = (
        "Segment one or more organs from CT using TotalSegmentator. "
        "Generates NIfTI mask, DICOM SEG for viewer overlay, and visualization."
    )
    input_modalities = ["CT"]

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

        ct_uid = kwargs.get("ct_series_uid")
        if not ct_uid:
            selection = select_best_series(series_dict)
            ct_uid = selection.get("CT")
        if not ct_uid or ct_uid not in series_dict:
            # Fallback: first CT series
            for uid, s in series_dict.items():
                if s.modality == "CT":
                    ct_uid = uid
                    break

        if not ct_uid or ct_uid not in series_dict:
            return {"status": "error", "message": "No suitable CT series found."}

        ct_series = series_dict[ct_uid]

        # Run TotalSegmentator
        import nibabel as nib
        import numpy as np
        from analysis.utils.seg_utils import dicom_to_nifti_mem
        from totalsegmentator.python_api import totalsegmentator

        ct_nifti = dicom_to_nifti_mem(ct_series.files)

        organs = [o.strip() for o in organ.split(",")]

        print(f"Running TotalSegmentator for: {organs}")
        try:
            seg_img = totalsegmentator(ct_nifti, roi_subset=organs)
            mask_data = seg_img.get_fdata()
        except Exception as exc:
            return {"status": "error", "message": f"TotalSegmentator failed: {exc}"}

        # Save NIfTI mask
        intermediate_dir = os.path.join(results_dir, study_uid, "intermediate")
        os.makedirs(intermediate_dir, exist_ok=True)
        organ_tag = organ.replace(",", "_")
        mask_path = os.path.join(intermediate_dir, f"seg_{organ_tag}.nii.gz")
        nib.save(nib.Nifti1Image(mask_data, ct_nifti.affine), mask_path)

        # Generate DICOM SEG
        seg_dcm_path = None
        try:
            from analysis.utils.nifti_to_dicomseg import nifti_mask_to_dicomseg

            seg_dir = os.path.join(results_dir, study_uid, "segmentations")
            os.makedirs(seg_dir, exist_ok=True)
            seg_dcm_path = os.path.join(seg_dir, f"seg_{organ_tag}.dcm")

            ref_dir = os.path.dirname(ct_series.files[0])
            nifti_mask_to_dicomseg(mask_path, ref_dir, seg_dcm_path,
                                    label_name=organ, label_description=f"TotalSegmentator: {organ}")
        except Exception as exc:
            print(f"DICOM SEG conversion failed: {exc}")

        # Visualization
        plots_dir = os.path.join(results_dir, study_uid, "plots")
        os.makedirs(plots_dir, exist_ok=True)
        viz_path = os.path.join(plots_dir, f"seg_{organ_tag}_check.png")

        try:
            from analysis.utils.image_proc import visualize_segmentation_overlay

            ct_data = ct_nifti.get_fdata()
            binary_mask = (mask_data > 0.5).astype(float)
            zooms = ct_nifti.header.get_zooms()
            visualize_segmentation_overlay(ct_data, binary_mask, zooms, viz_path, organ, ct_vol=ct_data)
        except Exception as exc:
            print(f"Visualization failed: {exc}")
            viz_path = None

        zooms = ct_nifti.header.get_zooms()
        voxel_vol_ml = float(np.prod(zooms)) / 1000.0

        # Build per-organ labels from mask integer values
        # TotalSegmentator assigns integer labels 1..N matching the roi_subset order
        unique_vals = sorted([int(v) for v in np.unique(mask_data) if v > 0])
        organ_labels = []
        total_volume = 0.0
        for idx, val in enumerate(unique_vals):
            organ_name = organs[idx] if idx < len(organs) else f"organ_{val}"
            vol = int(np.sum(mask_data == val)) * voxel_vol_ml
            total_volume += vol
            organ_labels.append({"name": organ_name, "volume_ml": round(vol, 1)})

        overlays = []
        if os.path.exists(mask_path) and organ_labels:
            overlays.append({
                "study_uid": study_uid,
                "path": os.path.relpath(mask_path, results_dir),
                "labels": organ_labels,
            })

        label_summary = ", ".join(f"{l['name']}={l['volume_ml']}ml" for l in organ_labels)

        return {
            "status": "ok",
            "message": f"Segmented {organ}: {label_summary}. Total={total_volume:.1f} ml.",
            "organ": organ,
            "volume_ml": total_volume,
            "mask_nifti": os.path.relpath(mask_path, results_dir),
            "visualization": os.path.relpath(viz_path, results_dir) if viz_path else None,
            "overlays": overlays,
        }
