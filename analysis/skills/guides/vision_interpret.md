# vision_interpret

Send images to a Vision Language Model (VLM) for radiological interpretation.

## When to Use
- When AI interpretation of MIP, lesion, segmentation, or VOI images is needed
- "What is this?", "Give me findings", "Interpret this" requests
- For VOI-specific visual interpretation (image_type=voi)
- Before generate_report, to draft preliminary findings

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| prompt | — | auto-generated | Question/instruction for the VLM |
| image_type | — | mip | `mip` \| `lesion` \| `segmentation` \| `voi` \| `custom` |
| mask_path | Required for voi | — | NIfTI mask path (relative to results/) |
| voi_id | Required for voi | — | VOI label number (integer value in mask) |
| image_paths | For custom | — | Comma-separated image paths |

## image_type Behavior
- **mip**: Auto-collects `plots/mip_*.png`. Requires generate_mip to have been run first.
- **lesion**: Collects `plots/lesion_*.png` + `plots/mip_overlay_*.png`.
- **segmentation**: Collects `plots/*_segmentation.png`.
- **voi**: Generates centroid-based snapshots (axial/coronal/sagittal + MIP) from mask_path + voi_id.
- **custom**: Sends images specified in image_paths.

## Workflow Guide
- After quantify_lesion → `vision_interpret(image_type=lesion)` for lesion interpretation.
- When user mentions a VOI → `vision_interpret(image_type=voi, voi_id=N, mask_path=...)`.
- **Results are saved as markdown** → `reports/vision_*.md`.

## Notes
- VLM API key must be configured (OpenRouter).
- If no images exist for the requested image_type, an error is returned — run the corresponding skill first.
- VLM interpretation is **advisory only**. It is not a clinical diagnosis.
