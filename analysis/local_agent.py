"""DICOMclaw local agent — ReAct loop for DICOM quantitative analysis.

Called by the Node.js orchestrator:
  python -m analysis.local_agent --prompt "user message"

Communicates via:
  - stdout: final answer text
  - stderr: [REACT:*] markers for real-time UI updates
  - stdin:  plan approval (APPROVED / MODIFY:feedback)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

from logging.handlers import RotatingFileHandler

from analysis.llm_client import query_llm

PROJECT_ROOT = Path(__file__).resolve().parent.parent
STUDIES_DIR = Path(os.environ.get("STUDIES_DIR", str(PROJECT_ROOT / "data" / "studies")))
RESULTS_DIR = Path(os.environ.get("RESULTS_DIR", str(PROJECT_ROOT / "results")))
DB_PATH = PROJECT_ROOT / "data" / "dicomclaw.db"
LOG_DIR = PROJECT_ROOT / "logs"

MAX_ITERATIONS = 30
PYTHON_TIMEOUT = 300  # 5 min for heavy analysis

# ── Logging ──
LOG_DIR.mkdir(exist_ok=True)

logger = logging.getLogger("local_agent")
logger.setLevel(logging.DEBUG)

_fh = RotatingFileHandler(LOG_DIR / "agent.log", maxBytes=5 * 1024 * 1024, backupCount=2, encoding="utf-8")
_fh.setLevel(logging.DEBUG)
_fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
logger.addHandler(_fh)

_sh = logging.StreamHandler(sys.stderr)
_sh.setLevel(logging.INFO)
_sh.setFormatter(logging.Formatter("[agent] %(message)s"))
logger.addHandler(_sh)


def emit_react_marker(marker_type: str, content: str) -> None:
    """Emit structured marker to stderr for Node.js orchestrator."""
    try:
        if marker_type == "PLAN":
            safe = content.replace("\n", "\\n")
        else:
            safe = content.replace("\n", " ").strip()
        print(f"[REACT:{marker_type}]{safe}", file=sys.stderr, flush=True)
    except (BrokenPipeError, OSError):
        pass


def discover_skills() -> dict[str, dict]:
    """Auto-discover skill classes from analysis/skills/."""
    skills = {}
    skills_dir = PROJECT_ROOT / "analysis" / "skills"
    if not skills_dir.exists():
        return skills

    for py_file in skills_dir.glob("*.py"):
        if py_file.name.startswith("_") or py_file.name == "base_skill.py":
            continue
        module_name = py_file.stem
        try:
            import importlib
            mod = importlib.import_module(f"analysis.skills.{module_name}")
            for attr_name in dir(mod):
                attr = getattr(mod, attr_name)
                if (isinstance(attr, type) and hasattr(attr, "name") and hasattr(attr, "run")
                        and attr_name != "BaseSkill"):
                    instance = attr()
                    skills[instance.name] = {
                        "instance": instance,
                        "description": getattr(instance, "description", ""),
                        "input_modalities": getattr(instance, "input_modalities", []),
                    }
        except Exception as e:
            logger.warning("Failed to load skill %s: %s", module_name, e)

    return skills


def load_clinical_context(study_uid: str) -> tuple[str, str]:
    """Load clinical context from SQLite DB for a given study.

    Returns (clinical_summary, clinical_context_json_str).
    """
    import sqlite3

    if not DB_PATH.exists():
        return "", ""

    try:
        conn = sqlite3.connect(str(DB_PATH))
        cur = conn.cursor()
        cur.execute(
            "SELECT clinical_context, clinical_context_json FROM dicom_studies WHERE study_uid = ?",
            (study_uid,),
        )
        row = cur.fetchone()
        conn.close()
        if row:
            return row[0] or "", row[1] or ""
    except Exception as e:
        logger.warning("Failed to load clinical context for %s: %s", study_uid, e)

    return "", ""


def _load_skill_guides(skill_names: list[str]) -> str:
    """Load markdown guides from analysis/skills/guides/ for discovered skills."""
    guides_dir = Path(__file__).resolve().parent / "skills" / "guides"
    if not guides_dir.is_dir():
        return ""

    sections: list[str] = []

    # Load workflow guide first (prefixed with _)
    workflow_path = guides_dir / "_workflow.md"
    if workflow_path.exists():
        sections.append(workflow_path.read_text(encoding="utf-8").strip())

    # Load per-skill guides
    for name in sorted(skill_names):
        guide_path = guides_dir / f"{name}.md"
        if guide_path.exists():
            sections.append(guide_path.read_text(encoding="utf-8").strip())

    return "\n\n---\n\n".join(sections) if sections else ""


def build_system_prompt(skills: dict[str, dict], study_uid: str | None = None,
                        extra_clinical_context: str | None = None,
                        overlays_json: str | None = None,
                        ct_series_uid: str | None = None,
                        pet_series_uid: str | None = None) -> str:
    """Build the system prompt with workspace info, available skills, and clinical context."""
    skill_list = ""
    for name, info in skills.items():
        mods = ", ".join(info["input_modalities"]) if info["input_modalities"] else "any"
        skill_list += f"  - {name}: {info['description']} (modalities: {mods})\n"

    if not skill_list:
        skill_list = "  (no skills loaded — use execute_python for ad-hoc analysis)\n"

    # Load markdown skill guides
    skill_guides = _load_skill_guides(list(skills.keys()))

    # Clinical context section
    clinical_section = ""
    if study_uid:
        clinical_summary, clinical_json = load_clinical_context(study_uid)
        if clinical_summary:
            clinical_section = f"""
