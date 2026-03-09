"""Test TotalSegmentator on the larger whole-body study."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MPLBACKEND"] = "Agg"

from analysis.utils.dicom_utils import scan_directory
from analysis.utils.seg_utils import dicom_to_nifti_mem

import nibabel as nib
import numpy as np


def main():
    series = scan_directory("data/studies/BreastDx-01-0005")
    ct_series = None
    for uid, s in series.items():
        if s.modality == "CT":
            print(f"  CT candidate: {s.description}, {len(s.files)} files")
            # Prefer the CAP or STD series (not duplicate)
            if ct_series is None or "CAP" in s.description.upper():
                ct_series = s

    if not ct_series:
        print("No CT series found!")
        return

    print(f"\nUsing CT: {ct_series.description}, {len(ct_series.files)} files")
    ct_nifti = dicom_to_nifti_mem(ct_series.files)
    print(f"NIfTI shape: {ct_nifti.shape}, spacing: {ct_nifti.header.get_zooms()}")

    from totalsegmentator.python_api import totalsegmentator

    print("\nRunning TotalSegmentator for liver (fast mode)...")
    seg_img = totalsegmentator(ct_nifti, roi_subset=["liver"], fast=True)
    mask = seg_img.get_fdata()
    voxels = int(np.sum(mask > 0.5))
    zooms = ct_nifti.header.get_zooms()
    vol_ml = voxels * float(np.prod(zooms)) / 1000.0
    print(f"\nLiver: {voxels} voxels, {vol_ml:.1f} ml")

    os.makedirs("results/test_totalseg", exist_ok=True)
    out_path = "results/test_totalseg/liver_mask_wb.nii.gz"
    nib.save(nib.Nifti1Image(mask, ct_nifti.affine), out_path)
    print(f"Saved to {out_path}")

    if voxels > 0:
        print("SUCCESS - Liver detected!")
    else:
        print("WARNING - No liver voxels detected (may be outside field of view)")


if __name__ == "__main__":
    main()
