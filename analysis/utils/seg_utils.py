"""SUV calculation, DICOM-to-NIfTI conversion, and segmentation helpers.

Ported from pet_agent/src/seg_utils.py with adjusted imports.
"""
from __future__ import annotations

import datetime
import math
import os
import tempfile

import nibabel as nib
import numpy as np
import pydicom
from scipy.ndimage import zoom


# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def imreslice(subj_array: np.ndarray, origzoom, targetzoom, order: int = 3) -> np.ndarray:
    """Resample a 3-D volume given original and target voxel spacings."""
    zoom_factors = [origzoom[i] / targetzoom[i] for i in range(3)]
    return zoom(subj_array, zoom_factors, order=order)


def shape_matching(im: np.ndarray, size: tuple) -> np.ndarray:
    """Pad or crop *im* to match *size* (3-D)."""
    sz = im.shape

    # X
    if sz[0] > size[0]:
        xs = int(math.ceil(sz[0] / 2) - int(size[0] / 2 - 1))
        im = im[xs - 1: xs + size[0] - 1, :, :]
    else:
        pb = int(math.floor(size[0] / 2 - sz[0] / 2))
        pa = int(math.ceil(size[0] / 2 - sz[0] / 2))
        im = np.pad(im, ((pb, pa), (0, 0), (0, 0)), "constant")

    # Y
    if im.shape[1] > size[1]:
        ys = int(math.ceil(im.shape[1] / 2) - int(size[1] / 2 - 1))
        im = im[:, ys - 1: ys + size[1] - 1, :]
    else:
        pb = int(math.floor(size[1] / 2 - im.shape[1] / 2))
        pa = int(math.ceil(size[1] / 2 - im.shape[1] / 2))
        im = np.pad(im, ((0, 0), (pb, pa), (0, 0)), "constant")

    # Z
    if im.shape[2] > size[2]:
        zs = int(math.ceil(im.shape[2] / 2) - int(size[2] / 2 - 1))
        im = im[:, :, zs - 1: zs + size[2] - 1]
    else:
        pb = int(math.floor(size[2] / 2 - im.shape[2] / 2))
        pa = int(math.ceil(size[2] / 2 - im.shape[2] / 2))
        im = np.pad(im, ((0, 0), (0, 0), (pb, pa)), "constant")

    return im


# ---------------------------------------------------------------------------
# SUV
# ---------------------------------------------------------------------------

def calculate_suv_factor(ds) -> float | None:
    """Return SUV conversion factor from a PET DICOM header.

    When ``DecayCorrection == "START"`` the pixel values are already
    decay-corrected to the series reference time, so we must use
    ``SeriesTime`` (not per-frame ``AcquisitionTime``) as the reference
    for dose-decay calculation.  Using ``AcquisitionTime`` in that case
    would introduce a per-bed-position error of up to ~8 % for whole-body
    PET scans.

    Usage::

        pixels_bq = raw * RescaleSlope + RescaleIntercept
        suv = pixels_bq * suv_factor
    """
    try:
        if ds is None:
            return None

        weight_kg = float(ds.PatientWeight) if "PatientWeight" in ds else 75.0

        if "RadiopharmaceuticalInformationSequence" not in ds:
            print("Missing RadiopharmaceuticalInformationSequence")
            return None

        rad_seq = ds.RadiopharmaceuticalInformationSequence[0]
        total_dose = float(rad_seq.RadionuclideTotalDose)
        half_life = float(rad_seq.RadionuclideHalfLife)
        start_time_str = str(rad_seq.RadiopharmaceuticalStartTime)

        # When DecayCorrection=START, pixel values are already corrected to
        # the series reference time → use SeriesTime for dose-decay calc.
        decay_correction = str(getattr(ds, "DecayCorrection", "")).strip().upper()
        if decay_correction == "START" and "SeriesTime" in ds:
            acq_time_str = str(ds.SeriesTime)
        elif "AcquisitionTime" in ds:
            acq_time_str = str(ds.AcquisitionTime)
        elif "SeriesTime" in ds:
            acq_time_str = str(ds.SeriesTime)
        else:
            print("Missing Time info")
            return None

        fmt = "%H%M%S"
        start_time = datetime.datetime.strptime(start_time_str.split(".")[0], fmt)
        acq_time = datetime.datetime.strptime(acq_time_str.split(".")[0], fmt)

        delta_t = (acq_time - start_time).total_seconds()
        if delta_t < 0:
            delta_t += 24 * 3600

        decayed_dose = total_dose * (0.5 ** (delta_t / half_life))
        return (weight_kg * 1000.0) / decayed_dose

    except Exception as exc:
        print(f"Error calculating SUV factor: {exc}")
        return None


