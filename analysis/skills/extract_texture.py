"""Skill: Extract texture features (radiomics) from VOI regions.

Configurable GLCM parameters:
  - glcm_mode: "2d" (slice-averaged) or "3d" (volumetric, slower)
  - bin_count: number of gray levels for quantization (default 32)
  - bin_scale: "absolute" (fixed SUV range 0..bin_max) or "relative" (per-VOI min..max)
  - bin_max: upper SUV bound when bin_scale=absolute (default 20)
"""
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


# ──────────────────────────────────────────────────────────────────────
# Quantization helper
# ──────────────────────────────────────────────────────────────────────

def _quantize(data: np.ndarray, mask: np.ndarray, n_levels: int,
              scale: str, abs_max: float) -> tuple[np.ndarray | None, float, float]:
    """Quantize masked values to [0, n_levels-1].

    Returns (quantized_array_full_shape, vmin, vmax) or (None, 0, 0) on failure.
    """
    vals = data[mask]
    if len(vals) == 0:
        return None, 0.0, 0.0

    if scale == "absolute":
        vmin, vmax = 0.0, abs_max
    else:  # relative
        vmin, vmax = float(np.min(vals)), float(np.max(vals))

    if vmax <= vmin:
        return None, vmin, vmax

    quantized = np.zeros(data.shape, dtype=np.uint8)
    quantized[mask] = np.clip(
        ((data[mask] - vmin) / (vmax - vmin) * (n_levels - 1)).astype(np.uint8),
        0, n_levels - 1,
    )
    return quantized, vmin, vmax


# ──────────────────────────────────────────────────────────────────────
# GLCM — 2D (slice-averaged)
# ──────────────────────────────────────────────────────────────────────

def _compute_glcm_2d(data_3d: np.ndarray, mask_3d: np.ndarray,
                     n_levels: int, scale: str, abs_max: float) -> dict:
    from skimage.feature import graycomatrix, graycoprops

    quantized, vmin, vmax = _quantize(data_3d, mask_3d, n_levels, scale, abs_max)
    if quantized is None:
        return {}

    coords = np.argwhere(mask_3d)
    z_slices = np.unique(coords[:, 2])

    accum = {k: [] for k in ("contrast", "dissimilarity", "homogeneity", "energy", "correlation", "ASM")}

    for z in z_slices:
        mask_2d = mask_3d[:, :, z]
        if np.sum(mask_2d) < 4:
            continue

        rows, cols = np.where(mask_2d)
        r0, r1 = rows.min(), rows.max() + 1
        c0, c1 = cols.min(), cols.max() + 1
        patch = quantized[r0:r1, c0:c1, z].copy()
        mask_patch = mask_2d[r0:r1, c0:c1]
        if patch.shape[0] < 2 or patch.shape[1] < 2:
            continue
        patch[~mask_patch] = 0

        try:
            glcm = graycomatrix(
                patch, distances=[1],
                angles=[0, np.pi / 4, np.pi / 2, 3 * np.pi / 4],
                levels=n_levels, symmetric=True, normed=True,
            )
            for prop in accum:
                accum[prop].append(float(np.mean(graycoprops(glcm, prop))))
        except Exception:
            continue

    if not accum["contrast"]:
        return {}

    return {f"glcm_{k}": round(float(np.mean(v)), 4) for k, v in accum.items() if v}


# ──────────────────────────────────────────────────────────────────────
# GLCM — 3D (volumetric)
# ──────────────────────────────────────────────────────────────────────

