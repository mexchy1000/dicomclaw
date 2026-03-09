"""Image processing utilities: MIP generation and visualization.

Ported from pet_agent/src/image_proc.py with adjusted imports.
"""
from __future__ import annotations

import os

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patheffects as path_effects
import numpy as np
import pydicom
from PIL import Image
from scipy.ndimage import zoom, rotate, label, center_of_mass

from analysis.utils.seg_utils import calculate_suv_factor


# ---------------------------------------------------------------------------
# Isotropic resampling
# ---------------------------------------------------------------------------

def resample_to_isotropic(volume: np.ndarray, spacing, target_spacing: float) -> np.ndarray:
    """Resample *volume* ``(Z, Y, X)`` to isotropic *target_spacing*."""
    zoom_factors = [s / target_spacing for s in spacing]
    return zoom(volume, zoom_factors, order=1)


def resample_mask_to_isotropic(mask: np.ndarray, spacing, target_spacing: float) -> np.ndarray:
    """Resample binary mask with nearest-neighbour interpolation."""
    zoom_factors = [s / target_spacing for s in spacing]
    return zoom(mask, zoom_factors, order=0)


# ---------------------------------------------------------------------------
# MIP generation
# ---------------------------------------------------------------------------

def create_mip(pet_series, output_dir: str, num_angles: int = 36) -> list[str]:
    """Generate *num_angles* MIP images for a PET DicomSeries."""
    os.makedirs(output_dir, exist_ok=True)

    datasets = [pydicom.dcmread(f, force=True) for f in pet_series.files]
    datasets.sort(key=lambda x: float(x.ImagePositionPatient[2]))
    first_ds = datasets[0]

    pixel_spacing = first_ds.PixelSpacing
    if len(datasets) > 1:
        z0 = float(datasets[0].ImagePositionPatient[2])
        z1 = float(datasets[1].ImagePositionPatient[2])
        z_spacing = abs(z1 - z0) or float(first_ds.SliceThickness)
    else:
        z_spacing = float(first_ds.SliceThickness)

    current_spacing = (float(z_spacing), float(pixel_spacing[0]), float(pixel_spacing[1]))
    target_spacing = min(current_spacing)

    slopes = np.array([float(ds.get("RescaleSlope", 1.0)) for ds in datasets], dtype=np.float32)
    intercepts = np.array([float(ds.get("RescaleIntercept", 0.0)) for ds in datasets], dtype=np.float32)

    vol_raw = np.stack([ds.pixel_array for ds in datasets]).astype(np.float32)
    vol_bq = vol_raw * slopes[:, None, None] + intercepts[:, None, None]

    suv_factor = calculate_suv_factor(first_ds)
    if suv_factor is None:
        vol_suv = vol_bq
        suv_max_disp = float(np.max(vol_suv)) * 0.8
    else:
        vol_suv = vol_bq * suv_factor
        suv_max_disp = 10.0

    print(f"Resampling to isotropic spacing: {target_spacing:.2f} mm...")
    vol_suv_iso = resample_to_isotropic(vol_suv, current_spacing, target_spacing)

    vol_disp = np.clip(vol_suv_iso, 0, suv_max_disp)
    vol_iso = (vol_disp / suv_max_disp * 255.0).astype(np.uint8)

    angle_step = 360.0 / num_angles
    generated: list[str] = []

    print(f"Generating {num_angles} MIPs...")
    for i in range(num_angles):
        angle = i * angle_step
        vol_rot = rotate(vol_iso, angle, axes=(1, 2), reshape=False, order=1)
        mip = np.max(vol_rot, axis=1)
        mip = np.flipud(mip)

        img = Image.fromarray(mip.astype(np.uint8))
        fname = f"mip_{int(angle):03d}.png"
        fpath = os.path.join(output_dir, fname)
        img.save(fpath)
        generated.append(fpath)

    return generated


# ---------------------------------------------------------------------------
# Lesion visualization
# ---------------------------------------------------------------------------

