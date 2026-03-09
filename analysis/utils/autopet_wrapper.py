"""AutoPET-3 inference wrapper using nnUNet.

Ported from pet_agent/src/autopet_wrapper.py with adjusted imports.
Includes threshold-based fallback when no model weights are available.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

import nibabel as nib
import numpy as np

from analysis.utils.seg_utils import (
    calculate_suv_factor,
    dicom_to_nifti_mem,
    get_physical_bbox,
    shape_matching,
)


def find_model_path(weights_dir: str) -> str | None:
    """Find a valid nnUNet model folder inside weights_dir."""
    if not os.path.exists(weights_dir):
        return None
    for root, dirs, _files in os.walk(weights_dir):
        if "fold_0" in dirs or "fold_all" in dirs:
            return root
    return None


def run_autopet_inference(ct_series, pet_series, output_dir: str, weights_dir: str) -> str | None:
    """Run AutoPET-3 inference on a PET/CT pair using a 4 mm union canvas.

    Returns path to the output lesion mask NIfTI, or ``None`` on failure.
    Falls back to threshold-based detection if no model weights are found.
    """
    from nibabel.processing import resample_from_to

    # Clean previous results to ensure fresh inference
    for old_name in ["lesion_mask.nii.gz", "lesion_mask_3mm.nii.gz", "lesion_mask_labeled.nii.gz", "pet_suv.nii.gz"]:
        old_file = os.path.join(output_dir, old_name)
        if os.path.exists(old_file):
            os.remove(old_file)
            print(f"Removed previous: {old_file}")

    temp_input = os.path.join(output_dir, "temp_input")
    temp_output = os.path.join(output_dir, "temp_output")
    os.makedirs(temp_input, exist_ok=True)
    os.makedirs(temp_output, exist_ok=True)
    case_id = "test_case"

    target_spacing = (4.0, 4.0, 4.0)

    # 1. Load high-res NIfTI
    ct_nifti_raw = dicom_to_nifti_mem(ct_series.files)
    pet_nifti_raw = dicom_to_nifti_mem(pet_series.files)

    pet_header = pet_series.get_header()
    suv_factor = calculate_suv_factor(pet_header) or 1.0

    # 2. Union extent
    ct_min, ct_max = get_physical_bbox(ct_nifti_raw.shape, ct_nifti_raw.affine)
    pet_min, pet_max = get_physical_bbox(pet_nifti_raw.shape, pet_nifti_raw.affine)
    union_min = np.minimum(ct_min, pet_min)
    union_max = np.maximum(ct_max, pet_max)

    extent_size = union_max - union_min
    new_shape = np.ceil(extent_size / np.array(target_spacing)).astype(int)

    union_affine = np.diag([*target_spacing, 1.0])
    union_affine[:3, 3] = union_min

    print(f"Union Shape: {new_shape}")

    # 3. Resample
    ct_res = resample_from_to(ct_nifti_raw, (new_shape, union_affine), order=1)
    pet_res = resample_from_to(pet_nifti_raw, (new_shape, union_affine), order=1)

    ct_data = ct_res.get_fdata()
    pet_data = pet_res.get_fdata() * suv_factor

    # Save intermediate NIfTI
    final_ct_path = os.path.join(output_dir, "ct_3mm_iso.nii.gz")
    final_pet_path = os.path.join(output_dir, "pet_3mm_iso.nii.gz")
    nib.save(nib.Nifti1Image(ct_data, union_affine), final_ct_path)
    nib.save(nib.Nifti1Image(pet_data, union_affine), final_pet_path)

    # 4. Check for model weights
    model_path = find_model_path(weights_dir)

    if model_path is None:
        print("No nnUNet model weights found. Using threshold-based lesion detection.")
        mask = threshold_based_lesion_detection(pet_data, ct_data)
        fallback_path = os.path.join(output_dir, "lesion_mask_3mm.nii.gz")
        nib.save(nib.Nifti1Image(mask.astype(np.float32), union_affine), fallback_path)
        return fallback_path

    # nnUNet input
    nib.save(nib.Nifti1Image(ct_data, union_affine), os.path.join(temp_input, f"{case_id}_0000.nii.gz"))
    nib.save(nib.Nifti1Image(pet_data, union_affine), os.path.join(temp_input, f"{case_id}_0001.nii.gz"))

    print(f"Running nnUNet inference (Model: {model_path})...")

    # 5. Run inference
    os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:128"
    os.environ["TORCH_COMPILE_DISABLE"] = "1"

    # Ensure autopet repo is in sys.path for custom trainer
    autopet_repo_path = os.getenv("AUTOPET_REPO_PATH", "/home/elicer/autopet_repo")
    if os.path.exists(autopet_repo_path) and autopet_repo_path not in sys.path:
        sys.path.insert(0, autopet_repo_path)

    success = False
    try:
        import torch
        from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

        # Import custom trainer (required for AutoPET-3 model)
        try:
            import nnunetv2.training.nnUNetTrainer.autoPET3_Trainer  # noqa: F401
            print("Loaded autoPET3_Trainer successfully.")
        except ImportError:
            print("Warning: autoPET3_Trainer not found. Inference may fail.")

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Using device: {device}")

        predictor = nnUNetPredictor(
            tile_step_size=0.5, use_gaussian=True, use_mirroring=False,
            perform_everything_on_device=True, device=device,
            verbose=False, verbose_preprocessing=False, allow_tqdm=True,
        )

        # Match reference: use fold_all or fold_0 (single fold for memory efficiency)
        if os.path.exists(os.path.join(model_path, "fold_all")):
            folds = ["all"]
        else:
            folds = [0]
        print(f"Using folds: {folds}")
        predictor.initialize_from_trained_model_folder(model_path, use_folds=folds,
                                                        checkpoint_name="checkpoint_final.pth")
        predictor.predict_from_files(
            list_of_lists_or_source_folder=temp_input,
            output_folder_or_list_of_truncated_output_files=temp_output,
            save_probabilities=False, overwrite=True,
            num_processes_preprocessing=1, num_processes_segmentation_export=1,
            folder_with_segs_from_prev_stage=None, num_parts=1, part_id=0,
        )
        success = True
    except Exception as exc:
        print(f"GPU inference failed: {exc}. Trying CPU subprocess fallback...")
        import traceback
        traceback.print_exc()
        try:
            cmd_cpu = [
                "nnUNetv2_predict_from_modelfolder",
                "-i", temp_input, "-o", temp_output, "-m", model_path,
                "--disable_tta", "-npp", "1", "-nps", "1",
                "-f", "all" if os.path.exists(os.path.join(model_path, "fold_all")) else "0",
                "-device", "cpu",
            ]
            subprocess.run(cmd_cpu, check=True, env=os.environ.copy())
            success = True
        except Exception as cpu_exc:
            print(f"CPU fallback also failed: {cpu_exc}. Using threshold-based detection.")
            mask = threshold_based_lesion_detection(pet_data, ct_data)
            fallback_path = os.path.join(output_dir, "lesion_mask_3mm.nii.gz")
            nib.save(nib.Nifti1Image(mask.astype(np.float32), union_affine), fallback_path)
            return fallback_path

    out_file = os.path.join(temp_output, f"{case_id}.nii.gz")
    if not os.path.exists(out_file):
        print("nnUNet produced no output. Using threshold-based fallback.")
        mask = threshold_based_lesion_detection(pet_data, ct_data)
        fallback_path = os.path.join(output_dir, "lesion_mask_3mm.nii.gz")
        nib.save(nib.Nifti1Image(mask.astype(np.float32), union_affine), fallback_path)
        return fallback_path

    final_output = os.path.join(output_dir, "lesion_mask_3mm.nii.gz")
    shutil.copy(out_file, final_output)

    # Cleanup temp
    try:
        shutil.rmtree(temp_input)
        shutil.rmtree(temp_output)
    except OSError:
        pass

    return final_output


def threshold_based_lesion_detection(pet_data: np.ndarray, ct_data: np.ndarray | None = None,
                                      suv_threshold: float = 2.5, min_volume_ml: float = 0.5,
                                      voxel_size_mm: float = 4.0) -> np.ndarray:
    """Simple threshold-based lesion detection as fallback when no nnUNet model is available.

    Uses SUV > threshold with connected component analysis and size filtering.
    Optionally masks out bone (CT > 300 HU) to reduce false positives.
    """
    from scipy.ndimage import label, binary_erosion, binary_dilation

    # Basic SUV threshold
    mask = pet_data > suv_threshold

    # Exclude bone regions if CT is available (CT > 300 HU likely bone)
    if ct_data is not None:
        bone_mask = ct_data > 300
        mask = mask & ~bone_mask

    # Morphological cleanup
    mask = binary_erosion(mask, iterations=1)
    mask = binary_dilation(mask, iterations=1)

    # Connected component analysis and size filtering
    labeled_arr, n_components = label(mask)
    voxel_vol_ml = (voxel_size_mm ** 3) / 1000.0

    clean_mask = np.zeros_like(mask)
    for i in range(1, n_components + 1):
        component = labeled_arr == i
        vol_ml = float(np.sum(component)) * voxel_vol_ml
        if vol_ml >= min_volume_ml:
            clean_mask |= component

    return clean_mask.astype(np.uint8)


def analyze_prediction_mask(mask_path: str, pet_series=None, ct_series=None) -> dict | str:
    """Analyse an AutoPET-3 prediction mask.

    SUV statistics are computed on the **original-resolution** PET volume
    (not the resampled 4 mm isotropic used for inference) to avoid peak
    smoothing from trilinear interpolation.  The low-res mask is resampled
    to the original PET space with nearest-neighbour interpolation.
    """
    from nibabel.processing import resample_from_to
    from scipy.ndimage import label

    if not mask_path or not os.path.exists(mask_path):
        return "No mask found."

    output_dir = os.path.dirname(mask_path)

    mask_img = nib.load(mask_path)
    mask_data = mask_img.get_fdata()

    # ── Build original-resolution PET SUV volume ──
    # Prefer building from DICOM (accurate SUV factor) over cached NIfTI
    pet_suv_img: nib.Nifti1Image | None = None
    if pet_series is not None:
        try:
            pet_nifti_raw = dicom_to_nifti_mem(pet_series.files)
            pet_header = pet_series.get_header()
            suv_factor = calculate_suv_factor(pet_header) or 1.0
            suv_data = pet_nifti_raw.get_fdata() * suv_factor
            pet_suv_img = nib.Nifti1Image(suv_data.astype(np.float32), pet_nifti_raw.affine)
            print(f"  Using original-resolution PET: {pet_suv_img.shape}, "
                  f"zooms={np.array(pet_suv_img.header.get_zooms()[:3]).round(2)}, "
                  f"SUV factor={suv_factor:.8f}")
        except Exception as exc:
            print(f"  Failed to build original PET: {exc}")

    # Fallback: use cached resampled PET (less accurate for SUVmax)
    if pet_suv_img is None:
        pet_path = os.path.join(output_dir, "pet_3mm_iso.nii.gz")
        if not os.path.exists(pet_path):
            return "Error: No PET data available for analysis."
        pet_suv_img = nib.load(pet_path)
        print("  Falling back to cached resampled PET (SUVmax may be smoothed)")

    # ── Label in NATIVE mask space to match viewer contour ordering ──
    # scipy.ndimage.label assigns IDs by raster scan order, which differs
    # between the 4 mm mask grid and the original PET grid.  By labeling
    # in native space first, the lesion IDs stay consistent with the
    # contours shown on the viewer (contour_extract.py also uses native space).
    labeled_native, n_lesions = label(mask_data > 0.5)
    native_zooms = mask_img.header.get_zooms()
    native_voxel_vol = float(np.prod(native_zooms[:3])) / 1000.0

    # Build per-label masks in PET space for accurate SUV extraction
    pet_data = pet_suv_img.get_fdata()
    pet_zooms = pet_suv_img.header.get_zooms()
    pet_voxel_vol = float(np.prod(pet_zooms[:3])) / 1000.0
    need_resample = (
        not np.allclose(mask_img.affine, pet_suv_img.affine, atol=0.01)
        or mask_img.shape != pet_suv_img.shape[:3]
    )

    results = []
    for i in range(1, n_lesions + 1):
        native_lm = labeled_native == i
        vol_ml_native = float(np.sum(native_lm)) * native_voxel_vol
        if vol_ml_native < 0.1:
            continue

        if need_resample:
            # Resample this single label to PET space (nearest-neighbour)
            label_nii = nib.Nifti1Image(native_lm.astype(np.float32), mask_img.affine)
            label_pet = resample_from_to(label_nii, pet_suv_img, order=0).get_fdata() > 0.5
        else:
            label_pet = native_lm

        if not np.any(label_pet):
            continue

        vals = pet_data[label_pet]
        vol_ml = float(np.sum(label_pet)) * pet_voxel_vol
        results.append({
            "id": i,
            "suv_max": float(np.max(vals)),
            "suv_mean": float(np.mean(vals)),
            "mtv_ml": vol_ml,
            "tlg": float(np.mean(vals)) * vol_ml,
        })
    results.sort(key=lambda x: x["suv_max"], reverse=True)

    # ── Re-number lesions 1..N by SUVmax (descending) ──
    # Remap both the result IDs and the labeled mask so that
    # label value 1 = highest SUVmax everywhere (backend, viewer, chat).
    old_to_new = {}
    for new_id, res in enumerate(results, start=1):
        old_to_new[res["id"]] = new_id
        res["id"] = new_id

    # Rebuild labeled mask with SUVmax-ordered IDs
    relabeled = np.zeros_like(labeled_native, dtype=np.int16)
    for old_id, new_id in old_to_new.items():
        relabeled[labeled_native == old_id] = new_id
    labeled_native = relabeled

    # Save the SUVmax-ordered labeled mask for viewer overlay
    relabeled_path = mask_path.replace(".nii", "_labeled.nii")
    if not relabeled_path.endswith(".gz"):
        relabeled_path += ".gz"
    nib.save(nib.Nifti1Image(labeled_native, mask_img.affine), relabeled_path)

    # Visualization uses the low-res union canvas data (mask native space)
    mip_paths: list[str] = []
    try:
        from analysis.utils.image_proc import visualize_lesions

        ct_path = os.path.join(output_dir, "ct_3mm_iso.nii.gz")
        pet_vis_path = os.path.join(output_dir, "pet_3mm_iso.nii.gz")

        if os.path.exists(pet_vis_path):
            pet_vis_img = nib.load(pet_vis_path)
            pet_vis_data = pet_vis_img.get_fdata()
            vis_zooms = pet_vis_img.header.get_zooms()
            vis_mask = mask_img.get_fdata()
            if vis_mask.shape != pet_vis_data.shape:
                vis_mask = shape_matching(vis_mask, pet_vis_data.shape)
        else:
            pet_vis_data = pet_data
            vis_zooms = zooms
            vis_mask = mask_data_pet

        ct_vis_data = nib.load(ct_path).get_fdata() if os.path.exists(ct_path) else None

        vis_dir = os.path.join(output_dir, "lesion_vis")
        os.makedirs(vis_dir, exist_ok=True)

        pet_vis = np.transpose(pet_vis_data, (1, 0, 2))
        mask_vis = np.transpose(vis_mask > 0.5, (1, 0, 2))
        ct_vis = np.transpose(ct_vis_data, (1, 0, 2)) if ct_vis_data is not None else None
        zooms_t = (vis_zooms[1], vis_zooms[0], vis_zooms[2])

        mip_paths = visualize_lesions(pet_vis, mask_vis, zooms_t, vis_dir, ct_data=ct_vis)
    except Exception as exc:
        print(f"Visualization error: {exc}")

    return {
        "model": "AutoPET-3 (4mm Iso)" if os.path.exists(os.path.join(output_dir, "lesion_mask_3mm.nii.gz")) and mask_path.endswith("lesion_mask_3mm.nii.gz") else "Threshold-based (SUV>2.5)",
        "lesion_count": len(results),
        "lesions": results[:10],
        "visualization_images": mip_paths,
    }
