"""Extract clinical context from DICOM headers for study-level understanding.

This module reads DICOM headers and builds a structured clinical context
summary that informs the agent about the patient, imaging protocol,
and clinical scenario before any analysis begins.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from pathlib import Path

import pydicom


def extract_study_context(study_dir: str) -> dict:
    """Walk *study_dir* and build a clinical context dict from DICOM headers.

    Returns a dict with patient demographics, imaging protocol details,
    tracer info, and a human-readable clinical summary.
    """
    series_info: list[dict] = []
    patient_info: dict = {}
    study_info: dict = {}
    tracer_info: dict = {}
    protocol_info: dict = {}
    seen_series: set[str] = set()

    for root, _dirs, files in os.walk(study_dir):
        for fname in files:
            if fname.startswith("."):
                continue
            fpath = os.path.join(root, fname)
            try:
                ds = pydicom.dcmread(fpath, stop_before_pixels=True, force=True)
                if not hasattr(ds, "SeriesInstanceUID"):
                    continue

                series_uid = str(ds.SeriesInstanceUID)
                if series_uid in seen_series:
                    continue
                seen_series.add(series_uid)

                modality = str(getattr(ds, "Modality", "Unknown"))
                series_desc = str(getattr(ds, "SeriesDescription", ""))

                # Patient info (from first valid file)
                if not patient_info:
                    patient_info = {
                        "patient_name": str(getattr(ds, "PatientName", "")),
                        "patient_id": str(getattr(ds, "PatientID", "")),
                        "patient_sex": str(getattr(ds, "PatientSex", "")),
                        "patient_age": str(getattr(ds, "PatientAge", "")),
                        "patient_weight_kg": _safe_float(getattr(ds, "PatientWeight", None)),
                        "patient_size_m": _safe_float(getattr(ds, "PatientSize", None)),
                    }

                # Study info
                if not study_info:
                    study_info = {
                        "study_uid": str(getattr(ds, "StudyInstanceUID", "")),
                        "study_date": str(getattr(ds, "StudyDate", "")),
                        "study_time": str(getattr(ds, "StudyTime", "")),
                        "study_description": str(getattr(ds, "StudyDescription", "")),
                        "referring_physician": str(getattr(ds, "ReferringPhysicianName", "")),
                        "accession_number": str(getattr(ds, "AccessionNumber", "")),
                        "institution_name": str(getattr(ds, "InstitutionName", "")),
                        "body_part": str(getattr(ds, "BodyPartExamined", "")),
                    }

                # Protocol / imaging details
                if modality == "CT" and "ct" not in protocol_info:
                    kvp = _safe_float(getattr(ds, "KVP", None))
                    tube_current = _safe_float(getattr(ds, "XRayTubeCurrent", None))
                    convolution = str(getattr(ds, "ConvolutionKernel", ""))
                    ct_dose = _safe_float(getattr(ds, "CTDIvol", None))
                    protocol_info["ct"] = {
                        "kvp": kvp,
                        "tube_current_mA": tube_current,
                        "convolution_kernel": convolution,
                        "ctdi_vol": ct_dose,
                        "contrast_agent": str(getattr(ds, "ContrastBolusAgent", "")),
                    }

                if modality == "PT" and "pet" not in protocol_info:
                    protocol_info["pet"] = {
                        "acquisition_type": str(getattr(ds, "AcquisitionType", "")),
                        "reconstruction_method": str(getattr(ds, "ReconstructionMethod", "")),
                        "attenuation_correction": str(getattr(ds, "AttenuationCorrectionMethod", "")),
                        "scatter_correction": str(getattr(ds, "ScatterCorrectionMethod", "")),
                        "decay_correction": str(getattr(ds, "DecayCorrection", "")),
                    }

                # Tracer / radiopharmaceutical info (PET only)
                if modality == "PT" and not tracer_info:
                    if hasattr(ds, "RadiopharmaceuticalInformationSequence"):
                        rad = ds.RadiopharmaceuticalInformationSequence[0]
                        tracer_info = {
                            "radiopharmaceutical": str(getattr(rad, "Radiopharmaceutical", "")),
                            "radionuclide": _get_radionuclide_name(rad),
                            "total_dose_bq": _safe_float(getattr(rad, "RadionuclideTotalDose", None)),
                            "half_life_sec": _safe_float(getattr(rad, "RadionuclideHalfLife", None)),
                            "injection_time": str(getattr(rad, "RadiopharmaceuticalStartTime", "")),
                            "route": str(getattr(rad, "RadiopharmaceuticalRoute", "")),
                        }

                # Series summary
                st = _safe_float(getattr(ds, "SliceThickness", None))
                ps = getattr(ds, "PixelSpacing", [0, 0])
                num_files = len([f for f in os.listdir(root) if not f.startswith(".")])

                series_info.append({
                    "series_uid": series_uid,
                    "modality": modality,
                    "description": series_desc,
                    "num_slices": num_files,
                    "slice_thickness_mm": st,
                    "pixel_spacing": [float(x) for x in ps] if ps else [],
                    "rows": int(getattr(ds, "Rows", 0) or 0),
                    "columns": int(getattr(ds, "Columns", 0) or 0),
                    "image_type": list(getattr(ds, "ImageType", [])),
                })

            except Exception:
                continue

    # Build structured context
    context = {
        "patient": patient_info,
        "study": study_info,
        "tracer": tracer_info,
        "protocol": protocol_info,
        "series": series_info,
        "modalities": sorted(set(s["modality"] for s in series_info)),
    }

    # Generate human-readable clinical summary
    context["clinical_summary"] = _build_clinical_summary(context)

    return context


def _safe_float(val) -> float | None:
    """Safely convert a DICOM value to float."""
    if val is None or val == "":
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _get_radionuclide_name(rad_seq) -> str:
    """Extract radionuclide name from RadionuclideCodeSequence if available."""
    if hasattr(rad_seq, "RadionuclideCodeSequence"):
        code_seq = rad_seq.RadionuclideCodeSequence
        if code_seq:
            return str(getattr(code_seq[0], "CodeMeaning", ""))
    return ""


def _format_study_date(date_str: str) -> str:
    """Convert YYYYMMDD to YYYY-MM-DD."""
    if len(date_str) == 8:
        return f"{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}"
    return date_str


def _format_dose(dose_bq: float | None) -> str:
    """Convert Bq to MBq or mCi for readability."""
    if not dose_bq:
        return "N/A"
    mbq = dose_bq / 1e6
    mci = mbq / 37.0
    return f"{mbq:.1f} MBq ({mci:.1f} mCi)"


def _build_clinical_summary(ctx: dict) -> str:
    """Build a human-readable clinical summary from extracted context."""
    parts: list[str] = []

    # Patient
    pt = ctx.get("patient", {})
    age = pt.get("patient_age", "")
    sex_map = {"F": "Female", "M": "Male", "O": "Other"}
    sex = sex_map.get(pt.get("patient_sex", ""), pt.get("patient_sex", ""))
    weight = pt.get("patient_weight_kg")
    pid = pt.get("patient_id", "")
    pname = pt.get("patient_name", "")

    demo_parts = []
    if age:
        demo_parts.append(f"{age.replace('Y', '-year-old')}")
    if sex:
        demo_parts.append(sex.lower())
    demo = " ".join(demo_parts)
    if pname:
        demo = f"{pname}, {demo}" if demo else pname
    elif pid:
        demo = f"Patient {pid}, {demo}" if demo else f"Patient {pid}"
    if weight:
        demo += f", {weight}kg"

    if demo:
        parts.append(f"**Patient**: {demo}")

    # Study
    st = ctx.get("study", {})
    study_date = _format_study_date(st.get("study_date", ""))
    study_desc = st.get("study_description", "")
    body_part = st.get("body_part", "")
    institution = st.get("institution_name", "")

    study_line = f"**Study**: {study_desc}" if study_desc else "**Study**: Unknown"
    if study_date:
        study_line += f" ({study_date})"
    if body_part:
        study_line += f", Body Part: {body_part}"
    if institution:
        study_line += f", Institution: {institution}"
    parts.append(study_line)

    # Modalities
    mods = ctx.get("modalities", [])
    if mods:
        parts.append(f"**Modalities**: {', '.join(mods)}")

    # Tracer
    tr = ctx.get("tracer", {})
    if tr:
        tracer_name = tr.get("radiopharmaceutical", "")
        dose_str = _format_dose(tr.get("total_dose_bq"))
        half_life = tr.get("half_life_sec")
        hl_str = f"{half_life:.0f}s ({half_life / 60:.0f}min)" if half_life else "N/A"
        inj_time = tr.get("injection_time", "")
        if inj_time and "." in inj_time:
            inj_time = inj_time.split(".")[0]
        if len(inj_time) == 6:
            inj_time = f"{inj_time[:2]}:{inj_time[2:4]}:{inj_time[4:6]}"

        parts.append(f"**Tracer**: {tracer_name}")
        parts.append(f"  - Dose: {dose_str}, Half-life: {hl_str}")
        if inj_time:
            parts.append(f"  - Injection time: {inj_time}")

    # Series overview
    series = ctx.get("series", [])
    if series:
        parts.append(f"**Series** ({len(series)} total):")
        for s in series:
            desc = s.get("description", "N/A")
            mod = s.get("modality", "?")
            n = s.get("num_slices", 0)
            st_mm = s.get("slice_thickness_mm")
            dims = f"{s.get('rows', 0)}x{s.get('columns', 0)}"
            line = f"  - [{mod}] {desc}: {n} slices, {dims}"
            if st_mm:
                line += f", {st_mm:.1f}mm"
            parts.append(line)

    # Clinical inference
    inference = _infer_clinical_context(ctx)
    if inference:
        parts.append(f"\n**Clinical Context (inferred)**: {inference}")

    return "\n".join(parts)


def _infer_clinical_context(ctx: dict) -> str:
    """Infer probable clinical scenario from DICOM metadata."""
    inferences: list[str] = []

    study_desc = ctx.get("study", {}).get("study_description", "").upper()
    body_part = ctx.get("study", {}).get("body_part", "").upper()
    tracer = ctx.get("tracer", {}).get("radiopharmaceutical", "").upper()
    mods = ctx.get("modalities", [])

    # Determine exam type
    if "PT" in mods and "CT" in mods:
        inferences.append("PET/CT examination")
    elif "PT" in mods:
        inferences.append("PET examination")
    elif "CT" in mods:
        inferences.append("CT examination")

    # Tracer-based inference
    if "FDG" in tracer:
        inferences.append("FDG (glucose metabolism marker)")

    # Body part / study description analysis
    cancer_keywords = ["TUMOR", "ONCO", "CANCER", "MALIG", "STAGING", "RESTAG",
                       "LYMPH", "METASTA", "BREAST", "LUNG"]
    if any(kw in study_desc for kw in cancer_keywords) or any(kw in body_part for kw in cancer_keywords):
        inferences.append("likely oncologic indication")

    if "BREAST" in body_part or "BREAST" in study_desc:
        inferences.append("breast cancer workup")
    elif "LUNG" in body_part or "LUNG" in study_desc:
        inferences.append("lung cancer workup")

    if "WHOLE" in study_desc or "WB" in study_desc or "SKULL" in study_desc:
        inferences.append("whole-body coverage")

    if "STAGING" in study_desc:
        inferences.append("staging study")
    elif "RESTAG" in study_desc:
        inferences.append("restaging study")

    return ". ".join(inferences) if inferences else ""


def extract_and_format_for_prompt(study_dir: str) -> str:
    """Extract context and return a formatted string ready for LLM system prompt."""
    ctx = extract_study_context(study_dir)
    return ctx.get("clinical_summary", "No clinical context available.")


def extract_context_json(study_dir: str) -> str:
    """Extract context and return as JSON string."""
    ctx = extract_study_context(study_dir)
    return json.dumps(ctx, indent=2, default=str)