# ---------------------------------------------------------------------------
# DICOM → NIfTI
# ---------------------------------------------------------------------------

def dicom_to_nifti_mem(dicom_files: list[str]) -> nib.Nifti1Image:
    """In-memory DICOM series → NIfTI with LPS→RAS conversion.

    Returns an image with data shape ``(X, Y, Z)`` and a proper RAS affine.
    """
    datasets = [pydicom.dcmread(f, force=True) for f in dicom_files]
    datasets.sort(key=lambda x: float(x.ImagePositionPatient[2]))

    if len(datasets) > 1:
        z0 = float(datasets[0].ImagePositionPatient[2])
        z1 = float(datasets[1].ImagePositionPatient[2])
        if z0 > z1:
            datasets.reverse()

    slopes = np.array([float(ds.get("RescaleSlope", 1.0)) for ds in datasets], dtype=np.float32)
    intercepts = np.array([float(ds.get("RescaleIntercept", 0.0)) for ds in datasets], dtype=np.float32)

    pixel_data = np.stack([ds.pixel_array for ds in datasets]).astype(np.float32)
    pixel_data = pixel_data * slopes[:, None, None] + intercepts[:, None, None]

    # (Z, Y, X) → (X, Y, Z)
    pixel_data = np.transpose(pixel_data, (2, 1, 0))

    ps = datasets[0].PixelSpacing
    y_spacing = float(ps[0])
    x_spacing = float(ps[1])

    if len(datasets) > 1:
        z0 = float(datasets[0].ImagePositionPatient[2])
        z1 = float(datasets[1].ImagePositionPatient[2])
        z_spacing = abs(z1 - z0)
        if z_spacing < 0.01:
            z_spacing = float(datasets[0].get("SliceThickness", 1.0))
    else:
        z_spacing = float(datasets[0].get("SliceThickness", 1.0))
    if z_spacing == 0:
        z_spacing = 1.0

    # LPS → RAS affine
    origin = np.array(datasets[0].ImagePositionPatient, dtype=float)
    origin[0] = -origin[0]
    origin[1] = -origin[1]

    iop = datasets[0].ImageOrientationPatient
    r_vec = np.array(iop[0:3], dtype=float)
    c_vec = np.array(iop[3:6], dtype=float)
    r_vec[0], r_vec[1] = -r_vec[0], -r_vec[1]
    c_vec[0], c_vec[1] = -c_vec[0], -c_vec[1]
    r_vec /= np.linalg.norm(r_vec)
    c_vec /= np.linalg.norm(c_vec)

    affine = np.eye(4)
    affine[:3, 0] = r_vec * x_spacing
    affine[:3, 1] = c_vec * y_spacing

    if len(datasets) > 1:
        pos0 = np.array(datasets[0].ImagePositionPatient, dtype=float)
        pos1 = np.array(datasets[1].ImagePositionPatient, dtype=float)
        slice_vec = pos1 - pos0
        slice_vec[0] = -slice_vec[0]
        slice_vec[1] = -slice_vec[1]
        affine[:3, 2] = slice_vec
    else:
        s_vec = np.cross(r_vec, c_vec)
        affine[:3, 2] = s_vec * z_spacing

    affine[:3, 3] = origin
    return nib.Nifti1Image(pixel_data, affine)


# ---------------------------------------------------------------------------
# Physical bounding box
# ---------------------------------------------------------------------------

def get_physical_bbox(shape, affine):
    """Return ``(min_coords, max_coords)`` of a volume's physical extent."""
    corners = [
        [0, 0, 0], [shape[0], 0, 0], [0, shape[1], 0], [0, 0, shape[2]],
        [shape[0], shape[1], 0], [shape[0], 0, shape[2]],
        [0, shape[1], shape[2]], [shape[0], shape[1], shape[2]],
    ]
    phys = np.array([np.dot(affine, np.array(c + [1]))[:3] for c in corners])
    return phys.min(axis=0), phys.max(axis=0)


