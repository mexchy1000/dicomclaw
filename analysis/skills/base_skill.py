"""Base class for all DICOMclaw analysis skills."""
from __future__ import annotations

import os
import sqlite3
from abc import ABC, abstractmethod
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DB_PATH = PROJECT_ROOT / "data" / "dicomclaw.db"


def resolve_study_dir(study_uid: str, studies_dir: str) -> str | None:
    """Resolve study_uid to the actual directory containing DICOM files.

    1. Try direct directory name match under studies_dir.
    2. Fall back to querying the SQLite DB for instance file paths.
    """
    # Direct match: studies_dir/<study_uid>/
    direct = os.path.join(studies_dir, study_uid)
    if os.path.isdir(direct):
        return direct

    # Try matching by directory listing (study_uid may be encoded differently)
    studies_path = Path(studies_dir)
    if studies_path.exists():
        for d in studies_path.iterdir():
            if d.is_dir() and study_uid in d.name:
                return str(d)

    # Query DB for file paths to find study directory
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cur = conn.cursor()
            cur.execute("""
                SELECT di.file_path FROM dicom_instances di
                JOIN dicom_series ds ON di.series_uid = ds.series_uid
                WHERE ds.study_uid = ? LIMIT 1
            """, (study_uid,))
            row = cur.fetchone()
            conn.close()
            if row:
                # Walk up from the file to find the study root dir
                inst_path = row[0]
                rel = os.path.relpath(os.path.dirname(inst_path), studies_dir)
                top_dir = rel.split(os.sep)[0]
                candidate = os.path.join(studies_dir, top_dir)
                if os.path.isdir(candidate):
                    return candidate
        except Exception:
            pass

    return None


class BaseSkill(ABC):
    """Abstract base for analysis skills.

    Subclasses must define ``name``, ``description`` and implement ``run()``.
    The agent discovers skills automatically via :func:`analysis.local_agent.discover_skills`.
    """

    name: str = ""
    description: str = ""
    input_modalities: list[str] = []

    @abstractmethod
    def run(self, studies_dir: str, results_dir: str, **kwargs) -> dict:
        """Execute the skill.

        Parameters
        ----------
        studies_dir : str
            Root directory containing DICOM studies.
        results_dir : str
            Root directory for analysis outputs.
        **kwargs
            Skill-specific parameters passed by the agent.

        Returns
        -------
        dict
            ``{"status": "ok"|"error", "message": str, ...}``
        """
        ...
