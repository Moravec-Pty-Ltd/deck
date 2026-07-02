---
name: dev-workflow
description: End-to-end workflow for a GitHub issue in the current repo - fetch the issue, branch off the latest default branch, implement the change, run the project's checks, self-review with the dev-review skill, then open a PR that closes the issue. Use when taking a GitHub issue from ticket to open PR, e.g. the user says "dev workflow", "work this issue", or gives a GitHub issue ref (owner/repo#N or an issue URL). The skill stops once the PR is open; addressing reviewer feedback afterward is a separate follow-up.
---

# Dev workflow

Take a GitHub issue from ticket to an open PR. Runs autonomously; pause only when
the issue is genuinely ambiguous or a step fails. This skill is standalone and
generic: plain GitHub issues and PRs, no external trackers or deploy steps. It
pairs with the sibling [dev-review](../dev-review/SKILL.md) skill.

## Inputs

- **Issue** (required): a GitHub issue ref (`owner/repo#N`, an `.../issues/N`
  URL, or a bare `#N` for the current repo). If not given, ask.
- **base-branch** (optional): the branch to start from and target the PR at.
  Defaults to the repo's default branch.
- **reviewer** (optional): a GitHub login, a comma-separated list, or `none`.
  Requested on the PR. Defaults to no reviewer.
- **Branch** (optional): if told to work in the current branch, skip branch
  creation.
- **Extra context** (optional): instructions, links, or images the user passes.
  Fold them into the work.

## Prerequisites

- Work in the current directory; assume the cwd is the right repo. Do not ask
  which.
- `gh` is authenticated and the working tree is clean (or its changes belong to
  this task).

## Workflow

1. **Read the issue** - `gh issue view <ref> --json number,title,body,comments`.
   Capture the number, title, body, and any comments; merge in the user's extra
   context. If the issue embeds images, `Read` them before implementing.

2. **Branch off the base** (unless working in the current branch):
   - Resolve `<base>` (override, else the repo default branch) and `git fetch origin`.
   - `git checkout <base> && git pull --ff-only origin <base>`.
   - Create the branch, linked to the issue so it shows on the issue and the PR
     can auto-close it: `gh issue develop <N> --base <base> --name <branch> --checkout`.
     Pick a short, descriptive branch name.
   - If working in an existing branch instead, bring the base in first
     (`git merge origin/<base>`, or `git rebase origin/<base>` if the branch
     isn't shared). Resolve conflicts; stop and surface if they can't be
     resolved cleanly.

3. **Implement** - make the smallest change that satisfies the issue. Understand
   the surrounding flow first, reuse what's already there, prefer the standard
   library and existing dependencies over new ones, and fix root causes rather
   than symptoms. Match the repo's conventions (read its `AGENTS.md` /
   `CONTRIBUTING.md` if present). Never strip out validation, security, or error
   handling to make something shorter.

4. **Tests** - add or update tests as the change requires.

5. **Checks** - run the project's own test / typecheck / lint commands and get
   them green. Detect them from the repo rather than assuming: for example a
   `package.json` might expose `pnpm check && pnpm test`, a Makefile a `make test`,
   a Python project `ruff check && pytest`. If the repo documents its commands
   (README, `AGENTS.md`, `CONTRIBUTING.md`), use those.

6. **Self-review** - run the [dev-review](../dev-review/SKILL.md) skill over the
   branch's changes and address its findings before opening the PR. Spawn it as a
   subagent to keep this context lean.

7. **Commit and open the PR**:
   - Commit with a clear message describing the change and why.
   - `git push -u origin <branch>`.
   - `gh pr create --base <base>` with a title and body drawn from the issue.
     Include `Closes #<N>` in the body so the issue links and auto-closes on
     merge.
   - Request reviewers if any were given: `gh pr create ... --reviewer a,b`
     (skip when `none`).

8. **Report** - the PR URL, plus any follow-up issues you filed for out-of-scope
   work.

Do not merge; opening the PR is the end of this skill. When reviewers respond
later, address the feedback as a separate follow-up: check the branch back out,
make the fixes, rerun the checks and the [dev-review](../dev-review/SKILL.md)
skill, push, then reply on the review threads (resolving each once addressed).

## Conventions

- **Smallest change that solves it.** Reuse before writing, standard library
  before new dependencies, root cause over symptom. Never simplify away
  validation, security, or error handling.
- **Clear prose** in the commit message and PR description: state what changed
  and why, substance over ceremony.
- **One logical change per PR.** File anything out of scope as its own follow-up
  issue rather than folding it in.