## Clinical Context (from DICOM headers)
Study UID: {study_uid}

{clinical_summary}
"""
        else:
            clinical_section = f"""
## Current Study
Study UID: {study_uid}
(No clinical context available — run DICOM indexer to extract context)
"""

    # Pre-selected series UIDs (from viewer auto-detection or user override)
    if ct_series_uid or pet_series_uid:
        clinical_section += "\n## Pre-selected Series (use these instead of scanning)\n"
        if ct_series_uid:
            clinical_section += f"- CT series: {ct_series_uid}\n"
        if pet_series_uid:
            clinical_section += f"- PET series: {pet_series_uid}\n"
        clinical_section += "Pass ct_series_uid and/or pet_series_uid kwargs to skills that need series selection.\n"

    # Extra clinical context provided by user via prompt
    if extra_clinical_context:
        clinical_section += f"""
## Additional Clinical Context (user-provided)
{extra_clinical_context}
"""

    # VOI overlay context
    voi_section = ""
    if overlays_json:
        try:
            overlays = json.loads(overlays_json)
            voi_lines = []
            voi_idx = 0
            for ov in overlays:
                mask_path = ov.get("path", "")
                for lbl in ov.get("labels", []):
                    voi_idx += 1
                    name = lbl.get("name", f"Label {voi_idx}")
                    suv_max = lbl.get("suv_max", "?")
                    voi_lines.append(
                        f"  - VOI{voi_idx}: {name} (SUVmax={suv_max}, mask: {mask_path}, label={voi_idx})"
                    )
            if voi_lines:
                voi_section = "\n## Active VOIs\n" + "\n".join(voi_lines) + "\n"
                voi_section += (
                    "\nWhen the user references a VOI (e.g., 'VOI1'), use:\n"
                    "  use_skill(vision_interpret, study_uid=..., image_type=voi, voi_id=<N>, mask_path=<path>)\n"
                )
        except Exception:
            pass

    prompt = f"""You are a DICOM-based medical image quantitative analysis agent (DICOMclaw).
You analyze PET/CT and other DICOM modalities using Python tools.

## Workspace
- DICOM studies: {STUDIES_DIR}
- Results output: {RESULTS_DIR}
- Results per study: {RESULTS_DIR}/<study_uid>/
  - intermediate/   (NIfTI volumes, resampled data)
  - segmentations/  (DICOM SEG for viewer VOI)
  - plots/          (MIP, visualization PNG)
  - reports/        (markdown reports)
  - tables/         (CSV statistics)
{clinical_section}{voi_section}
## Available Skills (registered)
{skill_list}
## Available Actions
- use_skill: Call a registered skill. Format: use_skill(skill_name, key=value, ...)
  Example: use_skill(calc_suv, organ=liver)
  Example: use_skill(quantify_lesion, tracer=FDG)
