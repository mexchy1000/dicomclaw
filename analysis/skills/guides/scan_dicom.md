# scan_dicom

Scan a DICOM study directory, list all series, and auto-select the best CT/PET series.

## When to Use
- **First call** at the start of a session (skip if Pre-selected Series are already provided)
- When the user asks "What series are available?"
- Before other skills when ct_series_uid / pet_series_uid are unknown

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| study_dir | — | — | Direct path override (instead of study_uid) |
| auto_select | — | true | Auto-select best CT/PET series |

## Output
```json
{
  "status": "ok",
  "series": [
    {"uid": "...", "modality": "CT", "description": "...", "num_files": 207, "slice_thickness": 3.0}
  ],
  "selected": {"CT": "<uid>", "PET": "<uid>"}
}
```

## Decision Rules
- **Skip scan_dicom if Pre-selected Series exist** in the system prompt — the viewer has already chosen optimal series.
- When auto_select=true: prefers axial series with the most slices.
- PET selection targets ORIGINAL\PRIMARY images only (with reconstruction/attenuation correction).
