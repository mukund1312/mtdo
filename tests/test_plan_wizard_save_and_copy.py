"""Regression test for gh74: save_and_copy() must check pbcopy's actual return
code, not just whether the subprocess call raised -- a silent pbcopy failure
(runs, but doesn't actually set the clipboard) used to still report
copied=True.
"""
from unittest.mock import MagicMock, patch

from mtdo import plan_wizard


def test_save_and_copy_reports_true_when_pbcopy_succeeds():
    result = MagicMock(returncode=0)
    with patch("mtdo.plan_wizard.subprocess.run", return_value=result):
        path, copied = plan_wizard.save_and_copy("some prompt text")
    assert copied is True
    assert path == plan_wizard.PROMPT_OUTPUT_PATH


def test_save_and_copy_reports_false_when_pbcopy_exits_nonzero():
    result = MagicMock(returncode=1)
    with patch("mtdo.plan_wizard.subprocess.run", return_value=result):
        path, copied = plan_wizard.save_and_copy("some prompt text")
    assert copied is False


def test_save_and_copy_reports_false_when_pbcopy_raises():
    with patch("mtdo.plan_wizard.subprocess.run", side_effect=OSError("no pbcopy")):
        path, copied = plan_wizard.save_and_copy("some prompt text")
    assert copied is False


def test_save_and_copy_always_writes_the_file_regardless_of_clipboard_outcome():
    result = MagicMock(returncode=1)
    with patch("mtdo.plan_wizard.subprocess.run", return_value=result):
        path, _copied = plan_wizard.save_and_copy("written content here")
    with open(path) as f:
        assert f.read() == "written content here"