- execute_python: Run arbitrary Python code. The code has access to all installed packages.
- propose_plan: Propose an analysis plan for user approval (use for multi-step analyses).
- read_file: Read a file from the workspace.
- list_files: List files in a directory.

## Key Guidelines
- ALWAYS save results to {RESULTS_DIR}/<study_uid>/ with appropriate subdirectory.
- When a study is loaded, use its clinical context to inform your analysis decisions.
- For segmentation results that should appear as VOI overlays in the viewer, emit:
  [REACT:OVERLAY]{{"study_uid":"...","path":"...","labels":[{{"name":"label","suv_max":0.0}}]}}
- For progress updates during long operations:
  [REACT:PROGRESS]{{"skill":"name","percent":50,"message":"..."}}
- When generating reports, save as markdown to results/<study_uid>/reports/
- Use matplotlib with Agg backend for all plots.
- NEVER include absolute file paths in your Final Answer — use relative paths only.
- **IMPORTANT — Planning Rule**: If your analysis will call 2 or more skills, you MUST use `propose_plan` FIRST to present the plan to the user and wait for approval before executing any skill. This is mandatory — do NOT skip planning for multi-step analyses. Single-skill requests can proceed directly.
- **Follow the Skill Guides below** — they contain parameter details, workflow patterns, and decision rules.

## Response Format
Thought: your reasoning
Action: action_name
Action Input: parameters

