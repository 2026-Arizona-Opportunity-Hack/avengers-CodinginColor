"""Shared GitHub issue board. Requires Python 3 and authenticated gh."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

REPO = "2026-Arizona-Opportunity-Hack/avengers-CodinginColor"
TITLE = "Agent Message Board"


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True,
                          text=True, encoding="utf-8").stdout.strip()


def issue_number():
    configured = os.environ.get("BOARD_ISSUE")
    if configured:
        if not configured.isdecimal() or int(configured) < 1:
            raise ValueError("BOARD_ISSUE must be a positive issue number")
        return int(configured)
    issues = json.loads(gh("issue", "list", "--repo", REPO, "--state", "open",
                           "--search", f'"{TITLE}" in:title', "--json", "number,title"))
    matches = [i["number"] for i in issues if i["title"] == TITLE]
    if len(matches) != 1:
        raise ValueError("Create one Agent Message Board issue, or set BOARD_ISSUE")
    return matches[0]


def mentioned(body, login):
    return bool(re.search(r"(?<![\w@])@(?:" + re.escape(login) + r"|all)(?![\w-])",
                          body, re.IGNORECASE))


def comments(issue):
    pages = json.loads(gh("api", "--paginate", "--slurp",
                          f"repos/{REPO}/issues/{issue}/comments?per_page=100"))
    return [comment for page in pages for comment in page]


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("whoami")
    read = subs.add_parser("read")
    read.add_argument("-n", type=positive, default=20)
    subs.add_parser("unread")
    post = subs.add_parser("post")
    post.add_argument("message", nargs="?")
    wait = subs.add_parser("wait")
    wait.add_argument("--interval", type=positive, default=30)
    wait.add_argument("--timeout", type=positive, default=60)
    args = parser.parse_args()
    login = gh("api", "user", "--jq", ".login")
    if args.command == "whoami":
        print(login)
        return
    issue = issue_number()
    if args.command == "post":
        message = args.message if args.message is not None else sys.stdin.read()
        if not re.match(r"^\[[^\]\r\n]+\]\s+\S", message):
            raise ValueError("Start messages with [Human's Agent] followed by text")
        # A file preserves literal text and avoids shell interpolation.
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            body = Path(directory) / "message.md"
            body.write_text(message, encoding="utf-8")
            print(gh("issue", "comment", str(issue), "--repo", REPO,
                     "--body-file", str(body)))
        return
    metadata = Path(__file__).resolve().parent.parent / ".board-state"
    metadata.mkdir(exist_ok=True)
    cursor = metadata / f"board-{issue}-{login}.json"
    seen = json.loads(cursor.read_text(encoding="utf-8")) if cursor.exists() else 0
    if not isinstance(seen, int) or seen < 0:
        raise ValueError("Invalid board cursor; remove the local cursor file and retry")
    deadline = time.monotonic() + getattr(args, "timeout", 60)
    while True:
        rows = comments(issue)
        selected = rows[-args.n:] if args.command == "read" else [
            row for row in rows if row["id"] > seen]
        for row in selected:
            flag = " MENTION" if mentioned(row["body"], login) else ""
            print(f"{row['html_url']} @{row['user']['login']}{flag}\n{row['body']}\n")
        if args.command != "read" and rows:
            seen = max(row["id"] for row in rows)
            cursor.write_text(json.dumps(seen), encoding="utf-8")
        if args.command != "wait" or any(row["user"]["login"] != login for row in selected):
            return
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print("No new posts from teammates before timeout.")
            return
        time.sleep(min(args.interval, remaining))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"board: {getattr(error, 'stderr', None) or error}", file=sys.stderr)
        sys.exit(1)
