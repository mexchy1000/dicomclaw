# segment_organ

Segment a specific organ from CT using TotalSegmentator and compute its volume.

## When to Use
- "Liver segmentation", "organ contour", "organ segmentation" requests
- When organ volume measurement is needed
- When organ contours (VOI) should be displayed in the viewer

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| organ | Yes | liver | TotalSegmentator organ name |
| ct_series_uid | — | auto-select | CT series UID |

## Difference from calc_suv
- **segment_organ**: Organ contour + volume only (CT only, no PET needed)
- **calc_suv**: Organ segmentation + SUV quantification (CT + PET both required)
- If SUV is the goal, use calc_suv directly. No need to call segment_organ first.

## Supported Organ Names

**The organ name MUST exactly match one from the TotalSegmentator supported list (see calc_suv guide for full list). If the user requests an unsupported organ, inform them and suggest the closest alternative. Do NOT call segment_organ with an unsupported name.**

Common organs: liver, spleen, kidney_left, kidney_right, pancreas, heart, lung_upper_lobe_left, lung_lower_lobe_left, lung_upper_lobe_right, lung_middle_lobe_right, lung_lower_lobe_right, aorta, stomach, gallbladder, urinary_bladder, brain

## Output
- NIfTI mask: `intermediate/<organ>_mask.nii.gz`
- DICOM SEG: `segmentations/<organ>_seg.dcm`
- Visualization: `plots/<organ>_segmentation.png`
- VOI overlay auto-displayed in viewer

## Notes
- calc_suv internally calls TotalSegmentator. **Do NOT call segment_organ separately if SUV is the goal.**
- Runs in `--fast` mode (3mm isotropic). May be imprecise for fine structures.
