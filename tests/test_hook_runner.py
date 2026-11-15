import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "hook_runner", Path(__file__).resolve().parents[1] / ".claude/hooks/run.py"
)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class HookRunnerTests(unittest.TestCase):
    def test_windows_uses_git_bash_instead_of_path_bash(self):
        with patch.object(runner.sys, "platform", "win32"), \
             patch.object(runner.shutil, "which", return_value="C:/Git/cmd/git.exe"), \
             patch.object(runner.Path, "is_file", return_value=True):
            self.assertTrue(runner.find_bash().replace("\\", "/").endswith("Git/bin/bash.exe"))

    def test_unix_uses_installed_bash(self):
        with patch.object(runner.sys, "platform", "linux"), \
             patch.object(runner.shutil, "which", return_value="/bin/bash"):
            self.assertEqual(runner.find_bash(), "/bin/bash")

    def test_missing_bash_fails_closed(self):
        with patch.object(runner.sys, "argv", ["run.py", "guard-secrets"]), \
             patch.object(runner, "find_bash", return_value=None):
            self.assertEqual(runner.main(), 2)

    def test_guard_status_is_preserved_and_stdin_inherited(self):
        with patch.object(runner.sys, "argv", ["run.py", "guard-secrets"]), \
             patch.object(runner, "find_bash", return_value="bash"), \
             patch.object(runner.subprocess, "run") as run:
            run.return_value.returncode = 2
            self.assertEqual(runner.main(), 2)
            self.assertNotIn("stdin", run.call_args.kwargs)
            self.assertTrue(run.call_args.args[0][1].endswith("guard-secrets.sh"))

    def test_automatic_board_failure_warns_without_blocking_prompt(self):
        with patch.object(runner.sys, "argv", ["run.py", "board-unread"]), \
             patch.object(runner.subprocess, "run") as run, \
             patch.object(runner.sys, "stderr") as stderr:
            run.return_value.returncode = 1
            self.assertEqual(runner.main(), 0)
            self.assertEqual(run.call_args.args[0][-1], "unread")
            self.assertTrue(stderr.write.called)