def plot_axial_overlay(ct_slice, pet_slice, center_xy, output_path: str, lesion_id: str) -> str:
    """Axial CT+PET overlay with crosshair at lesion centre."""
    fig, ax = plt.subplots(figsize=(6, 6))
    ax.imshow(ct_slice, cmap="gray", interpolation="bilinear")
    pet_norm = np.clip(pet_slice, 0, 10.0) / 10.0
    ax.imshow(pet_norm, cmap="hot", alpha=0.5, interpolation="bilinear")

    cx, cy = center_xy
    ax.plot(cx, cy, "g+", markersize=20, markeredgewidth=2)
    ax.text(5, 10, f"Lesion #{lesion_id}", color="white", fontsize=10, fontweight="bold",
            bbox={"facecolor": "black", "alpha": 0.5, "pad": 2})
    ax.axis("off")
    plt.savefig(output_path, bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    return output_path


def visualize_lesions(pet_data: np.ndarray, mask_data: np.ndarray, spacing,
                      output_dir: str, ct_data: np.ndarray | None = None) -> list[str]:
    """MIP views and axial snapshots.  Expects ``(Y, X, Z)`` input."""
    os.makedirs(output_dir, exist_ok=True)

    # Transpose (Y, X, Z) → (Z, Y, X)
    pet_data = np.transpose(pet_data, (2, 0, 1))
    mask_data = np.transpose(mask_data, (2, 0, 1))
    spacing = (spacing[2], spacing[0], spacing[1])
    if ct_data is not None:
        ct_data = np.transpose(ct_data, (2, 0, 1))

    target_sp = min(spacing)
    pet_iso = resample_to_isotropic(pet_data, spacing, target_sp)
    mask_iso = resample_mask_to_isotropic(mask_data, spacing, target_sp)
    ct_iso = resample_to_isotropic(ct_data, spacing, target_sp) if ct_data is not None else None

    lesion_mask = mask_iso > 0.5
    labeled_arr, n_lesions = label(lesion_mask)

    lesion_stats = []
    for i in range(1, n_lesions + 1):
        lm = labeled_arr == i
        lesion_stats.append({"id": i, "suv_max": float(np.max(pet_iso[lm])), "center": center_of_mass(lm)})
    lesion_stats.sort(key=lambda x: x["suv_max"], reverse=True)
    top = lesion_stats[:10]

    out_files: list[str] = []

    # MIP at 4 angles
    p_min, p_max = 0, max(10.0, float(np.percentile(pet_iso, 99.9)))
    pet_disp = np.clip(pet_iso, p_min, p_max)
    pet_disp = (pet_disp - p_min) / (p_max - p_min)

    for ang in [0, 90, 180, 270]:
        pet_rot = rotate(pet_disp, ang, axes=(1, 2), reshape=False, order=1)
        mip = np.max(pet_rot, axis=1)
        mip = np.flipud(np.fliplr(mip))

        h, w = mip.shape
        dpi = 100
        fig = plt.figure(figsize=(max(4, w / dpi), max(4, h / dpi)))
        ax = plt.Axes(fig, [0.0, 0.0, 1.0, 1.0])
        ax.set_axis_off()
        fig.add_axes(ax)
        ax.imshow(mip, cmap="inferno", aspect="equal")

        cy_c, cx_c = pet_iso.shape[1] / 2, pet_iso.shape[2] / 2
        theta = np.radians(ang)
        cos_t, sin_t = np.cos(theta), np.sin(theta)

        for idx, les in enumerate(top):
            lz, ly, lx = les["center"]
            dx, dy = lx - cx_c, ly - cy_c
            lx_rot = dx * cos_t - dy * sin_t + cx_c
            lz_f = pet_iso.shape[0] - 1 - lz
            lx_f = w - 1 - lx_rot
            ax.plot(lx_f, lz_f, "w+", markersize=15, markeredgewidth=3)
            ax.text(lx_f + 5, lz_f, f"L{idx + 1}", color="white", fontsize=14, fontweight="bold",
                    path_effects=[path_effects.withStroke(linewidth=2, foreground="black")])

        fpath = os.path.join(output_dir, f"lesion_mip_{ang:03d}.png")
        plt.savefig(fpath, dpi=dpi, bbox_inches="tight", pad_inches=0.1)
        plt.close(fig)
        out_files.append(fpath)

    # Mask overlay MIP
    mask_disp = (mask_iso > 0.5).astype(float)
    fig, ax = plt.subplots(figsize=(8, 12))
    mip_pet = np.flipud(np.fliplr(np.max(pet_disp, axis=1)))
    mip_mask = np.flipud(np.fliplr(np.max(mask_disp, axis=1)))
    ax.imshow(mip_pet, cmap="gray", aspect="equal")
    overlay = np.zeros((*mip_mask.shape, 4))
    overlay[mip_mask > 0] = [1, 0, 0, 0.5]
    ax.imshow(overlay, aspect="equal")
    ax.axis("off")
    ax.set_title("AutoPET Mask Overlay (Red)")
    overlay_path = os.path.join(output_dir, "mask_overlay_mip.png")
    plt.savefig(overlay_path, dpi=100, bbox_inches="tight")
    plt.close(fig)
    out_files.append(overlay_path)

    # Axial snapshots
    if ct_iso is not None:
        ct_min_v, ct_max_v = -160, 240
        ct_disp = np.clip(ct_iso, ct_min_v, ct_max_v)
        ct_disp = (ct_disp - ct_min_v) / (ct_max_v - ct_min_v)

        for idx, les in enumerate(top):
            z, y, x = [int(round(c)) for c in les["center"]]
            z = max(0, min(z, ct_iso.shape[0] - 1))
            cs = np.fliplr(np.flipud(ct_disp[z]))
            ps = np.fliplr(np.flipud(pet_iso[z]))
            H, W = cs.shape
            fpath = os.path.join(output_dir, f"lesion_L{idx + 1}_axial.png")
            plot_axial_overlay(cs, ps, (W - 1 - x, H - 1 - y), fpath, f"L{idx + 1}")
            out_files.append(fpath)

    return out_files


# ---------------------------------------------------------------------------
# Organ segmentation overlay
# ---------------------------------------------------------------------------

def visualize_segmentation_overlay(pet_vol: np.ndarray, mask_vol: np.ndarray, spacing,
                                   output_path: str, organ_name: str,
                                   ct_vol: np.ndarray | None = None) -> str:
    """4-panel overlay (Axial, Coronal, Sagittal, MIP) of segmentation on PET."""

    if np.sum(mask_vol) == 0:
        cz = pet_vol.shape[2] // 2
        cy = pet_vol.shape[1] // 2
        cx = pet_vol.shape[0] // 2
    else:
        coords = np.argwhere(mask_vol)
        cx, cy, cz = coords.mean(axis=0).astype(int)

    cz = np.clip(cz, 0, pet_vol.shape[2] - 1)
    cy = np.clip(cy, 0, pet_vol.shape[1] - 1)
    cx = np.clip(cx, 0, pet_vol.shape[0] - 1)

    def get_slices(vol, cx_, cy_, cz_):
        ax = np.fliplr(np.flipud(vol[:, :, cz_].T))
        cor = np.fliplr(np.flipud(vol[:, cy_, :].T))
        sag = np.fliplr(np.flipud(vol[cx_, :, :].T))
        return ax, cor, sag

    pet_ax, pet_cor, pet_sag = get_slices(pet_vol, cx, cy, cz)
    mask_ax, mask_cor, mask_sag = get_slices(mask_vol.astype(float), cx, cy, cz)

    ct_ax = ct_cor = ct_sag = None
    if ct_vol is not None:
        ct_ax, ct_cor, ct_sag = get_slices(ct_vol, cx, cy, cz)

    # MIP
    mip = np.fliplr(np.flipud(np.max(pet_vol, axis=1).T))

    fig, axes = plt.subplots(1, 4, figsize=(20, 5))

    def plot_ov(ax, ct_img, pet_img, mask_img, title):
        if ct_img is not None:
            ct_img = np.clip(ct_img, -160, 240)
            ax.imshow(ct_img, cmap="gray", aspect="equal")
            pet_display = np.ma.masked_where(pet_img < 0.1, pet_img)
            ax.imshow(pet_display, cmap="hot", alpha=0.5, aspect="equal")
        else:
            ax.imshow(pet_img, cmap="hot", aspect="equal")
        if np.max(mask_img) > 0:
            ax.contour(mask_img, colors="lime", linewidths=1.0)
        ax.set_title(title)
        ax.axis("off")

    plot_ov(axes[0], ct_ax, pet_ax, mask_ax, f"Axial (Z={cz})")
    plot_ov(axes[1], ct_cor, pet_cor, mask_cor, f"Coronal (Y={cy})")
    plot_ov(axes[2], ct_sag, pet_sag, mask_sag, f"Sagittal (X={cx})")

    axes[3].imshow(mip, cmap="hot", aspect="equal")
    axes[3].set_title("MIP (Coronal)")
    axes[3].axis("off")

    plt.suptitle(f"Segmentation Check: {organ_name}", fontsize=16)
    plt.tight_layout()
    plt.savefig(output_path, dpi=150)
    plt.close()
    return output_path
