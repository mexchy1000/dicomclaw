# extract_texture

Extract radiomics-style texture features from one or more VOIs.

## MANDATORY: Always propose_plan first

**This skill has multiple configurable parameters that affect results. You MUST always use `propose_plan` before calling `extract_texture`, presenting the configuration to the user for review.** The user may want to adjust GLCM mode, binning strategy, or other settings. Never run this skill without plan approval.

### Example plan to propose:

```
Texture Feature Extraction Plan:

1. Target VOIs: Lesion 1 (label=1), Lesion 2 (label=2)
2. Mask: <study_uid>/intermediate/lesion_mask_3mm_labeled.nii.gz

Configuration (modify if needed):
- GLCM mode: 2D (slice-averaged) — alternative: 3D (volumetric, slower but captures inter-slice patterns)
- Bin count: 32 gray levels
- Bin scale: absolute (fixed SUV range 0–20) — alternative: relative (per-VOI min–max)
- Bin max: 20 SUV (only used with absolute scale)

Features to extract:
- First-order: skewness, kurtosis, entropy, CV, IQR, uniformity
- GLCM: contrast, dissimilarity, homogeneity, energy, correlation, ASM
- Shape: sphericity, elongation, flatness, compactness, volume, surface area

Approve to proceed, or modify the configuration.
```

## When to Use
- "Texture features", "radiomics", "GLCM", "heterogeneity" requests
- When VOI internal heterogeneity/homogeneity analysis is needed
- When comparing texture profiles across multiple lesions

## Parameters
| Name | Required | Default | Description |
|------|----------|---------|-------------|
| study_uid | Yes | — | Study Instance UID |
| mask_path | Yes | — | NIfTI mask path (relative to results_dir) |
| label_values | — | 1 | Labels to analyze (comma-separated: "1,2,3") |
| label_value | — | 1 | Single label (alternative to label_values) |
| organ | — | voi | Label name (used in output filenames) |
| **glcm_mode** | — | **2d** | `2d` = per-slice averaged, `3d` = volumetric (13-direction, slower) |
| **bin_count** | — | **32** | Number of gray levels for GLCM quantization (range: 8–256) |
| **bin_scale** | — | **absolute** | `absolute` = fixed SUV range [0, bin_max], `relative` = per-VOI [min, max] |
| **bin_max** | — | **20** | Upper SUV bound when bin_scale=absolute |

## GLCM Configuration Guide

### glcm_mode: 2D vs 3D
| | 2D (default) | 3D |
|---|---|---|
| Method | Per-slice GLCM, 4 in-plane directions, averaged | Volumetric GLCM, 13 3D directions |
| Speed | Fast | Slower (proportional to voxel count) |
| Best for | Standard radiomics, thin-slice data | Capturing inter-slice heterogeneity |
| Limitation | Ignores z-axis texture | Memory-intensive for large VOIs |

### bin_scale: Absolute vs Relative
| | Absolute (default) | Relative |
|---|---|---|
| Range | Fixed [0, bin_max] SUV | Per-VOI [SUVmin, SUVmax] |
| Best for | Comparing across VOIs/studies (same scale) | Maximizing contrast within single VOI |
| Limitation | Low-uptake VOIs use few bins | Not comparable across VOIs with different SUV ranges |

### bin_count recommendations
- **16**: Coarse, fast, less sensitive to noise
- **32** (default): Good balance for most PET data
- **64**: Finer texture resolution, needs larger VOIs (>100 voxels)
- **128+**: Research use, requires large homogeneous VOIs

## Extracted Features

### First-Order (Histogram-based)
- **fo_skewness**: Distribution asymmetry (+right tail, −left tail)
- **fo_kurtosis**: Peakedness (+peaked, −flat)
- **fo_entropy**: Disorder (higher = more heterogeneous)
- **fo_cv**: Coefficient of variation (std/mean)
- **fo_iqr**: Interquartile range
- **fo_uniformity**: Value distribution uniformity

### GLCM (Spatial Texture)
- **glcm_contrast**: Intensity difference between neighbors (higher = rougher)
- **glcm_homogeneity**: Neighbor similarity (higher = more uniform)
- **glcm_energy**: Texture regularity
- **glcm_correlation**: Linear correlation between neighbors
- **glcm_dissimilarity**: Neighbor dissimilarity
- **glcm_asm**: Angular Second Moment

### Shape (Morphology)
- **shape_sphericity**: Sphere-likeness (1 = perfect sphere)
- **shape_elongation**: Roundness ratio (higher = rounder)
- **shape_flatness**: Flatness ratio
- **shape_compactness**: Bounding-box fill ratio
- **shape_volume_mm3**, **shape_surface_area_mm2**

## Workflow
- After quantify_lesion → `extract_texture(mask_path=<labeled_mask>, label_values="1,2")` to compare lesions
- When user says "@VOI1 @VOI2 compare texture" → look up mask_path/label from Active VOIs

## Notes
- PET NIfTI (`pet_3mm_iso.nii.gz`) must exist in intermediate/. Run quantify_lesion or calc_suv first.
- Very small VOIs (<10 voxels) produce unreliable texture statistics — warn the user.
- The CSV output includes the configuration columns (glcm_mode, bin_count, bin_scale, bin_max) for reproducibility.