def _compute_glcm_3d(data_3d: np.ndarray, mask_3d: np.ndarray,
                     n_levels: int, scale: str, abs_max: float) -> dict:
    """Compute 3D GLCM by building co-occurrence from 13 neighbor directions."""
    quantized, vmin, vmax = _quantize(data_3d, mask_3d, n_levels, scale, abs_max)
    if quantized is None:
        return {}

    # 13 unique 3D neighbor offsets (half of 26-connectivity)
    offsets = [
        (1, 0, 0), (0, 1, 0), (0, 0, 1),
        (1, 1, 0), (1, -1, 0), (1, 0, 1), (1, 0, -1),
        (0, 1, 1), (0, 1, -1),
        (1, 1, 1), (1, 1, -1), (1, -1, 1), (1, -1, -1),
    ]

    glcm = np.zeros((n_levels, n_levels), dtype=np.float64)
    coords = np.argwhere(mask_3d)

    for di, dj, dk in offsets:
        ni = coords[:, 0] + di
        nj = coords[:, 1] + dj
        nk = coords[:, 2] + dk
        valid = (
            (ni >= 0) & (ni < mask_3d.shape[0]) &
            (nj >= 0) & (nj < mask_3d.shape[1]) &
            (nk >= 0) & (nk < mask_3d.shape[2])
        )
        ni, nj, nk = ni[valid], nj[valid], nk[valid]
        src = coords[valid]
        neighbor_in_mask = mask_3d[ni, nj, nk]
        ni, nj, nk = ni[neighbor_in_mask], nj[neighbor_in_mask], nk[neighbor_in_mask]
        src = src[neighbor_in_mask]
        v1 = quantized[src[:, 0], src[:, 1], src[:, 2]]
        v2 = quantized[ni, nj, nk]
        for a, b in zip(v1, v2):
            glcm[a, b] += 1
            glcm[b, a] += 1  # symmetric

    total = glcm.sum()
    if total == 0:
        return {}
    glcm /= total

    # Compute properties from the normalized GLCM
    i_idx, j_idx = np.meshgrid(np.arange(n_levels), np.arange(n_levels), indexing="ij")
    diff = (i_idx - j_idx).astype(float)

    contrast = float(np.sum(glcm * diff ** 2))
    dissimilarity = float(np.sum(glcm * np.abs(diff)))
    homogeneity = float(np.sum(glcm / (1 + diff ** 2)))
    asm = float(np.sum(glcm ** 2))
    energy = float(np.sqrt(asm))

    # Correlation
    mu_i = float(np.sum(i_idx * glcm))
    mu_j = float(np.sum(j_idx * glcm))
    sigma_i = float(np.sqrt(np.sum(glcm * (i_idx - mu_i) ** 2)))
    sigma_j = float(np.sqrt(np.sum(glcm * (j_idx - mu_j) ** 2)))
    if sigma_i > 1e-10 and sigma_j > 1e-10:
        correlation = float(np.sum(glcm * (i_idx - mu_i) * (j_idx - mu_j)) / (sigma_i * sigma_j))
    else:
        correlation = 0.0

    return {
        "glcm_contrast": round(contrast, 4),
        "glcm_dissimilarity": round(dissimilarity, 4),
        "glcm_homogeneity": round(homogeneity, 4),
        "glcm_energy": round(energy, 4),
        "glcm_correlation": round(correlation, 4),
        "glcm_asm": round(asm, 4),
    }


# ──────────────────────────────────────────────────────────────────────
# Shape features
# ──────────────────────────────────────────────────────────────────────