# ---------------------------------------------------------------------------
# Organ SUV (TotalSegmentator)
# ---------------------------------------------------------------------------

def get_organ_suv(ct_series, pet_series, organ_name: str, output_dir: str | None = None) -> dict:
    """Segment *organ_name* on CT via TotalSegmentator and compute SUV stats.

    SUV statistics are computed on the **original-resolution** PET volume
    (not the resampled union canvas) to preserve peak accuracy.  The CT-space
    segmentation mask is resampled to the PET grid with nearest-neighbour.
    """
    from nibabel.processing import resample_from_to
    from totalsegmentator.python_api import totalsegmentator

    pet_header = pet_series.get_header()
    suv_factor = calculate_suv_factor(pet_header)
    if suv_factor is None:
        raise ValueError("Could not calculate SUV factor from PET headers.")

    ct_nifti = dicom_to_nifti_mem(ct_series.files)
    pet_nifti = dicom_to_nifti_mem(pet_series.files)

    # Original-resolution PET SUV
    pet_suv_data = pet_nifti.get_fdata() * suv_factor
    pet_zooms = np.array(pet_nifti.header.get_zooms()[:3])
    pet_voxel_vol = float(np.prod(pet_zooms)) / 1000.0
    print(f"  Original PET: shape={pet_nifti.shape}, zooms={pet_zooms.round(2)}, SUV factor={suv_factor:.8f}")

    # Segment on high-res CT
    print(f"Running TotalSegmentator for {organ_name}...")
    try:
        seg_img = totalsegmentator(ct_nifti, roi_subset=[organ_name])
        mask_data_highres = seg_img.get_fdata() > 0.5
    except Exception as exc:
        print(f"TotalSegmentator failed: {exc}")
        return {"mean": 0.0, "max": 0.0}

    # Resample mask from CT space → original PET space (nearest-neighbour)
    mask_ct_nifti = nib.Nifti1Image(mask_data_highres.astype(np.float32), ct_nifti.affine)
    mask_pet_img = resample_from_to(mask_ct_nifti, pet_nifti, order=0)
    mask_pet = mask_pet_img.get_fdata() > 0.5
    print(f"  Mask resampled to PET space: {np.sum(mask_pet)} voxels")

    if not np.any(mask_pet):
        print(f"Organ {organ_name} not found in segmentation.")
        return {"mean": 0.0, "max": 0.0}

    organ_values = pet_suv_data[mask_pet]
    volume_ml = float(np.sum(mask_pet)) * pet_voxel_vol

    # Visualization (uses union canvas for nice alignment)
    if output_dir:
        try:
            from analysis.utils.image_proc import visualize_segmentation_overlay

            target_spacing = (3.0, 3.0, 3.0)
            ct_min, ct_max = get_physical_bbox(ct_nifti.shape, ct_nifti.affine)
            pet_min, pet_max = get_physical_bbox(pet_nifti.shape, pet_nifti.affine)
            union_min = np.minimum(ct_min, pet_min)
            union_max = np.maximum(ct_max, pet_max)
            extent_size = union_max - union_min
            new_shape = np.ceil(extent_size / np.array(target_spacing)).astype(int)
            union_affine = np.diag([*target_spacing, 1.0])
            union_affine[:3, 3] = union_min

            ct_union_img = resample_from_to(ct_nifti, (new_shape, union_affine), order=1)
            pet_union_img = resample_from_to(pet_nifti, (new_shape, union_affine), order=1)
            mask_union_img = resample_from_to(mask_ct_nifti, (new_shape, union_affine), order=0)

            ct_viz = nib.as_closest_canonical(ct_union_img).get_fdata()
            pet_viz = nib.as_closest_canonical(pet_union_img).get_fdata() * suv_factor
            mask_viz = nib.as_closest_canonical(mask_union_img).get_fdata() > 0.5

            os.makedirs(output_dir, exist_ok=True)
            ts = datetime.datetime.now().strftime("%H%M%S")
            fpath = os.path.join(output_dir, f"{organ_name}_seg_check_{ts}.png")
            visualize_segmentation_overlay(pet_viz, mask_viz, target_spacing, fpath, organ_name, ct_vol=ct_viz)
            print(f"Saved seg check: {fpath}")
        except Exception as exc:
            print(f"Viz failed: {exc}")

    # Save mask NIfTI for viewer overlay
    mask_nifti_path = None
    if output_dir:
        intermediate_dir = os.path.join(os.path.dirname(output_dir), "intermediate")
        os.makedirs(intermediate_dir, exist_ok=True)
        mask_nifti_path = os.path.join(intermediate_dir, f"seg_{organ_name}.nii.gz")
        nib.save(nib.Nifti1Image(mask_data_highres.astype(np.int16), ct_nifti.affine), mask_nifti_path)

    return {
        "mean": float(np.mean(organ_values)),
        "max": float(np.max(organ_values)),
        "std": float(np.std(organ_values)),
        "volume_ml": volume_ml,
        "mask_path": mask_nifti_path,
    }


