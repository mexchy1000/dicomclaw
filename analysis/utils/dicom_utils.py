"""DICOM scanning and series management utilities.

Ported from pet_agent/src/dicom_utils.py with adjusted imports.
"""
from __future__ import annotations

import json
import os
from collections import defaultdict

import pydicom

from analysis.llm_client import query_llm


class DicomSeries:
    """Represents a single DICOM series with lazy header loading."""

    def __init__(self, series_uid: str, modality: str, description: str,
                 files: list[str], metadata: dict | None = None):
        self.series_uid = series_uid
        self.modality = modality
        self.description = description
        self.files = sorted(files)
        self.metadata = metadata or {}
        self.header = None

    def get_header(self):
        if self.header is None and self.files:
            self.header = pydicom.dcmread(self.files[0], stop_before_pixels=True)
        return self.header

    def __repr__(self):
        return f"<DicomSeries {self.modality}: {self.description} ({len(self.files)} files)>"


def scan_directory(path: str) -> dict[str, DicomSeries]:
    """Recursively scan *path* for DICOM files grouped by SeriesInstanceUID."""
    series_map: dict[str, list[str]] = defaultdict(list)

    for root, _dirs, files in os.walk(path):
        for fname in files:
            if fname.startswith("."):
                continue
            full_path = os.path.join(root, fname)
            try:
                ds = pydicom.dcmread(full_path, stop_before_pixels=True)
                if hasattr(ds, "SeriesInstanceUID"):
                    series_map[str(ds.SeriesInstanceUID)].append(full_path)
            except Exception:
                continue

    results: dict[str, DicomSeries] = {}
    for uid, file_list in series_map.items():
        if not file_list:
            continue
        try:
            ds = pydicom.dcmread(file_list[0], stop_before_pixels=True)
            modality = str(ds.get("Modality", "Unknown"))
            desc = str(ds.get("SeriesDescription", "NoDescription"))

            st = ds.get("SliceThickness", 0.0)
            if st is None or st == "":
                st = 0.0

            ps = ds.get("PixelSpacing", [0, 0])
            if ps is None or ps == "":
                ps = [0, 0]

            metadata = {
                "ImageType": list(ds.get("ImageType", [])),
                "AcquisitionType": str(ds.get("AcquisitionType", "Unknown")),
                "SliceThickness": float(st),
                "NumberOfSlices": len(file_list),
                "SeriesNumber": int(ds.get("SeriesNumber", 0) or 0),
                "PixelSpacing": [float(x) for x in ps],
            }

            results[uid] = DicomSeries(uid, modality, desc, file_list, metadata)
        except Exception as exc:
            print(f"Error processing series {uid}: {exc}")

    return results


def select_best_series_heuristic(series_dict: dict[str, DicomSeries]) -> dict[str, str | None]:
    """Heuristic-based series selection (no LLM required).

    Selects the best PET (AC, most slices) and CT (standard, most slices) series.
    """
    pet_candidates = []
    ct_candidates = []
    skip_keywords = {"scout", "topogram", "dose", "report", "screen", "localizer"}

    for uid, s in series_dict.items():
        desc_lower = s.description.lower()
        if any(kw in desc_lower for kw in skip_keywords):
            continue
        num = s.metadata.get("NumberOfSlices", len(s.files))
        if s.modality == "PT":
            # Prefer AC series, avoid NAC/uncorrected
            is_ac = "ac" in desc_lower or "corrected" in desc_lower
            is_nac = "nac" in desc_lower or "uncorrect" in desc_lower or "no ac" in desc_lower
            score = num  # More slices = better
            if is_ac:
                score += 10000
            if is_nac:
                score -= 20000
            if "wb" in desc_lower or "whole" in desc_lower or "body" in desc_lower:
                score += 5000
            if "3d" in desc_lower:
                score += 2000
            if "mip" in desc_lower:
                score -= 15000
            pet_candidates.append((uid, score))
        elif s.modality == "CT":
            score = num
            # Prefer standard/body CT, avoid lung window
            if "std" in desc_lower or "standard" in desc_lower or "cap" in desc_lower:
                score += 5000
            if "lung" in desc_lower:
                score -= 3000
            ct_candidates.append((uid, score))

    pet_candidates.sort(key=lambda x: x[1], reverse=True)
    ct_candidates.sort(key=lambda x: x[1], reverse=True)

    result = {
        "PET": pet_candidates[0][0] if pet_candidates else None,
        "CT": ct_candidates[0][0] if ct_candidates else None,
    }
    return result


def select_best_series(series_dict: dict[str, DicomSeries]) -> dict[str, str | None]:
    """Pick the best axial PET (AC) and axial CT series.

    Tries LLM first, falls back to heuristic selection.
    """
    # Try heuristic first (always works, fast)
    heuristic = select_best_series_heuristic(series_dict)

    # Try LLM for better selection if API key is available
    api_key = os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print(f"Heuristic series selection: PET={heuristic.get('PET') is not None}, CT={heuristic.get('CT') is not None}")
        return heuristic

    series_info = []
    for uid, s in series_dict.items():
        series_info.append({
            "uid": uid,
            "modality": s.modality,
            "description": s.description,
            "num_slices": s.metadata.get("NumberOfSlices", 0),
            "slice_thickness": s.metadata.get("SliceThickness", 0),
            "image_type": s.metadata.get("ImageType", []),
        })

    prompt = f"""You are a DICOM expert. Given the following list of DICOM series metadata, identify the Series Instance UID for:
1. The PRIMARY AXIAL PET series.
   - MUST be Attenuation Corrected (AC).
   - PREFER series with descriptions like 'AC', 'Corrected', 'WB', 'Body'.
   - AVOID series with 'Uncorrected', 'NAC', 'No AC' in description.
   - Ignore 'Scout', 'Topogram', 'MIP'.
2. The PRIMARY AXIAL CT series.
   - Standard Axial recon (3-5mm).
   - Ignore 'Scout', 'Topogram', 'Dose Report', 'Lung' (if standard available).

Series List:
{json.dumps(series_info, indent=2)}

Return ONLY a JSON object with keys 'PET' and 'CT' containing the best UID strings. If none found, return null.
Example: {{"PET": "1.2.3...", "CT": "1.2.4..."}}"""

    print("Asking LLM to select best series...")
    response = query_llm([{"role": "user", "content": prompt}], temperature=0.0)

    try:
        json_str = response
        if "```json" in response:
            json_str = response.split("```json")[1].split("```")[0]
        elif "{" in response:
            start = response.find("{")
            end = response.rfind("}") + 1
            json_str = response[start:end]

        selection = json.loads(json_str)
        if selection.get("PET") not in series_dict:
            selection["PET"] = heuristic.get("PET")
        if selection.get("CT") not in series_dict:
            selection["CT"] = heuristic.get("CT")

        print(f"LLM Selected: PET={selection.get('PET')}, CT={selection.get('CT')}")
        return selection
    except Exception as exc:
        print(f"LLM selection failed: {exc}. Using heuristic fallback.")
        return heuristic


def classify_series(series_dict: dict[str, DicomSeries]) -> dict[str, list[DicomSeries]]:
    """Simple modality-based classification (legacy helper)."""
    classified: dict[str, list[DicomSeries]] = {"PET": [], "CT": []}
    for _uid, series in series_dict.items():
        if series.modality == "PT":
            classified["PET"].append(series)
        elif series.modality == "CT":
            classified["CT"].append(series)
    return classified
