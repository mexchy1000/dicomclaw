"""Skill: Vision LLM interpretation of medical images."""
from __future__ import annotations

import glob
import os
from pathlib import Path

from analysis.skills.base_skill import BaseSkill
from analysis.llm_client import query_vision


class VisionInterpretSkill(BaseSkill):
    name = "vision_interpret"
    description = (
        "Send MIP or visualization images to a Vision LLM for radiological interpretation, "
        "findings discussion, or clinical correlation."
    )
    input_modalities = []

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        prompt = kwargs.get("prompt", "Describe the findings in this PET/CT image.")
        image_type = kwargs.get("image_type", "mip")  # mip, lesion, segmentation

        if not study_uid:
            return {"status": "error", "message": "study_uid is required."}

        # Collect relevant images
        study_results = os.path.join(results_dir, study_uid)
        image_paths: list[str] = []

        if image_type == "mip":
            mip_dir = os.path.join(study_results, "plots", "mip")
            if os.path.exists(mip_dir):
                # Take a few representative angles
                for angle in ["000", "090", "180", "270"]:
                    p = os.path.join(mip_dir, f"mip_{angle}.png")
                    if os.path.exists(p):
                        image_paths.append(p)
            if not image_paths:
                # Try any PNG in plots/
                image_paths = sorted(glob.glob(os.path.join(study_results, "plots", "*.png")))[:4]

        elif image_type == "lesion":
            vis_dir = os.path.join(study_results, "intermediate", "lesion_vis")
            if os.path.exists(vis_dir):
                image_paths = sorted(glob.glob(os.path.join(vis_dir, "*.png")))[:4]

        elif image_type == "segmentation":
            image_paths = sorted(glob.glob(os.path.join(study_results, "plots", "seg_*.png")))[:4]

        elif image_type == "voi":
            voi_id = int(kwargs.get("voi_id", 1))
            mask_path = kwargs.get("mask_path", "")
            if not mask_path:
                return {"status": "error", "message": "mask_path required for voi image_type."}
            p = Path(mask_path)
            if not p.is_absolute():
                p = Path(results_dir) / mask_path
            if not p.exists():
                return {"status": "error", "message": f"Mask not found: {mask_path}"}

            # Find PET and CT NIfTI intermediates
            inter_dir = os.path.join(study_results, "intermediate")
            pet_nifti = os.path.join(inter_dir, "pet_suv.nii.gz")
            ct_nifti = os.path.join(inter_dir, "ct_resampled.nii.gz")
            if not os.path.exists(pet_nifti):
                pet_nifti = sorted(glob.glob(os.path.join(inter_dir, "pet*.nii*")))
                pet_nifti = pet_nifti[0] if pet_nifti else ""
            if not os.path.exists(ct_nifti):
                ct_nifti = sorted(glob.glob(os.path.join(inter_dir, "ct*.nii*")))
                ct_nifti = ct_nifti[0] if ct_nifti else ""

            if not pet_nifti or not ct_nifti:
                return {"status": "error", "message": "PET/CT NIfTI intermediates not found. Run analysis first."}

            from analysis.utils.voi_snapshot import generate_voi_snapshots
            voi_dir = os.path.join(study_results, "plots", "voi_snapshots")
            image_paths = generate_voi_snapshots(pet_nifti, ct_nifti, str(p), voi_id, voi_dir)
            if not image_paths:
                return {"status": "error", "message": f"VOI label {voi_id} not found in mask."}

        else:
            # Custom path
            custom = kwargs.get("image_path", "")
            if custom:
                p = Path(custom)
                if not p.is_absolute():
                    p = Path(results_dir) / custom
                if p.exists():
                    image_paths = [str(p)]

        if not image_paths:
            return {"status": "error", "message": f"No {image_type} images found for study {study_uid}."}

        # Build vision prompt
        system_context = (
            "You are an expert nuclear medicine physician reviewing PET/CT images. "
            "Provide a structured radiological interpretation including:\n"
            "1. Overall impression\n"
            "2. Areas of increased uptake\n"
            "3. Physiological vs pathological uptake assessment\n"
            "4. Recommendations\n\n"
        )

        full_prompt = system_context + prompt

        print(f"Querying Vision LLM with {len(image_paths)} image(s)...")
        response = query_vision(full_prompt, image_paths)

        if response.startswith("API Error") or response.startswith("Error:"):
            return {"status": "error", "message": response}

        # Save interpretation
        reports_dir = os.path.join(results_dir, study_uid, "reports")
        os.makedirs(reports_dir, exist_ok=True)
        report_path = os.path.join(reports_dir, f"vision_{image_type}_interpretation.md")

        with open(report_path, "w") as f:
            f.write(f"# Vision Interpretation: {image_type}\n\n")
            f.write(f"**Prompt:** {prompt}\n\n")
            f.write(f"**Images analyzed:** {len(image_paths)}\n\n")
            f.write("---\n\n")
            f.write(response)

        return {
            "status": "ok",
            "message": response[:500],
            "full_response": response,
            "report": os.path.relpath(report_path, results_dir),
            "images_analyzed": [os.path.relpath(p, results_dir) for p in image_paths],
        }
