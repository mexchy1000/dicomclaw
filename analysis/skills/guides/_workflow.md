# Workflow Guide (Global Skill Operation Principles)

## Core Principles

1. **Use Pre-selected Series first.** If `## Pre-selected Series` section exists in the system prompt, skip scan_dicom and pass those UIDs directly.
2. **Only do what the user asked.** Do NOT auto-run quantify_lesion unless the user explicitly requests lesion analysis.
3. **Summarize results concisely.** Numbers to 1-2 decimal places, focus on key findings.
4. **Suggest next steps.** After analysis, recommend follow-up actions (e.g., "I can also extract texture features or generate a report.").

## Planning Rule (MANDATORY)

**If your analysis requires 2 or more skill calls, you MUST call `propose_plan` FIRST** and wait for user approval before executing any skill. Single-skill requests may proceed directly.

## Standard Workflows

### General analysis request ("Analyze this patient")
1. scan_dicom (skip if Pre-selected Series available)
2. generate_mip
3. quantify_lesion
4. calc_suv(organ=liver) — reference
5. Summarize results + suggest further analysis

### Lesion analysis ("Find lesions")
1. quantify_lesion (pass ct/pet UIDs)
2. Summarize (lesion count, top SUVmax, locations)
3. Suggest vision_interpret(image_type=lesion) if appropriate

### Organ SUV request ("Liver SUV")
1. calc_suv(organ=liver, pass ct/pet UIDs)
2. Report SUVmean, SUVmax, volume

### Report request ("Generate a report")
1. Check existing results (CSV, images)
2. Run missing analyses
3. generate_report

### VOI interpretation ("What is VOI1?")
1. Look up mask_path and label from Active VOIs section
2. vision_interpret(image_type=voi, voi_id=N, mask_path=...)
3. Combine interpretation with quantitative data

### Texture analysis ("Compare lesion heterogeneity")
1. extract_texture(mask_path=..., label_values="1,2")
2. Report GLCM, shape, first-order features with comparison

## Error Handling
- On skill failure, explain the cause and suggest alternatives — do NOT pass raw error messages to the user.
- "No suitable PET series" → Run scan_dicom to list series and guide manual selection.
- "AutoPET inference failed" → Check model weights directory.
- VLM error → Check API key/model settings.

## Multi-Skill Combinations
- **Use propose_plan.** If calling 2+ skills in sequence, propose the plan first and wait for approval.
- Intermediate results (NIfTI, CSV) from one skill can feed the next. Pass paths accurately.
- Overlays are auto-emitted — no separate overlay command needed.
