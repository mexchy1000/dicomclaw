"""Skill: Detailed VOI (Volume of Interest) analysis with SUV statistics and histogram."""
from __future__ import annotations

import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import nibabel as nib
import numpy as np

from analysis.skills.base_skill import BaseSkill, resolve_study_dir
from analysis.utils.dicom_utils import scan_directory, select_best_series


class AnalyzeVoiSkill(BaseSkill):
    name = "analyze_voi"
    description = (
        "Analyze a specific VOI (Volume of Interest) in detail. "
        "Computes comprehensive SUV statistics (mean, max, min, std, percentiles, TLG), "
        "generates a SUV histogram plot and an axial intensity profile through the centroid, "
        "and saves results to CSV."
    )
    input_modalities = ["PT"]

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        mask_path_rel = kwargs.get("mask_path", "")
        label_value = int(kwargs.get("label_value", 1))
        organ = kwargs.get("organ", "voi")

        if not study_uid:
            return {"status": "error", "message": "study_uid is required."}
        if not mask_path_rel:
            return {"status": "error", "message": "mask_path is required (relative to results_dir)."}

        # ------------------------------------------------------------------
        # Resolve paths
        # ------------------------------------------------------------------
        intermediate_dir = os.path.join(results_dir, study_uid, "intermediate")
        mask_path_abs = os.path.join(results_dir, mask_path_rel)
        if not os.path.isfile(mask_path_abs):
            return {"status": "error", "message": f"Mask file not found: {mask_path_abs}"}

        # ------------------------------------------------------------------
        # Load PET SUV volume (prefer cached 3mm iso NIfTI)
        # ------------------------------------------------------------------
        pet_nifti_path = os.path.join(intermediate_dir, "pet_3mm_iso.nii.gz")
        pet_suv_img: nib.Nifti1Image | None = None

        if os.path.isfile(pet_nifti_path):
            print(f"Loading cached PET NIfTI: {pet_nifti_path}")
            pet_suv_img = nib.load(pet_nifti_path)
        else:
            # Build from DICOM
            print("No cached PET NIfTI found, building from DICOM...")
            study_dir = kwargs.get("study_dir", "")
            if study_dir and os.path.isdir(study_dir):
                study_path = Path(study_dir)
            elif study_uid:
                resolved = resolve_study_dir(study_uid, studies_dir)
                study_path = Path(resolved) if resolved else Path(studies_dir)
            else:
                return {"status": "error", "message": "Cannot locate study directory."}

            series_dict = scan_directory(str(study_path))
            if not series_dict:
                return {"status": "error", "message": "No DICOM series found."}

            pet_uid = kwargs.get("pet_series_uid")
            if not pet_uid:
                selection = select_best_series(series_dict)
                pet_uid = selection.get("PET")

            if not pet_uid or pet_uid not in series_dict:
                return {"status": "error", "message": "No suitable PET series found."}

            pet_series = series_dict[pet_uid]

            from analysis.utils.seg_utils import calculate_suv_factor, dicom_to_nifti_mem

            pet_header = pet_series.get_header()
            suv_factor = calculate_suv_factor(pet_header)
            if suv_factor is None:
                return {"status": "error", "message": "Could not calculate SUV factor from PET headers."}

            pet_nifti_raw = dicom_to_nifti_mem(pet_series.files)
            suv_data = pet_nifti_raw.get_fdata() * suv_factor

            # Resample to 3mm isotropic for consistency
            from nibabel.processing import resample_to_output

            pet_suv_img = nib.Nifti1Image(suv_data.astype(np.float32), pet_nifti_raw.affine)
            pet_suv_img = resample_to_output(pet_suv_img, voxel_sizes=(3.0, 3.0, 3.0), order=1)

            # Cache for future use
            os.makedirs(intermediate_dir, exist_ok=True)
            nib.save(pet_suv_img, pet_nifti_path)
            print(f"Saved PET NIfTI: {pet_nifti_path}")

        pet_data = pet_suv_img.get_fdata()
        pet_zooms = pet_suv_img.header.get_zooms()

        # ------------------------------------------------------------------
        # Load mask and extract label
        # ------------------------------------------------------------------
        mask_img = nib.load(mask_path_abs)

        # Resample mask to PET space if shapes don't match
        mask_data = mask_img.get_fdata()
        if mask_data.shape != pet_data.shape:
            print(f"Resampling mask {mask_data.shape} to PET space {pet_data.shape}...")
            from nibabel.processing import resample_from_to

            mask_resampled = resample_from_to(mask_img, pet_suv_img, order=0)
            mask_data = mask_resampled.get_fdata()

        # Extract specific label
        label_mask = np.isclose(mask_data, label_value) if np.issubdtype(mask_data.dtype, np.floating) else (mask_data == label_value)

        voxel_count = int(np.sum(label_mask))
        if voxel_count == 0:
            return {
                "status": "error",
                "message": f"No voxels found for label {label_value} in mask.",
            }

        # ------------------------------------------------------------------
        # Compute SUV statistics
        # ------------------------------------------------------------------
        suv_values = pet_data[label_mask].astype(np.float64)
        voxel_vol_ml = float(np.prod(pet_zooms)) / 1000.0
        volume_ml = voxel_count * voxel_vol_ml

        stats = {
            "organ": organ,
            "label_value": label_value,
            "voxel_count": voxel_count,
            "volume_ml": round(volume_ml, 2),
            "suv_mean": round(float(np.mean(suv_values)), 4),
            "suv_max": round(float(np.max(suv_values)), 4),
            "suv_min": round(float(np.min(suv_values)), 4),
            "suv_std": round(float(np.std(suv_values)), 4),
            "suv_median": round(float(np.median(suv_values)), 4),
            "suv_p10": round(float(np.percentile(suv_values, 10)), 4),
            "suv_p25": round(float(np.percentile(suv_values, 25)), 4),
            "suv_p50": round(float(np.percentile(suv_values, 50)), 4),
            "suv_p75": round(float(np.percentile(suv_values, 75)), 4),
            "suv_p90": round(float(np.percentile(suv_values, 90)), 4),
            "tlg": round(float(np.mean(suv_values)) * volume_ml, 4),
        }

        safe_name = organ.replace(" ", "_").replace("/", "_")

        # ------------------------------------------------------------------
        # SUV Histogram
        # ------------------------------------------------------------------
        plots_dir = os.path.join(results_dir, study_uid, "plots")
        os.makedirs(plots_dir, exist_ok=True)
        hist_path = os.path.join(plots_dir, f"suv_histogram_{safe_name}.png")

        try:
            fig, ax = plt.subplots(figsize=(8, 5))
            n_bins = min(50, max(10, voxel_count // 20))
            ax.hist(suv_values, bins=n_bins, color="#4a90d9", edgecolor="white", alpha=0.85)
            ax.axvline(stats["suv_mean"], color="red", linestyle="--", linewidth=1.5,
                       label=f'SUVmean = {stats["suv_mean"]:.2f}')
            ax.axvline(stats["suv_max"], color="darkred", linestyle="-", linewidth=1.5,
                       label=f'SUVmax = {stats["suv_max"]:.2f}')
            ax.set_xlabel("SUV", fontsize=12)
            ax.set_ylabel("Voxel Count", fontsize=12)
            ax.set_title(f"SUV Distribution \u2014 {organ}", fontsize=13)
            ax.legend(fontsize=10)
            ax.grid(axis="y", alpha=0.3)
            fig.tight_layout()
            fig.savefig(hist_path, dpi=150)
            plt.close(fig)
            print(f"Saved SUV histogram: {hist_path}")
        except Exception as exc:
            print(f"Histogram generation failed: {exc}")
            hist_path = None

        # ------------------------------------------------------------------
        # Axial intensity profile through centroid
        # ------------------------------------------------------------------
        profile_path = None
        try:
            coords = np.argwhere(label_mask)
            centroid = coords.mean(axis=0).astype(int)
            cx, cy, cz = int(centroid[0]), int(centroid[1]), int(centroid[2])

            # Axial slice at centroid Z
            axial_slice = pet_data[:, :, cz]
            mask_slice = label_mask[:, :, cz]

            if np.any(mask_slice):
                profile_path = os.path.join(plots_dir, f"axial_profile_{safe_name}.png")
                fig, axes = plt.subplots(1, 2, figsize=(12, 5))

                # Left: axial PET slice with VOI contour
                ax1 = axes[0]
                im = ax1.imshow(axial_slice.T, cmap="hot", origin="lower", aspect="equal")
                # Draw mask contour
                from skimage.measure import find_contours

                contours = find_contours(mask_slice.T.astype(float), 0.5)
                for contour in contours:
                    ax1.plot(contour[:, 1], contour[:, 0], color="cyan", linewidth=1.5)
                ax1.set_title(f"Axial Slice (z={cz}) \u2014 {organ}", fontsize=11)
                plt.colorbar(im, ax=ax1, label="SUV", shrink=0.8)

                # Right: line profile through centroid (horizontal)
                ax2 = axes[1]
                row_profile = axial_slice[:, cy]
                mask_row = mask_slice[:, cy]
                x_range = np.arange(len(row_profile))
                ax2.plot(x_range, row_profile, color="gray", linewidth=0.8, label="Background")
                if np.any(mask_row):
                    ax2.fill_between(x_range, row_profile, where=mask_row,
                                     color="#4a90d9", alpha=0.5, label=organ)
                ax2.set_xlabel("Voxel Index (X)", fontsize=11)
                ax2.set_ylabel("SUV", fontsize=11)
                ax2.set_title(f"Intensity Profile (y={cy}, z={cz})", fontsize=11)
                ax2.legend(fontsize=9)
                ax2.grid(alpha=0.3)

                fig.tight_layout()
                fig.savefig(profile_path, dpi=150)
                plt.close(fig)
                print(f"Saved axial profile: {profile_path}")
        except Exception as exc:
            print(f"Intensity profile generation failed: {exc}")
            profile_path = None

        # ------------------------------------------------------------------
        # Save CSV
        # ------------------------------------------------------------------
        tables_dir = os.path.join(results_dir, study_uid, "tables")
        os.makedirs(tables_dir, exist_ok=True)
        csv_path = os.path.join(tables_dir, f"voi_analysis_{safe_name}.csv")

        try:
            with open(csv_path, "w") as f:
                headers = list(stats.keys())
                f.write(",".join(headers) + "\n")
                f.write(",".join(str(stats[h]) for h in headers) + "\n")
            print(f"Saved CSV: {csv_path}")
        except Exception as exc:
            print(f"CSV save failed: {exc}")
            csv_path = None

        # ------------------------------------------------------------------
        # Build result
        # ------------------------------------------------------------------
        message = (
            f"{organ} VOI analysis: "
            f"SUVmean={stats['suv_mean']:.2f}, SUVmax={stats['suv_max']:.2f}, "
            f"SUVmin={stats['suv_min']:.2f}, SUVstd={stats['suv_std']:.2f}, "
            f"Volume={stats['volume_ml']:.1f}ml, TLG={stats['tlg']:.2f}"
        )

        result = {
            "status": "ok",
            "message": message,
            "stats": stats,
        }
        if csv_path:
            result["csv"] = os.path.relpath(csv_path, results_dir)
        if hist_path:
            result["histogram"] = os.path.relpath(hist_path, results_dir)
        if profile_path:
            result["axial_profile"] = os.path.relpath(profile_path, results_dir)

        return result