When done:
Final Answer: your complete response to the user
"""
    # Append skill guides after the main prompt
    if skill_guides:
        prompt += "\n\n## Skill Guides (follow these carefully)\n\n" + skill_guides + "\n"
    return prompt


def execute_python(code: str) -> str:
    """Execute Python code in subprocess."""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", dir="/tmp", delete=False) as f:
        f.write(code)
        tmp_path = f.name

    try:
        env = os.environ.copy()
        env["PYTHONPATH"] = str(PROJECT_ROOT)
        env["MPLBACKEND"] = "Agg"

        result = subprocess.run(
            [sys.executable, tmp_path],
            capture_output=True, text=True, timeout=PYTHON_TIMEOUT,
            cwd=str(PROJECT_ROOT), env=env,
        )

        output = ""
        if result.stdout:
            output += result.stdout[:8000]
        if result.stderr:
            stderr_lines = [l for l in result.stderr.splitlines()
                           if not any(s in l for s in ["UserWarning", "FutureWarning", "DeprecationWarning"])]
            stderr_filtered = "\n".join(stderr_lines).strip()
            if stderr_filtered:
                output += f"\nStderr:\n{stderr_filtered[:3000]}"

        if result.returncode != 0:
            output = f"Exit code: {result.returncode}\n{output}"

        return output.strip() or "(no output)"
    except subprocess.TimeoutExpired:
        return f"Error: Python execution timed out ({PYTHON_TIMEOUT}s)"
    except Exception as e:
        return f"Error executing Python: {e}"
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def run_skill(skills: dict, skill_name: str, kwargs_str: str) -> str:
    """Run a registered skill by name."""
    if skill_name not in skills:
        available = ", ".join(skills.keys()) or "(none)"
        return f"Error: Unknown skill '{skill_name}'. Available: {available}"

    # Parse key=value pairs
    kwargs = {}
    if kwargs_str.strip():
        for part in kwargs_str.split(","):
            part = part.strip()
            if "=" in part:
                k, v = part.split("=", 1)
                kwargs[k.strip()] = v.strip().strip("'\"")
            else:
                kwargs[part] = True

    try:
        import io
        import contextlib
        instance = skills[skill_name]["instance"]
        # Capture stdout from skill execution so print() doesn't leak to chat
        captured_out = io.StringIO()
        with contextlib.redirect_stdout(captured_out):
            result = instance.run(
                studies_dir=str(STUDIES_DIR),
                results_dir=str(RESULTS_DIR),
                **kwargs,
            )
        skill_out = captured_out.getvalue()
        if skill_out.strip():
            logger.info("Skill %s output:\n%s", skill_name, skill_out[:2000])
        # Auto-emit overlay markers from skill result
        if isinstance(result, dict):
            for ov in result.get("overlays", []):
                try:
                    emit_react_marker("OVERLAY", json.dumps(ov))
                    logger.info("Auto-emitted OVERLAY for skill %s: %s", skill_name, ov.get("path", ""))
                except Exception:
                    pass
            return json.dumps(result, indent=2, default=str)
        return str(result)
    except Exception as e:
        logger.exception("Skill %s failed", skill_name)
        return f"Error running skill {skill_name}: {e}"


def read_file(file_path: str) -> str:
    """Read a file from the workspace."""
    p = Path(file_path.strip())
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    try:
        p.resolve().relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        return f"Error: Access denied. Can only read from {PROJECT_ROOT}"
    try:
        return p.read_text()[:8000]
    except Exception:
        return f"Error: File not found: {file_path}"


def list_files(dir_path: str) -> str:
    """List files in a directory."""
    p = Path(dir_path.strip())
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    try:
        p.resolve().relative_to(PROJECT_ROOT.resolve())
    except ValueError:
        return "Error: Access denied."
    try:
        files = sorted(p.iterdir())
        return "\n".join(f.name for f in files)
    except Exception:
        return f"Error: Directory not found: {dir_path}"


def parse_action(content: str):
    """Parse Action and Action Input from LLM response."""
    m = re.search(r"Action:\s*(.+?)[\n\r]+Action Input:\s*([\s\S]+)", content, re.IGNORECASE)
    if m:
        action = m.group(1).strip()
        action_input = m.group(2).strip()
        for marker in ["Thought:", "Final Answer:"]:
            idx = action_input.find(f"\n{marker}")
            if idx != -1:
                action_input = action_input[:idx].strip()
        return action, action_input

    m = re.search(r"Action:\s*(.+?)[\n\r]+(?:Action Input:)?\s*```(?:python)?\n([\s\S]*?)```", content, re.IGNORECASE)
    if m:
        return m.group(1).strip(), m.group(2).strip()

    return None, None


def parse_final_answer(content: str):
    m = re.search(r"Final Answer:\s*([\s\S]*?)$", content, re.IGNORECASE)
    return m.group(1).strip() if m else None


def extract_thought(content: str) -> str:
    m = re.search(r"Thought:\s*([\s\S]*?)(?=\nAction:|\nFinal Answer:|\Z)", content, re.IGNORECASE)
    return m.group(1).strip()[:300] if m else ""


def strip_code_fences(text: str) -> str:
    code = text.strip()
    m = re.match(r'^```(?:python|py)?\s*\n([\s\S]*?)```\s*$', code, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    lines = code.splitlines()
    if lines and lines[0].strip().startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    result = "\n".join(lines).strip()
    if result.endswith("```"):
        result = result[:-3].strip()
    return result


def run_agent(prompt: str, study_uid: str | None = None,
              extra_clinical_context: str | None = None,
              overlays_json: str | None = None,
              ct_series_uid: str | None = None,
              pet_series_uid: str | None = None) -> str:
    """Run the ReAct agent loop."""
    logger.info("=" * 60)
    logger.info("NEW SESSION  prompt=%s  study=%s", prompt[:200], study_uid or "(none)")
    logger.info("=" * 60)

    skills = discover_skills()
    logger.info("Discovered %d skills: %s", len(skills), list(skills.keys()))

    system_prompt = build_system_prompt(skills, study_uid=study_uid,
                                        extra_clinical_context=extra_clinical_context,
                                        overlays_json=overlays_json,
                                        ct_series_uid=ct_series_uid,
                                        pet_series_uid=pet_series_uid)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": prompt},
    ]

    empty_retries = 0

    for i in range(MAX_ITERATIONS):
        logger.info("── Iteration %d/%d ──", i + 1, MAX_ITERATIONS)
        emit_react_marker("ITERATION", f"{i+1}/{MAX_ITERATIONS}")
        content = query_llm(messages)

        if content.startswith("API Error") or content.startswith("Error:"):
            logger.error("Agent aborted: %s", content[:300])
            return content

        if not content.strip():
            empty_retries += 1
            if empty_retries >= 3:
                return "The model returned empty responses repeatedly. Please try again."
            messages.append({"role": "assistant", "content": "Thought: Let me continue."})
            messages.append({"role": "user", "content": "Please continue with Action or Final Answer."})
            continue

        empty_retries = 0
        messages.append({"role": "assistant", "content": content})
        logger.debug("LLM response:\n%s", content[:2000])

        thought = extract_thought(content)
        if thought:
            emit_react_marker("THOUGHT", thought)

        final = parse_final_answer(content)
        if final:
            # Process any embedded REACT markers before returning
            for line in final.splitlines():
                m = re.match(r'\[REACT:(\w+)](.*)', line.strip())
                if m:
                    emit_react_marker(m.group(1), m.group(2))
            # Strip REACT markers from the user-visible answer
            final = "\n".join(
                l for l in final.splitlines()
                if not re.match(r'\s*\[REACT:\w+]', l)
            ).strip()
            logger.info("FINAL ANSWER (len=%d)", len(final))
            emit_react_marker("FINAL", final[:200])
            return final

        action, action_input = parse_action(content)
        if action:
            logger.info("Action: %s", action)
            emit_react_marker("ACTION", action)

            if action.lower() == "propose_plan":
                emit_react_marker("PLAN", action_input)
                logger.info("Plan proposed, waiting for approval...")
                approval = sys.stdin.readline().strip()
                if approval.startswith("MODIFY:"):
                    modify_content = approval[7:]
                    observation = f"User requested modifications: {modify_content}\nPlease revise the plan."
                else:
                    observation = "Plan approved by user. Proceed with execution."

            elif action.lower() == "use_skill":
                # Parse: use_skill(skill_name, key=value, ...)
                m = re.match(r'(\w+)(?:\s*,\s*(.*))?', action_input.strip(), re.DOTALL)
                if m:
                    skill_name = m.group(1)
                    kwargs_str = m.group(2) or ""
                    observation = run_skill(skills, skill_name, kwargs_str)
                else:
                    observation = f"Error: Could not parse skill call: {action_input}"

            elif action.lower() == "execute_python":
                code = strip_code_fences(action_input)
                logger.debug("Python code:\n%s", code[:1500])
                observation = execute_python(code)

            elif action.lower() == "read_file":
                observation = read_file(action_input)

            elif action.lower() == "list_files":
                observation = list_files(action_input)

            else:
                observation = f"Unknown action: {action}. Available: use_skill, execute_python, propose_plan, read_file, list_files"

            logger.info("Observation (len=%d): %s", len(observation), observation[:300])
            emit_react_marker("OBSERVATION", observation[:300])
            messages.append({"role": "user", "content": f"Observation: {observation}"})
        else:
            messages.append({"role": "user", "content": "Please provide an Action or Final Answer."})

    return "Agent reached maximum iterations without a final answer."


def main():
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    parser = argparse.ArgumentParser(description="DICOMclaw - Local Agent")
    parser.add_argument("--prompt", required=True, help="User prompt")
    parser.add_argument("--study-uid", default=None, help="Study UID for clinical context")
    parser.add_argument("--clinical-context", default=None, help="Extra clinical context from user")
    parser.add_argument("--overlays", default=None, help="JSON array of overlay/VOI metadata")
    parser.add_argument("--ct-series", default=None, help="Pre-selected CT series UID")
    parser.add_argument("--pet-series", default=None, help="Pre-selected PET series UID")
    args = parser.parse_args()

    logger.info("Agent started  model=%s  study=%s", os.environ.get("OPENROUTER_MODEL", "?"),
                args.study_uid or "(none)")
    try:
        result = run_agent(args.prompt, study_uid=args.study_uid,
                           extra_clinical_context=args.clinical_context,
                           overlays_json=args.overlays,
                           ct_series_uid=args.ct_series,
                           pet_series_uid=args.pet_series)
        print(result)
        logger.info("Agent finished  result_len=%d", len(result))
    except Exception:
        logger.exception("Agent crashed")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
