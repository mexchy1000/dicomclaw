"""Test organ SUV calculation (TotalSegmentator + PET co-registration)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MPLBACKEND"] = "Agg"

from analysis.utils.dicom_utils import scan_directory
from analysis.utils.seg_utils import get_organ_suv


def main():
    series = scan_directory("data/studies/BreastDx-01-0005")

    ct_series = None
    pet_series = None
    for uid, s in series.items():
        if s.modality == "CT" and (ct_series is None or "CAP" in s.description.upper()):
            ct_series = s
        if s.modality == "PT":
            pet_series = s

    if not ct_series or not pet_series:
        print(f"Missing series: CT={ct_series is not None}, PET={pet_series is not None}")
        return

    print(f"CT: {ct_series.description} ({len(ct_series.files)} files)")
    print(f"PET: {pet_series.description} ({len(pet_series.files)} files)")

    output_dir = "results/test_organ_suv"
    os.makedirs(output_dir, exist_ok=True)

    print("\nCalculating liver SUV...")
    stats = get_organ_suv(ct_series, pet_series, "liver", output_dir=output_dir)
    print(f"\nLiver SUV stats:")
    for k, v in stats.items():
        if isinstance(v, float):
            print(f"  {k}: {v:.4f}")
        else:
            print(f"  {k}: {v}")

    print("\nSUCCESS!")


if __name__ == "__main__":
    main()
