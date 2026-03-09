"""Skill: Compare lesions between two PET/CT studies."""
from __future__ import annotations

import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patheffects as path_effects
import nibabel as nib
import numpy as np
from scipy.ndimage import label, center_of_mass, rotate

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import scan_directory, select_best_series
from analysis.utils.image_proc import resample_to_isotropic
from analysis.utils.seg_utils import calculate_suv_factor
from analysis.llm_client import query_vision


class CompareStudiesSkill(BaseSkill):
    name = "compare_studies"
    description = (
        "Compare lesions between two PET/CT studies. Generates side-by-side MIP comparison, "
        "per-lesion statistics, and VLM-based interpretation of disease progression or regression."
    )
    input_modalities = ["CT", "PT"]

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        compare_study_uid = kwargs.get("compare_study_uid", "")

        if not study_uid:
            return {"status": "error", "message": "study_uid is required."}
        if not compare_study_uid:
            return {"status": "error", "message": "compare_study_uid is required."}

        # --- Load / run lesion detection for both studies ---
        stats_a = self._get_study_lesion_data(study_uid, studies_dir, results_dir, **kwargs)
        if stats_a.get("status") == "error":
            return stats_a

        stats_b = self._get_study_lesion_data(compare_study_uid, studies_dir, results_dir, **kwargs)
        if stats_b.get("status") == "error":
            return stats_b

        # --- Output directories ---
        compare_uid_short = compare_study_uid[-12:] if len(compare_study_uid) > 12 else compare_study_uid
        plots_dir = os.path.join(results_dir, study_uid, "plots")
        tables_dir = os.path.join(results_dir, study_uid, "tables")
        reports_dir = os.path.join(results_dir, study_uid, "reports")
        os.makedirs(plots_dir, exist_ok=True)
        os.makedirs(tables_dir, exist_ok=True)
        os.makedirs(reports_dir, exist_ok=True)

        # --- Side-by-side MIP comparison ---
        comparison_img_path = os.path.join(plots_dir, f"comparison_{compare_uid_short}.png")
        self._generate_comparison_mip(
            stats_a["pet_data"], stats_a["spacing"], stats_a["lesions"],
            stats_b["pet_data"], stats_b["spacing"], stats_b["lesions"],
            comparison_img_path,
        )

        # --- Lesion ROI patches (if lesions exist in either study) ---
        patch_paths: list[str] = []
        all_lesions = stats_a["lesions"] + stats_b["lesions"]
        if all_lesions:
            patch_path = os.path.join(plots_dir, f"comparison_patches_{compare_uid_short}.png")
            ok = self._generate_lesion_patches(
                stats_a["pet_data"], stats_a["spacing"], stats_a["lesions"],
                stats_b["pet_data"], stats_b["spacing"], stats_b["lesions"],
                patch_path,
            )
            if ok:
                patch_paths.append(patch_path)

        # --- Summary statistics ---
        summary_a = self._compute_summary(stats_a["lesions"], stats_a["voxel_vol"])
        summary_b = self._compute_summary(stats_b["lesions"], stats_b["voxel_vol"])

        csv_path = os.path.join(tables_dir, "comparison_stats.csv")
        self._save_comparison_csv(csv_path, study_uid, compare_study_uid, summary_a, summary_b,
                                  stats_a["lesions"], stats_b["lesions"], stats_a["voxel_vol"], stats_b["voxel_vol"])

        # --- VLM interpretation ---
        vlm_images = [comparison_img_path] + patch_paths
        vlm_images = [p for p in vlm_images if os.path.exists(p)]

        report_path = os.path.join(reports_dir, "comparison_report.md")
        vlm_response = self._query_vlm_comparison(vlm_images, summary_a, summary_b, study_uid, compare_study_uid)

        with open(report_path, "w") as f:
            f.write(f"# Lesion Comparison Report\n\n")
            f.write(f"**Study A:** `{study_uid}`\n\n")
            f.write(f"**Study B:** `{compare_study_uid}`\n\n")
            f.write("## Summary Statistics\n\n")
            f.write(f"| Metric | Study A | Study B |\n")
            f.write(f"|--------|---------|----------|\n")
            f.write(f"| Lesion count | {summary_a['lesion_count']} | {summary_b['lesion_count']} |\n")
            f.write(f"| Total MTV (ml) | {summary_a['total_mtv_ml']:.2f} | {summary_b['total_mtv_ml']:.2f} |\n")
            f.write(f"| Total TLG | {summary_a['total_tlg']:.2f} | {summary_b['total_tlg']:.2f} |\n\n")
            f.write("---\n\n")
            f.write("## VLM Interpretation\n\n")
            f.write(vlm_response)

        rel_images = [os.path.relpath(p, results_dir) for p in vlm_images]

        return {
            "status": "ok",
            "message": (
                f"Comparison complete. Study A: {summary_a['lesion_count']} lesion(s), "
                f"Study B: {summary_b['lesion_count']} lesion(s)."
            ),
            "study_a": {"uid": study_uid, **summary_a},
            "study_b": {"uid": compare_study_uid, **summary_b},
            "images": rel_images,
            "csv": os.path.relpath(csv_path, results_dir),
            "report": os.path.relpath(report_path, results_dir),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _get_study_lesion_data(self, uid: str, studies_dir: str, results_dir: str, **kwargs) -> dict:
        """Load or run lesion detection for a single study. Returns PET data, lesion stats, etc."""
        intermediate_dir = os.path.join(results_dir, uid, "intermediate")
        mask_path = os.path.join(intermediate_dir, "lesion_mask_3mm.nii.gz")
        pet_path = os.path.join(intermediate_dir, "pet_3mm_iso.nii.gz")

        # If mask doesn't exist, run lesion detection
        if not os.path.exists(mask_path) or not os.path.exists(pet_path):
            print(f"Lesion mask not found for {uid}. Running lesion detection...")
            result = self._run_lesion_detection(uid, studies_dir, results_dir, **kwargs)
            if result.get("status") == "error":
                return result

        if not os.path.exists(pet_path):
            return {"status": "error", "message": f"PET NIfTI not found for study {uid}."}

        pet_img = nib.load(pet_path)
        pet_data = pet_img.get_fdata()
        zooms = pet_img.header.get_zooms()
        spacing = tuple(float(z) for z in zooms)
        voxel_vol = float(np.prod(zooms)) / 1000.0

        # Compute per-lesion stats from mask
        lesions: list[dict] = []
        if os.path.exists(mask_path):
            mask_img = nib.load(mask_path)
            mask_data = mask_img.get_fdata()

            if mask_data.shape != pet_data.shape:
                from analysis.utils.seg_utils import shape_matching
                mask_data = shape_matching(mask_data, pet_data.shape)

            lesion_mask = mask_data > 0.5
            labeled_arr, n_lesions = label(lesion_mask)

            for i in range(1, n_lesions + 1):
                lm = labeled_arr == i
                vol_ml = float(np.sum(lm)) * voxel_vol
                if vol_ml < 0.1:
                    continue
                vals = pet_data[lm]
                centroid = center_of_mass(lm)
                lesions.append({
                    "id": i,
                    "suv_max": float(np.max(vals)),
                    "suv_mean": float(np.mean(vals)),
                    "mtv_ml": vol_ml,
                    "tlg": float(np.mean(vals)) * vol_ml,
                    "centroid": [float(c) for c in centroid],
                })
            lesions.sort(key=lambda x: x["suv_max"], reverse=True)

        return {
            "status": "ok",
            "pet_data": pet_data,
            "spacing": spacing,
            "voxel_vol": voxel_vol,
            "lesions": lesions,
        }

    def _run_lesion_detection(self, uid: str, studies_dir: str, results_dir: str, **kwargs) -> dict:
        """Run the quantify_lesion skill for a study."""
        from analysis.skills.quantify_lesion import QuantifyLesionSkill

        skill = QuantifyLesionSkill()
        return skill.run(studies_dir, results_dir, study_uid=uid, **{
            k: v for k, v in kwargs.items()
            if k not in ("study_uid", "compare_study_uid")
        })

    def _generate_comparison_mip(
        self,
        pet_a: np.ndarray, spacing_a: tuple, lesions_a: list[dict],
        pet_b: np.ndarray, spacing_b: tuple, lesions_b: list[dict],
        output_path: str,
    ) -> None:
        """Generate side-by-side coronal MIP comparison image."""
        target_sp = 3.0

        # Resample and compute coronal MIP for each study
        mip_a = self._compute_coronal_mip(pet_a, spacing_a, target_sp)
        mip_b = self._compute_coronal_mip(pet_b, spacing_b, target_sp)

        # Normalize display
        vmax = max(10.0, float(np.percentile(mip_a, 99.9)), float(np.percentile(mip_b, 99.9)))

        fig, axes = plt.subplots(1, 2, figsize=(12, 8))

        axes[0].imshow(mip_a, cmap="inferno", vmin=0, vmax=vmax, aspect="equal")
        axes[0].set_title("Study A (Primary)", fontsize=14, fontweight="bold")
        axes[0].axis("off")
        self._annotate_lesions_on_mip(axes[0], lesions_a, pet_a.shape, spacing_a, target_sp)

        axes[1].imshow(mip_b, cmap="inferno", vmin=0, vmax=vmax, aspect="equal")
        axes[1].set_title("Study B (Comparison)", fontsize=14, fontweight="bold")
        axes[1].axis("off")
        self._annotate_lesions_on_mip(axes[1], lesions_b, pet_b.shape, spacing_b, target_sp)

        plt.suptitle("PET MIP Comparison", fontsize=16, fontweight="bold")
        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        print(f"Saved comparison MIP: {output_path}")

    def _compute_coronal_mip(self, pet_data: np.ndarray, spacing: tuple, target_sp: float) -> np.ndarray:
        """Compute coronal MIP from PET volume. Input shape (X, Y, Z)."""
        # Transpose to (Z, Y, X) for resampling
        vol = np.transpose(pet_data, (2, 1, 0))
        sp = (spacing[2], spacing[1], spacing[0])

        vol_iso = resample_to_isotropic(vol, sp, target_sp)
        # Coronal MIP: project along Y axis (axis=1 after Z,Y,X ordering)
        mip = np.max(vol_iso, axis=1)
        mip = np.flipud(mip)
        return mip

    def _annotate_lesions_on_mip(self, ax, lesions: list[dict], vol_shape: tuple,
                                  spacing: tuple, target_sp: float) -> None:
        """Overlay lesion markers on a coronal MIP."""
        if not lesions:
            return
        # Volume shape (X, Y, Z) -> resampled (Z, Y, X) isotropic
        z_factor = spacing[2] / target_sp
        x_factor = spacing[0] / target_sp
        iso_z = int(vol_shape[2] * z_factor)

        for idx, les in enumerate(lesions[:5]):
            centroid = les.get("centroid", [0, 0, 0])
            # centroid is in (X, Y, Z) voxel space
            cx_vox, cy_vox, cz_vox = centroid
            # Map to MIP display coords: MIP is (Z_iso, X_iso) flipped vertically
            cz_iso = cz_vox * z_factor
            cx_iso = cx_vox * x_factor
            # flipud: display_y = iso_z - 1 - cz_iso
            disp_y = iso_z - 1 - cz_iso
            disp_x = cx_iso

            ax.plot(disp_x, disp_y, "w+", markersize=12, markeredgewidth=2)
            ax.text(disp_x + 3, disp_y, f"L{idx + 1}\n{les['suv_max']:.1f}",
                    color="white", fontsize=9, fontweight="bold",
                    path_effects=[path_effects.withStroke(linewidth=2, foreground="black")])

    def _generate_lesion_patches(
        self,
        pet_a: np.ndarray, spacing_a: tuple, lesions_a: list[dict],
        pet_b: np.ndarray, spacing_b: tuple, lesions_b: list[dict],
        output_path: str,
    ) -> bool:
        """Generate cropped ROI patches around lesions from both studies."""
        top_a = lesions_a[:3]
        top_b = lesions_b[:3]
        n_rows = max(len(top_a), len(top_b), 1)

        fig, axes = plt.subplots(n_rows, 2, figsize=(8, 4 * n_rows))
        if n_rows == 1:
            axes = axes.reshape(1, 2)

        vmax = max(10.0,
                   max((l["suv_max"] for l in top_a), default=0),
                   max((l["suv_max"] for l in top_b), default=0))

        for row in range(n_rows):
            for col, (lesions, pet_data) in enumerate([(top_a, pet_a), (top_b, pet_b)]):
                ax = axes[row, col]
                if row < len(lesions):
                    les = lesions[row]
                    centroid = les.get("centroid", [0, 0, 0])
                    cx, cy, cz = [int(round(c)) for c in centroid]
                    # Extract axial slice at lesion centroid (data is X, Y, Z)
                    cz = max(0, min(cz, pet_data.shape[2] - 1))
                    axial_slice = pet_data[:, :, cz].T  # (Y, X)

                    # Crop 40-voxel window around lesion
                    hw = 20
                    y0 = max(0, cy - hw)
                    y1 = min(axial_slice.shape[0], cy + hw)
                    x0 = max(0, cx - hw)
                    x1 = min(axial_slice.shape[1], cx + hw)
                    patch = axial_slice[y0:y1, x0:x1]

                    ax.imshow(patch, cmap="hot", vmin=0, vmax=vmax, aspect="equal")
                    label_txt = f"L{row + 1}: SUVmax={les['suv_max']:.1f}, Vol={les['mtv_ml']:.1f}ml"
                    ax.set_title(label_txt, fontsize=9)
                else:
                    ax.text(0.5, 0.5, "No lesion", ha="center", va="center",
                            transform=ax.transAxes, fontsize=12, color="gray")
                ax.axis("off")

        col_labels = ["Study A", "Study B"]
        for col in range(2):
            axes[0, col].text(0.5, 1.15, col_labels[col], ha="center",
                              transform=axes[0, col].transAxes, fontsize=13, fontweight="bold")

        plt.suptitle("Lesion ROI Patches", fontsize=14, fontweight="bold", y=1.02)
        plt.tight_layout()
        plt.savefig(output_path, dpi=150, bbox_inches="tight")
        plt.close(fig)
        print(f"Saved lesion patches: {output_path}")
        return True

    def _compute_summary(self, lesions: list[dict], voxel_vol: float) -> dict:
        """Compute aggregate statistics for a set of lesions."""
        total_mtv = sum(l["mtv_ml"] for l in lesions)
        total_tlg = sum(l["tlg"] for l in lesions)
        return {
            "lesion_count": len(lesions),
            "total_mtv_ml": total_mtv,
            "total_tlg": total_tlg,
        }

    def _save_comparison_csv(self, csv_path: str, uid_a: str, uid_b: str,
                              summary_a: dict, summary_b: dict,
                              lesions_a: list[dict], lesions_b: list[dict],
                              voxel_vol_a: float, voxel_vol_b: float) -> None:
        """Save comparison statistics to CSV."""
        with open(csv_path, "w") as f:
            # Summary section
            f.write("section,study_uid,lesion_count,total_mtv_ml,total_tlg\n")
            f.write(f"summary,{uid_a},{summary_a['lesion_count']},"
                    f"{summary_a['total_mtv_ml']:.2f},{summary_a['total_tlg']:.2f}\n")
            f.write(f"summary,{uid_b},{summary_b['lesion_count']},"
                    f"{summary_b['total_mtv_ml']:.2f},{summary_b['total_tlg']:.2f}\n")
            f.write("\n")

            # Per-lesion detail
            f.write("section,study_uid,lesion_id,suv_max,suv_mean,mtv_ml,tlg,centroid_x,centroid_y,centroid_z\n")
            for les in lesions_a:
                c = les.get("centroid", [0, 0, 0])
                f.write(f"lesion,{uid_a},{les['id']},{les['suv_max']:.4f},{les['suv_mean']:.4f},"
                        f"{les['mtv_ml']:.2f},{les['tlg']:.2f},{c[0]:.1f},{c[1]:.1f},{c[2]:.1f}\n")
            for les in lesions_b:
                c = les.get("centroid", [0, 0, 0])
                f.write(f"lesion,{uid_b},{les['id']},{les['suv_max']:.4f},{les['suv_mean']:.4f},"
                        f"{les['mtv_ml']:.2f},{les['tlg']:.2f},{c[0]:.1f},{c[1]:.1f},{c[2]:.1f}\n")

        print(f"Saved comparison CSV: {csv_path}")

    def _query_vlm_comparison(self, image_paths: list[str], summary_a: dict, summary_b: dict,
                               uid_a: str, uid_b: str) -> str:
        """Send comparison images to VLM for interpretation."""
        stats_context = (
            f"Study A ({uid_a[-12:]}): {summary_a['lesion_count']} lesions, "
            f"MTV={summary_a['total_mtv_ml']:.1f} ml, TLG={summary_a['total_tlg']:.1f}\n"
            f"Study B ({uid_b[-12:]}): {summary_b['lesion_count']} lesions, "
            f"MTV={summary_b['total_mtv_ml']:.1f} ml, TLG={summary_b['total_tlg']:.1f}\n"
        )

        prompt = (
            "You are an expert nuclear medicine physician comparing two PET/CT studies "
            "from the same patient at different time points.\n\n"
            f"Quantitative summary:\n{stats_context}\n"
            "Based on the images and statistics above, provide a structured comparison:\n"
            "1. **New lesions**: Are there lesions present in one study but not the other?\n"
            "2. **Resolved lesions**: Have any previously seen lesions disappeared?\n"
            "3. **Changed lesions**: Have any lesions changed in size or SUV uptake?\n"
            "4. **Overall assessment**: Is there evidence of disease progression, "
            "stable disease, partial response, or complete response?\n"
            "5. **Recommendations**: Suggest next steps if appropriate.\n"
        )

        if not image_paths:
            return "No comparison images available for VLM interpretation."

        print(f"Querying Vision LLM with {len(image_paths)} comparison image(s)...")
        response = query_vision(prompt, image_paths)

        if response.startswith("API Error") or response.startswith("Error:"):
            print(f"VLM query failed: {response}")
            return f"VLM interpretation unavailable: {response}"

        return response