def _compute_shape_features(mask_3d: np.ndarray, voxel_sizes: tuple) -> dict:
    coords = np.argwhere(mask_3d)
    if len(coords) == 0:
        return {}

    voxel_vol = float(np.prod(voxel_sizes))
    n_voxels = int(np.sum(mask_3d))
    volume_mm3 = n_voxels * voxel_vol

    # Surface area — voxel-face method
    padded = np.pad(mask_3d.astype(np.uint8), 1, mode="constant", constant_values=0)
    shifts = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    face_areas = [
        voxel_sizes[1] * voxel_sizes[2], voxel_sizes[1] * voxel_sizes[2],
        voxel_sizes[0] * voxel_sizes[2], voxel_sizes[0] * voxel_sizes[2],
        voxel_sizes[0] * voxel_sizes[1], voxel_sizes[0] * voxel_sizes[1],
    ]
    surface_area = 0.0
    for (di, dj, dk), fa in zip(shifts, face_areas):
        shifted = np.roll(np.roll(np.roll(padded, di, axis=0), dj, axis=1), dk, axis=2)
        boundary = padded.astype(bool) & ~shifted.astype(bool)
        surface_area += float(np.sum(boundary)) * fa

    sphericity = (np.pi ** (1 / 3) * (6 * volume_mm3) ** (2 / 3)) / surface_area if surface_area > 0 else 0.0

    # Elongation / flatness from PCA
    scaled = coords.astype(float) * np.array(voxel_sizes)
    centered = scaled - scaled.mean(axis=0)
    if len(centered) >= 3:
        eigvals = np.sort(np.linalg.eigvalsh(np.cov(centered.T)))[::-1]
        eigvals = np.maximum(eigvals, 1e-10)
        elongation = float(np.sqrt(eigvals[1] / eigvals[0]))
        flatness = float(np.sqrt(eigvals[2] / eigvals[0]))
    else:
        elongation, flatness = 0.0, 0.0

    mins = coords.min(axis=0) * np.array(voxel_sizes)
    maxs = (coords.max(axis=0) + 1) * np.array(voxel_sizes)
    bbox_vol = float(np.prod(maxs - mins))
    compactness = volume_mm3 / bbox_vol if bbox_vol > 0 else 0.0

    return {
        "shape_volume_mm3": round(volume_mm3, 2),
        "shape_surface_area_mm2": round(surface_area, 2),
        "shape_sphericity": round(sphericity, 4),
        "shape_elongation": round(elongation, 4),
        "shape_flatness": round(flatness, 4),
        "shape_compactness": round(compactness, 4),
    }


# ──────────────────────────────────────────────────────────────────────
# First-order features
# ──────────────────────────────────────────────────────────────────────

def _compute_first_order_features(values: np.ndarray) -> dict:
    if len(values) == 0:
        return {}

    mean = float(np.mean(values))
    std = float(np.std(values))

    if std > 1e-10:
        from scipy.stats import skew, kurtosis as kurt_fn
        skewness = float(skew(values))
        kurtosis = float(kurt_fn(values))
    else:
        skewness, kurtosis = 0.0, 0.0

    # Entropy
    hist, _ = np.histogram(values, bins=32, density=True)
    hist = hist[hist > 0]
    bin_width = (values.max() - values.min()) / 32 if values.max() > values.min() else 1.0
    probs = hist * bin_width
    probs = probs[probs > 0]
    entropy = -float(np.sum(probs * np.log2(probs + 1e-15)))

    cv = std / mean if abs(mean) > 1e-10 else 0.0
    iqr = float(np.percentile(values, 75) - np.percentile(values, 25))

    hist_norm, _ = np.histogram(values, bins=32, density=False)
    hist_norm = hist_norm / hist_norm.sum() if hist_norm.sum() > 0 else hist_norm
    uniformity = float(np.sum(hist_norm ** 2))

    return {
        "fo_skewness": round(skewness, 4),
        "fo_kurtosis": round(kurtosis, 4),
        "fo_entropy": round(entropy, 4),
        "fo_cv": round(cv, 4),
        "fo_iqr": round(iqr, 4),
        "fo_uniformity": round(uniformity, 4),
    }


# ──────────────────────────────────────────────────────────────────────
# Skill class
# ──────────────────────────────────────────────────────────────────────

