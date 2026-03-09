# quantify_lesion

Detect and quantify lesions automatically using the AutoPET-3 (nnUNet) model.

## When to Use
- "Find lesions", "lesion detection", "tumor analysis" requests
- When PET/CT data is available and oncologic analysis is needed
- **Only run when the user explicitly requests lesion analysis** — do NOT auto-run (heavy GPU usage)

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| tracer | — | FDG | Radiotracer type |
| ct_series_uid | — | auto-select | CT series UID |
| pet_series_uid | — | auto-select | PET series UID |

## Output
```json
{
  "status": "ok",
  "lesion_count": 2,
  "lesions": [
    {"id": 1, "suv_max": 5.52, "suv_mean": 3.41, "mtv_ml": 12.5, "tlg": 42.6},
    {"id": 2, "suv_max": 4.57, "suv_mean": 2.80, "mtv_ml": 8.3, "tlg": 23.2}
  ],
  "csv": "<study_uid>/tables/lesion_stats.csv",
  "overlays": [...]
}
```

## Key Rules
1. **Lesion numbering is by SUVmax descending** — Lesion 1 has the highest SUVmax.
2. Overlay label.value matches the integer label in the NIfTI mask.
3. Result overlays are auto-displayed as VOIs in the viewer.

## Workflow Guide
- **Typical oncology workflow**: quantify_lesion → calc_suv(organ=liver) → vision_interpret → generate_report
- After detection, summarize results and suggest further analysis (VOI interpretation, report, etc.).
- If 0 lesions detected, clearly state "No lesions detected."

## Notes
- **GPU required** — AutoPET-3 inference needs CUDA GPU. Model weights must exist in weights/ directory.
- Falls back to threshold-based method when weights are missing (lower accuracy).
- Takes ~2-5 minutes for whole-body PET/CT. Progress is reported via PROGRESS markers.
- Always pass ct_series_uid and pet_series_uid (use Pre-selected Series).
