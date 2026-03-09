# calc_suv

Segment an organ using TotalSegmentator and compute PET SUV statistics within it.

## When to Use
- "Liver SUV", "organ uptake", "reference organ" requests
- When background SUV reference is needed for lesion interpretation (e.g., liver reference)
- When comparing SUV across multiple organs

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| organ | Yes | liver | TotalSegmentator organ name (see list below) |
| ct_series_uid | — | auto-select | CT series UID |
| pet_series_uid | — | auto-select | PET series UID |

## Supported Organ Names (TotalSegmentator v2)

**IMPORTANT: The organ name MUST exactly match one of the names below. If the user requests an organ not in this list, inform them it is not supported and suggest the closest available alternative. Do NOT attempt to call calc_suv or segment_organ with an unsupported organ name.**

### Abdominal Organs
liver, spleen, kidney_left, kidney_right, kidney_cyst_left, kidney_cyst_right, pancreas, gallbladder, stomach, duodenum, small_bowel, colon, urinary_bladder, prostate, adrenal_gland_left, adrenal_gland_right

### Thoracic Organs
lung_upper_lobe_left, lung_lower_lobe_left, lung_upper_lobe_right, lung_middle_lobe_right, lung_lower_lobe_right, heart, esophagus, trachea, thyroid_gland

### Vascular
aorta, inferior_vena_cava, superior_vena_cava, portal_vein_and_splenic_vein, pulmonary_vein, brachiocephalic_trunk, brachiocephalic_vein_left, brachiocephalic_vein_right, common_carotid_artery_left, common_carotid_artery_right, subclavian_artery_left, subclavian_artery_right, iliac_artery_left, iliac_artery_right, iliac_vena_left, iliac_vena_right

### Skeletal
skull, sternum, sacrum, scapula_left, scapula_right, clavicula_left, clavicula_right, humerus_left, humerus_right, femur_left, femur_right, hip_left, hip_right, costal_cartilages, vertebrae_C1-C7, vertebrae_T1-T12, vertebrae_L1-L5, vertebrae_S1, rib_left_1-12, rib_right_1-12

### Muscles & Neural
brain, spinal_cord, autochthon_left, autochthon_right, iliopsoas_left, iliopsoas_right, gluteus_maximus_left, gluteus_maximus_right, gluteus_medius_left, gluteus_medius_right, gluteus_minimus_left, gluteus_minimus_right, atrial_appendage_left

## Output
```json
{
  "status": "ok",
  "suv_mean": 1.81, "suv_max": 2.98,
  "volume_ml": 1177.0,
  "csv": "<study_uid>/tables/suv_liver.csv",
  "overlays": [{"study_uid": "...", "path": "...", "labels": [...]}]
}
```

## Workflow Guide
1. **Liver reference is commonly needed** — when interpreting lesion SUV, liver SUVmean serves as baseline.
2. If the user mentions "background SUV" or "normal uptake", run calc_suv for liver or the relevant organ first.
3. **Multiple organs require separate calls** (organ parameter accepts only one organ per call).
4. Result overlays are auto-displayed in the viewer — no additional action needed.

## Notes
- TotalSegmentator runs in `--fast` mode (3mm isotropic resolution).
- Organ name must be exact. Typos cause "No matching label" error.
- Always pass ct_series_uid and pet_series_uid if Pre-selected Series are available.
- calc_suv internally calls TotalSegmentator — **do NOT call segment_organ separately if SUV is the goal.**
