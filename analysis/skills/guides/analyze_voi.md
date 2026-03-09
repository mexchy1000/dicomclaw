# analyze_voi

Perform detailed SUV statistics, histogram, and axial intensity profile for a specific VOI.

## When to Use
- When the user requests **detailed statistics** for a manually drawn or auto-detected VOI
- "What's the SUV distribution of this lesion?", "Show me a histogram" requests
- When intensity profiles or percentile breakdowns are needed

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| mask_path | Yes | — | NIfTI mask path (relative to results_dir) |
| label_value | — | 1 | Integer label value in the mask to analyze |
| organ | — | voi | Label name (used in output filenames) |

## Difference from quantify_lesion
- **quantify_lesion**: Whole-scan lesion detection + basic stats (SUVmax, SUVmean, MTV, TLG)
- **analyze_voi**: Single VOI **deep analysis** (percentiles, std, histogram, axial profile)

## Output
- CSV: `tables/voi_analysis_<organ>.csv` (mean, max, min, std, p10-p90, TLG)
- Histogram: `plots/suv_histogram_<organ>.png`
- Axial profile: `plots/axial_profile_<organ>.png`

## Notes
- mask_path must be a **relative path** (relative to results/).
- Use masks from quantify_lesion or segment_organ results.
- Check Active VOIs section for mask paths and label numbers.