class ExtractTextureSkill(BaseSkill):
    name = "extract_texture"
    description = (
        "Extract radiomics-style texture features from one or more VOIs. "
        "Computes GLCM (contrast, homogeneity, energy, correlation), "
        "shape features (sphericity, elongation, flatness), "
        "and first-order features (skewness, kurtosis, entropy). "
        "Configurable: glcm_mode (2d/3d), bin_count, bin_scale (absolute/relative), bin_max. "
        "IMPORTANT: Always propose_plan first so the user can review/adjust these parameters."
    )
    input_modalities = ["PT"]

    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        study_uid = kwargs.get("study_uid", "")
        mask_path_rel = kwargs.get("mask_path", "")
        labels_raw = kwargs.get("label_values", kwargs.get("label_value", "1"))
        organ = kwargs.get("organ", "voi")

        # ── GLCM configuration ──
        glcm_mode = kwargs.get("glcm_mode", "2d").lower()  # "2d" or "3d"
        bin_count = int(kwargs.get("bin_count", 32))
        bin_scale = kwargs.get("bin_scale", "absolute").lower()  # "absolute" or "relative"
        bin_max = float(kwargs.get("bin_max", 20.0))

        if glcm_mode not in ("2d", "3d"):
            glcm_mode = "2d"
        if bin_scale not in ("absolute", "relative"):
            bin_scale = "absolute"
        bin_count = max(8, min(bin_count, 256))

        if not study_uid:
            return {"status": "error", "message": "study_uid is required."}
        if not mask_path_rel:
            return {"status": "error", "message": "mask_path is required (relative to results_dir)."}

        # Parse label values
        if isinstance(labels_raw, str):
            label_values = [int(x.strip()) for x in labels_raw.split(",") if x.strip()]
        elif isinstance(labels_raw, (list, tuple)):
            label_values = [int(x) for x in labels_raw]
        else:
            label_values = [int(labels_raw)]

        # ── Resolve paths & load PET ──
        intermediate_dir = os.path.join(results_dir, study_uid, "intermediate")
        mask_path_abs = os.path.join(results_dir, mask_path_rel)
        if not os.path.isfile(mask_path_abs):
            return {"status": "error", "message": f"Mask file not found: {mask_path_abs}"}

        pet_nifti_path = os.path.join(intermediate_dir, "pet_3mm_iso.nii.gz")
        if not os.path.isfile(pet_nifti_path):
            pet_nifti_path = os.path.join(intermediate_dir, "pet_suv.nii.gz")
        if not os.path.isfile(pet_nifti_path):
            return {"status": "error", "message": "No PET NIfTI found. Run quantify_lesion or calc_suv first."}

        print(f"Loading PET: {pet_nifti_path}")
        print(f"GLCM config: mode={glcm_mode}, bins={bin_count}, scale={bin_scale}, bin_max={bin_max}")
        pet_img = nib.load(pet_nifti_path)
        pet_data = pet_img.get_fdata()
        pet_zooms = tuple(float(v) for v in pet_img.header.get_zooms()[:3])

        mask_img = nib.load(mask_path_abs)
        mask_data = mask_img.get_fdata()
        if mask_data.shape != pet_data.shape:
            print(f"Resampling mask {mask_data.shape} → PET {pet_data.shape}...")
            from nibabel.processing import resample_from_to
            mask_data = resample_from_to(mask_img, pet_img, order=0).get_fdata()

        # ── Extract features per label ──
        glcm_fn = _compute_glcm_3d if glcm_mode == "3d" else _compute_glcm_2d
        all_features: list[dict] = []

        for lv in label_values:
            label_mask = (mask_data == lv) if np.issubdtype(mask_data.dtype, np.integer) else np.isclose(mask_data, lv)
            n_voxels = int(np.sum(label_mask))
            if n_voxels == 0:
                print(f"Label {lv}: no voxels, skipping.")
                continue

            suv_values = pet_data[label_mask].astype(np.float64)
            print(f"Label {lv}: {n_voxels} voxels, SUVmax={np.max(suv_values):.2f}")

            features: dict = {
                "label": lv,
                "name": f"{organ}_{lv}" if len(label_values) > 1 else organ,
                "voxel_count": n_voxels,
                "suv_mean": round(float(np.mean(suv_values)), 4),
                "suv_max": round(float(np.max(suv_values)), 4),
                "glcm_mode": glcm_mode,
                "bin_count": bin_count,
                "bin_scale": bin_scale,
                "bin_max": bin_max if bin_scale == "absolute" else "N/A",
            }

            features.update(_compute_first_order_features(suv_values))
            features.update(_compute_shape_features(label_mask, pet_zooms))
            features.update(glcm_fn(pet_data, label_mask, bin_count, bin_scale, bin_max))

            all_features.append(features)

        if not all_features:
            return {"status": "error", "message": f"No voxels found for labels {label_values}."}

        # ── Save CSV ──
        tables_dir = os.path.join(results_dir, study_uid, "tables")
        os.makedirs(tables_dir, exist_ok=True)
        safe_name = organ.replace(" ", "_").replace("/", "_")
        csv_path = os.path.join(tables_dir, f"texture_{safe_name}.csv")

        all_keys = list(all_features[0].keys())
        for f in all_features[1:]:
            for k in f:
                if k not in all_keys:
                    all_keys.append(k)

        with open(csv_path, "w") as fh:
            fh.write(",".join(all_keys) + "\n")
            for f in all_features:
                fh.write(",".join(str(f.get(k, "")) for k in all_keys) + "\n")
        print(f"Saved texture CSV: {csv_path}")

        # ── Radar chart ──
        plot_path = None
        plots_dir = os.path.join(results_dir, study_uid, "plots")
        os.makedirs(plots_dir, exist_ok=True)

        try:
            radar_keys = [k for k in [
                "glcm_contrast", "glcm_homogeneity", "glcm_energy",
                "glcm_correlation", "shape_sphericity", "shape_elongation",
                "fo_entropy", "fo_skewness",
            ] if k in all_features[0]]

            if radar_keys:
                fig, ax = plt.subplots(figsize=(8, 8), subplot_kw=dict(polar=True))
                angles = np.linspace(0, 2 * np.pi, len(radar_keys), endpoint=False).tolist()
                angles += angles[:1]

                colors = plt.cm.Set2(np.linspace(0, 1, max(len(all_features), 1)))
                for i, feat in enumerate(all_features):
                    values = [feat.get(k, 0) for k in radar_keys]
                    values += values[:1]
                    ax.plot(angles, values, "o-", linewidth=2, label=feat["name"], color=colors[i])
                    ax.fill(angles, values, alpha=0.15, color=colors[i])

                ax.set_xticks(angles[:-1])
                ax.set_xticklabels([k.replace("glcm_", "").replace("shape_", "").replace("fo_", "")
                                    for k in radar_keys], fontsize=9)
                ax.set_title(f"Texture Features — {organ}\n"
                             f"(GLCM: {glcm_mode.upper()}, bins={bin_count}, scale={bin_scale})",
                             fontsize=12, pad=20)
                ax.legend(loc="upper right", bbox_to_anchor=(1.3, 1.1), fontsize=9)
                fig.tight_layout()
                plot_path = os.path.join(plots_dir, f"texture_radar_{safe_name}.png")
                fig.savefig(plot_path, dpi=150, bbox_inches="tight")
                plt.close(fig)
                print(f"Saved radar chart: {plot_path}")
        except Exception as exc:
            print(f"Radar chart failed: {exc}")

        # ── Summary ──
        config_line = f"Config: GLCM={glcm_mode.upper()}, bins={bin_count}, scale={bin_scale}"
        if bin_scale == "absolute":
            config_line += f" (0–{bin_max} SUV)"

        summaries = [config_line]
        for f in all_features:
            parts = [f"**{f['name']}**: SUVmax={f['suv_max']:.2f}"]
            if "glcm_contrast" in f:
                parts.append(f"GLCM(contrast={f['glcm_contrast']:.2f}, homog={f.get('glcm_homogeneity', 0):.2f})")
            if "shape_sphericity" in f:
                parts.append(f"Shape(spher={f['shape_sphericity']:.2f}, elong={f.get('shape_elongation', 0):.2f})")
            if "fo_entropy" in f:
                parts.append(f"Entropy={f['fo_entropy']:.2f}")
            summaries.append(", ".join(parts))

        result: dict = {
            "status": "ok",
            "message": "\n".join(summaries),
            "features": all_features,
            "csv": os.path.relpath(csv_path, results_dir),
            "config": {
                "glcm_mode": glcm_mode,
                "bin_count": bin_count,
                "bin_scale": bin_scale,
                "bin_max": bin_max,
            },
        }
        if plot_path:
            result["radar_chart"] = os.path.relpath(plot_path, results_dir)

        return result
