"""Refine lesion VOI masks using SUV threshold criteria.

Workflow:
  1. AutoPET mask identifies lesion locations (seeds) at any resolution.
  2. Each connected component's SUVmax location is found on the original PET.
  3. A SUV cutoff (% of SUVmax or absolute) is applied to the full PET volume.
  4. The connected component in the thresholded PET that contains the SUVmax
     voxel becomes the refined isometabolic VOI — independent of the original
     AutoPET mask boundary.
"""
from __future__ import annotations

import os

import nibabel as nib
import numpy as np
from scipy import ndimage


def refine_lesion_voi(
    pet_path: str,
    mask_path: str,
    threshold_type: str,  # "percent" or "absolute"
    threshold_value: float,
    output_path: str,
) -> str:
    """Refine lesion VOI by SUV-based isometabolic contouring on original PET.

    For each AutoPET-detected lesion:
      1. Find SUVmax location within the seed mask on the original PET.
      2. Compute cutoff = SUVmax * (percent/100) or absolute SUV value.
      3. Threshold the entire PET >= cutoff.
      4. Label connected components; keep only the one containing the SUVmax voxel.

    This allows the VOI to grow or shrink beyond the original AutoPET boundary.

    Args:
        pet_path: Path to original-resolution PET SUV NIfTI.
        mask_path: Path to AutoPET lesion mask NIfTI (seed regions).
        threshold_type: "percent" (% of per-lesion SUVmax) or "absolute" (fixed SUV).
        threshold_value: e.g. 40 for 40%, or 2.5 for SUV 2.5.
        output_path: Where to save refined mask.

    Returns:
        Path to refined mask NIfTI.
    """
    pet_img = nib.as_closest_canonical(nib.load(pet_path))
    pet_data = np.asanyarray(pet_img.dataobj).astype(np.float32)

    mask_img = nib.as_closest_canonical(nib.load(mask_path))
    mask_data = np.asanyarray(mask_img.dataobj)

    # Resample mask to PET grid if shapes differ (e.g. mask still at 4mm)
    if mask_data.shape != pet_data.shape:
        from nibabel.processing import resample_from_to
        mask_resampled = resample_from_to(mask_img, pet_img, order=0)
        mask_data = np.asanyarray(mask_resampled.dataobj)

    # Find seed lesion components from AutoPET mask
    binary_mask = (mask_data > 0).astype(np.int32)
    labeled_seeds, num_seeds = ndimage.label(binary_mask)

    refined = np.zeros(pet_data.shape, dtype=np.int16)
    zooms = pet_img.header.get_zooms()[:3]
    voxel_vol_ml = float(np.prod(zooms)) / 1000.0

    for seed_id in range(1, num_seeds + 1):
        seed_mask = labeled_seeds == seed_id
        pet_in_seed = pet_data[seed_mask]

        if len(pet_in_seed) == 0:
            continue

        suv_max = float(pet_in_seed.max())

        # Find the SUVmax voxel location (use first if multiple)
        suv_max_coords = np.argwhere(seed_mask & (pet_data >= suv_max - 1e-6))
        if len(suv_max_coords) == 0:
            continue
        peak_voxel = tuple(suv_max_coords[0])

        # Compute cutoff
        if threshold_type == "percent":
            cutoff = suv_max * (threshold_value / 100.0)
        else:
            cutoff = threshold_value

        # Threshold the full PET volume
        above_cutoff = pet_data >= cutoff

        # Label connected components in the thresholded volume
        cc_labeled, _ = ndimage.label(above_cutoff)

        # Keep only the component containing the SUVmax voxel
        target_label = cc_labeled[peak_voxel]
        if target_label == 0:
            # SUVmax voxel somehow not above cutoff (shouldn't happen for %)
            # Fall back to seed mask intersection
            fallback = seed_mask & above_cutoff
            refined[fallback] = seed_id
            continue

        voi_mask = cc_labeled == target_label
        refined[voi_mask] = seed_id

        vol_ml = float(np.sum(voi_mask)) * voxel_vol_ml
        print(f"  Lesion {seed_id}: SUVmax={suv_max:.2f}, cutoff={cutoff:.2f}, "
              f"VOI={vol_ml:.1f} ml ({int(np.sum(voi_mask))} voxels)")

    # Save
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    refined_img = nib.Nifti1Image(refined, pet_img.affine, pet_img.header)
    nib.save(refined_img, output_path)

    original_voxels = int(binary_mask.sum())
    refined_voxels = int((refined > 0).sum())
    _, refined_count = ndimage.label(refined > 0)
    print(f"Refined: {original_voxels} → {refined_voxels} voxels "
          f"({num_seeds} seeds → {refined_count} VOIs)")
    print(f"Threshold: {threshold_type} = {threshold_value}, resolution = {zooms}")

    return output_path
