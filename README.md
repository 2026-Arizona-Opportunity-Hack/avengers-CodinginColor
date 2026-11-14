# avengers — Coding in Color

Built at [ASU Fall Hackathon 2026 | Phoenix Hackathon for Nonprofits: Nov 14-15](https://www.ohack.dev/hack/fall-2026) for the public good (MIT license).

> **⚠️ This is your team's ONE repository — all code goes here.** Please don't create
> another repo (personal or org). Judges, the Team Dashboard's code-activity card,
> the public project page and the nonprofit all read **this** repo; work pushed
> anywhere else is invisible to them and won't count. Everyone on the team should be
> a collaborator here — ask an organizer in Slack if someone can't push.

| | |
|---|---|
| **Nonprofit** | [Coding in Color](https://www.ohack.dev/nonprofit/YIXYdYCoxIZC08uQ5DL3) |
| **Problem statement** | [Donor & Funder Relationship Platform (CIC Problem 2)](https://www.ohack.dev/project/e26932c0df1b11f189a8dead68f07eb5) |
| **Team page** | [avengers](https://www.ohack.dev/hack/fall-2026/team/959f5c24e05811f1adacdeadb145c312) · [Team Dashboard](https://www.ohack.dev/hack/fall-2026/manageteam) (story, demo video, submit) |
| **Slack** | team: [#avengers](https://opportunity-hack.slack.com/app_redirect?channel=avengers) · nonprofit: [#npo-coding-in-color](https://opportunity-hack.slack.com/app_redirect?channel=npo-coding-in-color) · help: [#ask-a-mentor](https://opportunity-hack.slack.com/archives/C01E5CGDQ74) |
| **Created by** | Greg V [Staff/Mentor] |

## Final day

Start recording your demo video by **Sun Nov 15, 12:00 PM MST** — hacking ends at **Sun Nov 15, 2:00 PM MST**, and a demo you recorded with time to spare beats a feature you finished at 1:59.

- Sun Nov 15, 11:00 AM MST — Presentation Feedback Hour
- **Sun Nov 15, 12:00 PM MST — Start recording your demo video**
- Sun Nov 15, 12:30 PM MST — Judges Arrive
- **Sun Nov 15, 2:00 PM MST — 🛑 Submission Deadline: Hacking ends**
- Sun Nov 15, 2:05 PM MST — Judging Round 1
- Sun Nov 15, 3:40 PM MST — Judging Final Round
- Sun Nov 15, 4:30 PM MST — Closing Ceremony: Winners Announced

## Before hacking ends — the submission checklist

Everything is submitted from your [Team Dashboard](https://www.ohack.dev/hack/fall-2026/manageteam); judges read the dashboard, this README and your demo video.

- [ ] **Code pushed** to this repo, in small PRs (see `AGENTS.md`) — judges and future recruiters read the history
- [ ] **Project story** written on the dashboard (`#project`): the problem, who it helps, what you built, what's next
- [ ] **Demo video** (4 minutes or less) on YouTube, Vimeo, Loom or Google Drive, linked on the dashboard (`#demo`) — show it working, not slides
- [ ] **Submit** on the dashboard (you can keep editing until the close)
- [ ] This README filled in below: team, tech stack, how to run it, live link if you have one
- Optional: a [DevPost entry](https://opportunity-hack-2026-arizona.devpost.com/) — the dashboard is the submission of record.

Judges score **Scope, Documentation, Polish and Security**, plus a separate **Accessibility** prize — the rubric is at [ohack.dev/hackathon-judging-criteria](https://www.ohack.dev/hackathon-judging-criteria). Document your work as GitHub Issues as you go: that's how you get public credit for it.

## Team

- Ash — UI and shared visual components (Person 3)
- [Ibrahim Ali](https://github.com/ibrahim-alii) — core backend and Orca coordination (Person 2)
- Aayan Mapara — data ingestion and reconciliation (Person 1)
- [Soumya Mejari](https://github.com/smejari1) — outreach and follow-ups (Person 4)
- [Nathan Narrik](https://github.com/nathannarik) — reporting, deployment and integration QA (Person 5)

## What we built

<!-- Two or three sentences: the problem, who it helps, what the nonprofit can do now that they couldn't before -->

Project requirements and delivery roles: [CIC Donor Platform Implementation Plan](CIC_Donor_Platform_Implementation_Plan.pdf).
This is the planning source of truth; its proposed features are not implemented yet.

## Tech stack

- Frontend:
- Backend:
- Database:
- APIs / services:

## Run it locally

```bash
git clone https://github.com/2026-Arizona-Opportunity-Hack/avengers-CodinginColor.git
cd avengers-CodinginColor
cp .env.example .env   # fill in your own values — never commit .env
# install + start commands here
```

## Links

- Live demo:
- Demo video:
- Design / docs:

## Agent message board

Coordination follows the [Hackathon Agent Board guide](https://marvelous-relative-5de.notion.site/hack).
This repository has an original Python implementation; no extra Python packages
are required. Install Python 3 and GitHub CLI, then run `gh auth login`.

Create one issue using the **Agent message board** template and pin it in GitHub.
The CLI discovers an open issue titled exactly **Agent Message Board**. To select
a different issue, set `BOARD_ISSUE` (PowerShell: `$env:BOARD_ISSUE = '7'`).

```text
python tools/board.py whoami
python tools/board.py read -n 20
python tools/board.py unread
python tools/board.py post "[Ibrahim's Codex] @all board tooling is ready for review"
python tools/board.py wait --interval 30 --timeout 60
python -m unittest discover -s tests
```

`unread` and `wait` mark displayed comments read. `read` leaves the cursor alone.
Messages tagging your GitHub login or `@all` are flagged MENTION. Waiting returns
on a new post from another GitHub account or after the timeout; it does not launch
an agent automatically. Polls read all comment pages, so increase the interval
for large boards. Authentication and API errors stop the command visibly.

Local cursors live in ignored `.board-state/`, separately per issue and GitHub
login. Sessions sharing a checkout and login share a cursor; use separate Orca
worktrees for independent readers. Delete a cursor to replay existing comments.
Set teammate ownership in AGENTS.md before parallel edits. Claude reads those
instructions through CLAUDE.md; Codex and other agents should read AGENTS.md.
Claude hooks check unread posts at session start and on each prompt. A missing
board or unavailable GitHub connection is reported without blocking the session.
Existing Claude clock and secret-guard hooks remain active.

## After the hackathon

Winning teams finish the project with the nonprofit — the [Definition of Done](https://www.ohack.dev/about/completion) (deployed, nonprofit sign-off, docs, open source) is tracked on your team page. Keep the repo public and the README honest; recruiters do read these.

Need a hand this weekend? [#ask-a-mentor](https://opportunity-hack.slack.com/archives/C01E5CGDQ74) on Slack, or ask in [#avengers](https://opportunity-hack.slack.com/app_redirect?channel=avengers) and a mentor will drop in.
