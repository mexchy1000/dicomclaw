"""Generate multi-view snapshots centered on a specific VOI (label) for VLM interpretation."""
from __future__ import annotations

import os
from pathlib import Path

import nibabel as nib
import numpy as np


def generate_voi_snapshots(
    pet_nifti: str,
    ct_nifti: str,
    mask_nifti: str,
    label_value: int,
    output_dir: str,
) -> list[str]:
    """Generate axial/coronal/sagittal + MIP snapshots centered on a VOI label.

    Returns list of saved PNG paths.
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    os.makedirs(output_dir, exist_ok=True)

    mask_img = nib.as_closest_canonical(nib.load(mask_nifti))
    mask_data = np.asanyarray(mask_img.dataobj)

    pet_img = nib.as_closest_canonical(nib.load(pet_nifti))
    pet_data = np.asanyarray(pet_img.dataobj).astype(np.float32)

    ct_img = nib.as_closest_canonical(nib.load(ct_nifti))
    ct_data = np.asanyarray(ct_img.dataobj).astype(np.float32)

    # Find centroid of specified label
    label_mask = mask_data == label_value
    if not label_mask.any():
        return []

    coords = np.argwhere(label_mask)
    centroid = coords.mean(axis=0).astype(int)
    cx, cy, cz = centroid

    paths: list[str] = []

    def save_slice(name: str, ct_slice: np.ndarray, pet_slice: np.ndarray, mask_slice: np.ndarray):
        fig, ax = plt.subplots(1, 1, figsize=(4, 4), dpi=100)
        # CT base
        ax.imshow(ct_slice.T, cmap="gray", origin="lower", vmin=-200, vmax=300)
        # PET overlay
        pet_masked = np.ma.masked_where(pet_slice < 0.5, pet_slice)
        ax.imshow(pet_masked.T, cmap="hot", origin="lower", alpha=0.5, vmin=0, vmax=max(5, pet_slice.max()))
        # Mask contour
        if mask_slice.any():
            ax.contour(mask_slice.T, levels=[0.5], colors=["cyan"], linewidths=1, origin="lower")
        ax.set_title(name, fontsize=10, color="white")
        ax.axis("off")
        fig.patch.set_facecolor("black")
        p = os.path.join(output_dir, f"voi_{label_value}_{name.lower()}.png")
        fig.savefig(p, bbox_inches="tight", facecolor="black", pad_inches=0.1)
        plt.close(fig)
        paths.append(p)

    # Axial (Z slice)
    z = min(cz, ct_data.shape[2] - 1)
    save_slice("Axial", ct_data[:, :, z], pet_data[:, :, z], label_mask[:, :, z])

    # Coronal (Y slice)
    y = min(cy, ct_data.shape[1] - 1)
    save_slice("Coronal", ct_data[:, y, :], pet_data[:, y, :], label_mask[:, y, :])

    # Sagittal (X slice)
    x = min(cx, ct_data.shape[0] - 1)
    save_slice("Sagittal", ct_data[x, :, :], pet_data[x, :, :], label_mask[x, :, :])

    # MIP with lesion highlight
    fig, ax = plt.subplots(1, 1, figsize=(3, 6), dpi=100)
    mip = pet_data.max(axis=1)  # coronal MIP
    ax.imshow(mip.T, cmap="hot", origin="lower", vmin=0, vmax=max(5, mip.max()))
    # Highlight lesion region in MIP
    lesion_proj = label_mask.any(axis=1).astype(float)
    if lesion_proj.any():
        ax.contour(lesion_proj.T, levels=[0.5], colors=["cyan"], linewidths=1.5, origin="lower")
    ax.set_title(f"MIP (VOI {label_value})", fontsize=10, color="white")
    ax.axis("off")
    fig.patch.set_facecolor("black")
    p = os.path.join(output_dir, f"voi_{label_value}_mip.png")
    fig.savefig(p, bbox_inches="tight", facecolor="black", pad_inches=0.1)
    plt.close(fig)
    paths.append(p)

    return paths
