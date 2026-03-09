"""Test TotalSegmentator on sample data."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MPLBACKEND"] = "Agg"

from analysis.utils.dicom_utils import scan_directory
from analysis.utils.seg_utils import dicom_to_nifti_mem

import nibabel as nib
import numpy as np


def main():
    # Load CT series from smaller study
    series = scan_directory("data/studies/BreastDx-01-0002")
    ct_series = None
    for uid, s in series.items():
        if s.modality == "CT":
            ct_series = s
            break

    if not ct_series:
        print("No CT series found!")
        return

    print(f"CT series: {ct_series.description}, {len(ct_series.files)} files")
    ct_nifti = dicom_to_nifti_mem(ct_series.files)
    print(f"NIfTI shape: {ct_nifti.shape}, spacing: {ct_nifti.header.get_zooms()}")

    # Run TotalSegmentator
    from totalsegmentator.python_api import totalsegmentator

    print("Running TotalSegmentator for liver (fast mode)...")
    seg_img = totalsegmentator(ct_nifti, roi_subset=["liver"], fast=True)
    mask = seg_img.get_fdata()
    voxels = int(np.sum(mask > 0.5))
    zooms = ct_nifti.header.get_zooms()
    vol_ml = voxels * float(np.prod(zooms)) / 1000.0
    print(f"Liver segmentation: {voxels} voxels, {vol_ml:.1f} ml")

    # Save result
    os.makedirs("results/test_totalseg", exist_ok=True)
    out_path = "results/test_totalseg/liver_mask.nii.gz"
    nib.save(nib.Nifti1Image(mask, ct_nifti.affine), out_path)
    print(f"Saved to {out_path}")
    print("SUCCESS!")


if __name__ == "__main__":
    main()
