import importlib.util
from pathlib import Path
import unittest
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("board", Path(__file__).parents[1] / "tools/board.py")
board = importlib.util.module_from_spec(spec)
spec.loader.exec_module(board)


class BoardTests(unittest.TestCase):
    def test_mentions_match_complete_handles(self):
        self.assertTrue(board.mentioned("Help @IBRAHIM-ALII!", "ibrahim-alii"))
        self.assertTrue(board.mentioned("Update @all", "ibrahim-alii"))
        self.assertFalse(board.mentioned("@ibrahim-alii-other @allison", "ibrahim-alii"))

    @patch.dict(board.os.environ, {"BOARD_ISSUE": "7"})
    def test_explicit_issue(self):
        self.assertEqual(board.issue_number(), 7)

    @patch.dict(board.os.environ, {"BOARD_ISSUE": "-1"})
    def test_invalid_issue(self):
        with self.assertRaises(ValueError):
            board.issue_number()

    @patch.dict(board.os.environ, {}, clear=True)
    @patch.object(board, "gh", return_value='[{"number":4,"title":"Agent Message Board"}]')
    def test_board_discovery(self, gh):
        self.assertEqual(board.issue_number(), 4)

    @patch.dict(board.os.environ, {}, clear=True)
    @patch.object(board, "gh", return_value='[]')
    def test_missing_board_has_actionable_error(self, gh):
        with self.assertRaisesRegex(ValueError, "Create one"):
            board.issue_number()

    @patch.object(board, "gh", return_value='[[{"id":1}],[{"id":2}]]')
    def test_reads_all_comment_pages(self, gh):
        self.assertEqual(board.comments(1), [{"id": 1}, {"id": 2}])

    @patch.object(board, "issue_number", return_value=1)
    @patch.object(board, "gh", return_value="ibrahim-alii")
    def test_unread_persists_cursor_and_read_does_not_change_it(self, gh, issue):
        row = {"id": 12, "body": "@all ready", "html_url": "https://example.test/comment",
               "user": {"login": "teammate"}}
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "tools" / "board.py"
            with patch.object(board, "__file__", str(script)), patch.object(
                    board, "comments", return_value=[row]), patch("builtins.print") as output:
                with patch.object(board.sys, "argv", ["board", "unread"]):
                    board.main()
                cursor = Path(directory) / ".board-state/board-1-ibrahim-alii.json"
                self.assertEqual(cursor.read_text(), "12")
                output.reset_mock()
                with patch.object(board.sys, "argv", ["board", "unread"]):
                    board.main()
                output.assert_not_called()
                with patch.object(board.sys, "argv", ["board", "read"]):
                    board.main()
                self.assertEqual(cursor.read_text(), "12")
                output.assert_called_once()

    @patch.object(board, "issue_number", return_value=1)
    @patch.object(board, "gh", return_value="ibrahim-alii")
    def test_post_preserves_message_in_body_file(self, gh, issue):
        message = "[Ibrahim's Codex] @all literal $value and `code`\nsecond line"
        def command(*args):
            if args[0] == "api":
                return "ibrahim-alii"
            self.assertEqual(Path(args[-1]).read_text(encoding="utf-8"), message)
            return "https://example.test/comment"
        gh.side_effect = command
        with patch.object(board.sys, "argv", ["board", "post", message]), patch("builtins.print"):
            board.main()

    @patch.object(board, "issue_number", return_value=1)
    @patch.object(board, "gh", return_value="ibrahim-alii")
    def test_wait_times_out_without_sleeping_past_deadline(self, gh, issue):
        with tempfile.TemporaryDirectory() as directory, patch.object(
                board, "__file__", str(Path(directory) / "tools/board.py")), patch.object(
                board, "comments", return_value=[]), patch.object(
                board.time, "monotonic", side_effect=[0, 60]), patch.object(
                board.time, "sleep") as sleep, patch("builtins.print"):
            with patch.object(board.sys, "argv", ["board", "wait"]):
                board.main()
            sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
