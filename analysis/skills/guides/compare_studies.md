# compare_studies

Compare lesions between two PET/CT studies to track changes over time.

## When to Use
- "Compare with previous scan", "Track lesion changes", "Treatment response" requests
- When the same patient has two timepoint PET/CT datasets available

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Current (latest) Study UID |
| compare_study_uid | Yes | — | Comparison (previous) Study UID |

## Output
- Side-by-side MIP comparison images
- Centroid-based lesion matching
- Change CSV (SUVmax delta, MTV delta)
- VLM-interpreted progression/regression report

## Workflow Guide
- Reuses existing quantify_lesion results if available for both studies.
- If not available, auto-runs quantify_lesion for each (significant time/GPU cost).
- Lesion matching is centroid-distance based — may not be perfect.

## Notes
- Both studies must be from the **same patient** for meaningful comparison.
- Can use significant GPU resources (if inference needed for both studies).
- Only studies loaded in the DB can be compared.
