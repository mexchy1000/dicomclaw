"""Test the quantify_lesion skill end-to-end."""
import os
import sys
import json
import sqlite3

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MPLBACKEND"] = "Agg"

from analysis.skills.quantify_lesion import QuantifyLesionSkill


def main():
    # Get study UID from DB
    conn = sqlite3.connect("data/dicomclaw.db")
    cur = conn.cursor()
    cur.execute("SELECT study_uid FROM dicom_studies WHERE patient_name LIKE '%0005%' OR study_description LIKE '%WHOLE%'")
    row = cur.fetchone()
    conn.close()

    if not row:
        print("Study not found in DB")
        return

    study_uid = row[0]
    print(f"Study UID: {study_uid[:50]}...")

    skill = QuantifyLesionSkill()
    result = skill.run(
        studies_dir="data/studies",
        results_dir="results",
        study_uid=study_uid,
        tracer="FDG",
    )

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
