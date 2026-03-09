# generate_report

Compile all analysis results into a structured markdown report.

## When to Use
- After all analyses are complete, when the user requests a **final report**
- "Generate report", "Summarize results", "Write up findings" requests
- **Always call this LAST** — after all other analysis skills have been run

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| title | — | auto-generated | Report title |

## Output
- `reports/final_report.md` — Structured markdown report
- Contents: patient info, exam details, SUV statistics, lesion results, MIP images, findings

## Workflow Guide
### Standard Oncology Report Workflow:
1. `scan_dicom` (or verify Pre-selected Series)
2. `quantify_lesion` (lesion detection)
3. `calc_suv(organ=liver)` (background reference)
4. `generate_mip` (whole-body preview)
5. `vision_interpret(image_type=lesion)` (VLM findings)
6. **`generate_report`** (final compilation)

## Notes
- This skill only **aggregates** existing result files (CSV, PNG, MD). It does not perform any analysis itself.
- Empty sections appear if prerequisite analyses haven't been run. Run required skills first.
- Only relative paths are included in the report (never absolute).
