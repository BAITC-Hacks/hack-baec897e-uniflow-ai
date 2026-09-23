"""Verify unmodified organizer inputs and a portable, offline competition delivery.

Run after `python make_submission.py` from participant_package.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

PACKAGE = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    protected = [PACKAGE / name for name in (
        "environment.py", "scoring_core.py", "mock_environment.py", "local_eval.py",
        "make_submission.py", "agent_template.py")]
    protected += sorted(p for p in PACKAGE.glob("*.csv") if p.name != "submission.csv")
    protected += sorted((PACKAGE / "data").glob("*.csv"))
    integrity = []
    for path in protected:
        relative = path.relative_to(PACKAGE.parent).as_posix()
        original = subprocess.run(["git", "show", f"HEAD:{relative}"], cwd=PACKAGE.parent,
                                  capture_output=True, check=True).stdout
        current = path.read_bytes()
        # Git may normalize CRLF. Compare text with its tracked line-ending policy.
        matches = current.replace(b"\r\n", b"\n") == original.replace(b"\r\n", b"\n")
        integrity.append({"path": relative, "sha256": digest(current),
                          "unchanged_from_git_head": matches})
        if not matches:
            raise AssertionError(f"Organizer input modified: {relative}")
    submission = (PACKAGE / "submission.csv").read_bytes()
    with tempfile.TemporaryDirectory(prefix="uniflow-delivery-") as temporary:
        delivery = Path(temporary).resolve()
        # An explicit set of files, with no repository, web server or frontend.
        for name in ("agent.py", "environment.py", "mock_environment.py", "make_submission.py",
                     "customer_profile.csv"):
            shutil.copy2(PACKAGE / name, delivery / name)
        (delivery / "uniflow").mkdir()
        for path in (PACKAGE / "uniflow").glob("*.py"):
            shutil.copy2(path, delivery / "uniflow" / path.name)
        (delivery / "data").mkdir()
        for name in ("change_tariff.csv", "dict_tariff.csv"):
            shutil.copy2(PACKAGE / "data" / name, delivery / "data" / name)
        code = ("import runpy,sys; runpy.run_path('make_submission.py', run_name='__main__'); "
                "assert 'fastapi' not in sys.modules; assert 'scoring_core' not in sys.modules")
        process = subprocess.run([sys.executable, "-c", code], cwd=delivery, capture_output=True,
                                 text=True, encoding="utf-8", errors="replace", timeout=300)
        if process.returncode:
            raise RuntimeError(f"Isolated delivery failed: {process.stdout}\n{process.stderr}")
        clean_bytes = (delivery / "submission.csv").read_bytes()
        if clean_bytes != submission:
            raise AssertionError("Isolated delivery differs from saved submission")
    result = {"organizer_files": integrity, "all_originals_unchanged": True,
              "clean_copy_submission_matches": True, "submission_sha256": digest(submission),
              "core_imports_fastapi": False, "core_imports_scorer": False}
    output = PACKAGE / "reports" / "delivery_verification.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in result.items() if k != "organizer_files"}))


if __name__ == "__main__":
    main()
