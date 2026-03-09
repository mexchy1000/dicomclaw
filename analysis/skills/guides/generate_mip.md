# generate_mip

Generate Maximum Intensity Projection (MIP) images from a PET series.

## When to Use
- When the user requests MIP or whole-body preview images
- Before lesion analysis to visualize overall tracer distribution
- When visual materials are needed for generate_report

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| pet_series_uid | — | auto-select | PET series UID |
| num_angles | — | 36 | Number of rotation angles (saves 4 views: 0°, 90°, 180°, 270°) |

## Output
- `plots/mip_000.png`, `mip_090.png`, `mip_180.png`, `mip_270.png`
- Intermediate: `intermediate/pet_suv.nii.gz` (SUV-converted PET volume)

## Notes
- This skill is **visualization only**. For quantitative analysis, use calc_suv or quantify_lesion.
- If pet_series_uid is not provided, it internally calls scan_dicom → always pass Pre-selected Series if available.
- SUV conversion (SUVbw) is performed automatically.