# ---------------------------------------------------------------------------
# Heuristic lesion analysis
# ---------------------------------------------------------------------------

def analyze_lesions_quantitative(ct_series, pet_series, tracer: str = "FDG") -> dict:
    """Detect lesions by SUV thresholding with physiological exclusion."""
    from scipy.ndimage import label
    from totalsegmentator.python_api import totalsegmentator

    pet_header = pet_series.get_header()
    suv_factor = calculate_suv_factor(pet_header)
    if suv_factor is None:
        return {"error": "SUV factor calculation failed"}

    ct_nifti = dicom_to_nifti_mem(ct_series.files)
    pet_nifti = dicom_to_nifti_mem(pet_series.files)

    ct_data = ct_nifti.get_fdata()
    pet_data = pet_nifti.get_fdata()

    zoom_factors = [c / p for c, p in zip(ct_data.shape, pet_data.shape)]
    pet_resampled = zoom(pet_data, zoom_factors, order=1)
    pet_suv_vol = pet_resampled * suv_factor

    exclude_organs: list[str] = []
    if tracer.upper() == "FDG":
        exclude_organs = ["brain", "heart", "urinary_bladder", "kidney_right",
                          "kidney_left", "stomach", "liver"]

    print(f"Segmenting organs to exclude: {exclude_organs}...")
    try:
        ts_img = totalsegmentator(ct_nifti, roi_subset=exclude_organs)
        mask_data = ts_img.get_fdata()
        exclusion_mask = (np.max(mask_data, axis=3) if mask_data.ndim == 4 else mask_data) > 0.5
    except Exception as exc:
        print(f"TotalSegmentator warning: {exc}. Proceeding without exclusion.")
        exclusion_mask = np.zeros_like(pet_suv_vol, dtype=bool)

    body_mask = ct_data > -500
    candidate_mask = (pet_suv_vol > 2.5) & (~exclusion_mask) & body_mask

    labeled_array, num_features = label(candidate_mask)
    zooms = ct_nifti.header.get_zooms()
    voxel_vol_ml = float(np.prod(zooms)) / 1000.0

    lesions = []
    for i in range(1, num_features + 1):
        lmask = labeled_array == i
        mtv = np.sum(lmask) * voxel_vol_ml
        if mtv < 1.0:
            continue
        vals = pet_suv_vol[lmask]
        coords = np.argwhere(lmask)
        center = coords.mean(axis=0).astype(int)
        lesions.append({
            "id": i,
            "suv_max": float(np.max(vals)),
            "suv_mean": float(np.mean(vals)),
            "mtv_ml": float(mtv),
            "tlg": float(np.mean(vals) * mtv),
            "location_voxel": center.tolist(),
        })

    lesions.sort(key=lambda x: x["suv_max"], reverse=True)
    return {"tracer": tracer, "lesion_count": len(lesions), "lesions": lesions[:5]}


# ---------------------------------------------------------------------------
# Save PET as SUV NIfTI
# ---------------------------------------------------------------------------

def save_pet_as_suv_nifti(pet_series, output_path: str) -> str | None:
    """Convert a PET DicomSeries to SUV NIfTI and save to *output_path*."""
    try:
        pet_header = pet_series.get_header()
        suv_factor = calculate_suv_factor(pet_header)
        pet_nifti = dicom_to_nifti_mem(pet_series.files)
        suv_data = pet_nifti.get_fdata() * (suv_factor or 1.0)
        nib.save(nib.Nifti1Image(suv_data, pet_nifti.affine, pet_nifti.header), output_path)
        return output_path
    except Exception as exc:
        print(f"Error saving SUV NIfTI: {exc}")
        return None
