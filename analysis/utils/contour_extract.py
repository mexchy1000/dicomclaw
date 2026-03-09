"""NIfTI segmentation mask → per-slice normalized contour polylines.

Usage (standalone):
    python -m analysis.utils.contour_extract <nifti_path> [--json]

Returns JSON:
{
  "labels": [
    {
      "value": 1,
      "name": "label_1",
      "contours": { "0": [[[x,y], ...]], "5": [[[x,y], ...]] }
    }
  ],
  "shape": [W, H, D]
}

Coordinates are normalized 0..1 (x = col/W, y = row/H).
"""

import json
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
from skimage.measure import find_contours, approximate_polygon

# Default label color map (TotalSegmentator common organs)
ORGAN_COLORS: dict[str, str] = {
    "liver": "#e6194b",
    "spleen": "#3cb44b",
    "kidney_left": "#ffe119",
    "kidney_right": "#f58231",
    "pancreas": "#911eb4",
    "stomach": "#42d4f4",
    "aorta": "#f032e6",
    "lung_upper_lobe_left": "#4363d8",
    "lung_lower_lobe_left": "#469990",
    "lung_upper_lobe_right": "#dcbeff",
    "lung_middle_lobe_right": "#9a6324",
    "lung_lower_lobe_right": "#800000",
    "heart": "#e6194b",
    "gallbladder": "#aaffc3",
    "urinary_bladder": "#fffac8",
    "colon": "#808000",
    "small_bowel": "#000075",
    "adrenal_gland_left": "#fabebe",
    "adrenal_gland_right": "#ffd8b1",
}

LESION_COLOR = "#ff0000"


def extract_contours(
    nifti_path: str,
    label_names: dict[int, str] | None = None,
    tolerance: float = 1.0,
) -> dict:
    """Extract contour polylines from a NIfTI segmentation mask.

    Args:
        nifti_path: Path to .nii or .nii.gz file.
        label_names: Optional mapping of label value → name. If None,
                     auto-generates names like "label_1".
        tolerance: Douglas-Peucker simplification tolerance in pixels.

    Returns:
        dict with "labels" list and "shape" [W, H, D].
    """
    img = nib.load(nifti_path)

    # Reorient to RAS+ canonical so voxel axes are consistently
    # axis0=Right, axis1=Anterior, axis2=Superior regardless of
    # the original affine orientation.
    img = nib.as_closest_canonical(img)
    data = np.asanyarray(img.dataobj)

    # Handle 4D (take first volume)
    if data.ndim == 4:
        data = data[:, :, :, 0]

    W, H, D = data.shape
    unique_vals = np.unique(data)
    unique_vals = unique_vals[unique_vals != 0]  # skip background

    if label_names is None:
        label_names = {}

    results = []
    for val in unique_vals:
        val = int(val)
        name = label_names.get(val, f"label_{val}")
        mask = (data == val)

        contours_by_slice: dict[str, list] = {}
        for z in range(D):
            slice_2d = mask[:, :, z].T.astype(np.float64)  # transpose: NIfTI (col, row, z) → image (row, col)
            if not slice_2d.any():
                continue

            raw_contours = find_contours(slice_2d, 0.5)
            simplified = []
            for contour in raw_contours:
                if len(contour) < 3:
                    continue
                approx = approximate_polygon(contour, tolerance=tolerance)
                if len(approx) < 3:
                    continue
                # Normalize: row → y/(H-1), col → x/(W-1) so range is exactly [0,1]
                norm = [[float(pt[1]) / max(W - 1, 1), float(pt[0]) / max(H - 1, 1)] for pt in approx]
                simplified.append(norm)

            if simplified:
                contours_by_slice[str(z)] = simplified

        if contours_by_slice:
            color = ORGAN_COLORS.get(name.lower(), LESION_COLOR)
            results.append({
                "value": val,
                "name": name,
                "color": color,
                "contours": contours_by_slice,
            })

    # Export canonical affine info for accurate world coordinate mapping.
    # After as_closest_canonical, the affine is ~diagonal: RAS+ axes.
    affine = img.affine
    ras_origin = [float(affine[0, 3]), float(affine[1, 3]), float(affine[2, 3])]
    voxel_sizes = [float(v) for v in img.header.get_zooms()[:3]]

    return {
        "labels": results,
        "shape": [W, H, D],
        "ras_origin": ras_origin,
        "voxel_sizes": voxel_sizes,
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python -m analysis.utils.contour_extract <nifti_path>", file=sys.stderr)
        sys.exit(1)

    nifti_path = sys.argv[1]

    # Optional: label names from --labels '{"1": "liver"}'
    label_names = None
    for i, arg in enumerate(sys.argv):
        if arg == "--labels" and i + 1 < len(sys.argv):
            label_names = {int(k): v for k, v in json.loads(sys.argv[i + 1]).items()}

    result = extract_contours(nifti_path, label_names=label_names)
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
