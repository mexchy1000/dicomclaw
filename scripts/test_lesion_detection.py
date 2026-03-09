"""Test lesion detection pipeline (AutoPET or threshold fallback)."""
import os
import sys
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MPLBACKEND"] = "Agg"

from analysis.utils.dicom_utils import scan_directory
from analysis.utils.autopet_wrapper import run_autopet_inference, analyze_prediction_mask


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

    output_dir = "results/test_lesion"
    os.makedirs(output_dir, exist_ok=True)

    print("\nRunning lesion detection...")
    mask_path = run_autopet_inference(ct_series, pet_series, output_dir, "weights")

    if not mask_path:
        print("ERROR: Inference failed!")
        return

    print(f"\nMask saved to: {mask_path}")
    print("Analyzing mask...")

    analysis = analyze_prediction_mask(mask_path)
    if isinstance(analysis, str):
        print(f"Analysis error: {analysis}")
        return

    print(f"\nResults:")
    print(f"  Model: {analysis['model']}")
    print(f"  Lesions found: {analysis['lesion_count']}")
    for les in analysis.get("lesions", []):
        print(f"    Lesion #{les['id']}: SUVmax={les['suv_max']:.2f}, SUVmean={les['suv_mean']:.2f}, "
              f"MTV={les['mtv_ml']:.1f}ml, TLG={les['tlg']:.1f}")

    if analysis.get("visualization_images"):
        print(f"\n  Visualizations: {len(analysis['visualization_images'])} files")

    print("\nSUCCESS!")


if __name__ == "__main__":
    main()
