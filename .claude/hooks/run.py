"""Run the existing shell hooks without selecting Windows' WSL launcher."""
import os
from pathlib import Path
import shutil
import subprocess
import sys


def find_bash():
    if sys.platform != "win32":
        return shutil.which("bash")
    git = shutil.which("git")
    roots = [Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git"]
    if git:
        roots.insert(0, Path(git).resolve().parent.parent)
    for root in roots:
        candidate = root / "bin" / "bash.exe"
        if candidate.is_file():
            return str(candidate)
    return None


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("session-clock", "guard-secrets", "board-unread"):
        print("hook: expected session-clock, guard-secrets or board-unread", file=sys.stderr)
        return 2
    if sys.argv[1] == "board-unread":
        root = Path(__file__).resolve().parents[2]
        result = subprocess.run([sys.executable, str(root / "tools/board.py"), "unread"], cwd=root)
        # Automatic reminders are advisory; explicit board commands still fail visibly.
        if result.returncode:
            print("hook: board check unavailable; unread messages were not verified. Retry the explicit board command before claiming or committing.", file=sys.stderr)
        return 0
    bash = find_bash()
    if not bash:
        print("hook: Bash unavailable; install Git for Windows or Bash on Unix.", file=sys.stderr)
        return 2
    hook = Path(__file__).resolve().parent / (sys.argv[1] + ".sh")
    # Inherit stdin so the secret guard receives the original tool event.
    try:
        return subprocess.run([bash, str(hook)], cwd=hook.parent.parent.parent).returncode
    except OSError as error:
        print(f"hook: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
