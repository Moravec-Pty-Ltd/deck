---
name: dev-review
description: Standalone pre-PR review of the current branch's changes - committed changes vs the auto-detected base plus staged and unstaged working-tree edits. Two passes - correctness/quality (real bugs, security, error handling, broken contracts, missing tests, severity-tagged) and over-engineering (what to delete). Lists findings for the caller to fix; it does not apply changes or open a PR. Use standalone when the user says "dev review", "review my changes", or "what can we delete", or as the review step inside dev-workflow.
---

# Dev review

Review the working branch's changes and report findings. This skill does not
edit code or open a PR; it lists what to fix. Usable standalone or as the review
step inside the [dev-workflow](../dev-workflow/SKILL.md) skill.

## Scope

Review everything the branch has changed, not just what's committed:

1. **Detect the base.** Find the branch this diverged from (e.g. the default
   branch, or the merge-base with `origin/HEAD`). If unclear, ask or fall back to
   the repo's default branch.
2. **Gather the changes:**
   - committed: `git diff <base>...HEAD`
   - staged: `git diff --cached`
   - unstaged: `git diff`
   - untracked files worth reviewing: `git status --short`
3. Read enough surrounding code to judge each change in context. Don't review the
   diff in isolation when the correctness of a change depends on code it touches.

## Pass 1 - correctness and quality

Hunt for real problems. Tag each finding with a severity:

- **critical** - data loss, security holes (injection, auth bypass, secret
  leakage, unsafe deserialization), crashes on realistic input, corruption.
- **high** - logic bugs, broken or unhandled error paths, race conditions,
  broken API/contract changes, resource leaks.
- **medium** - missing or inadequate tests for the new behaviour, edge cases not
  handled, misleading names, unclear failure modes.
- **low** - minor robustness or readability issues.

For each finding give the file and line, what's wrong, the concrete input or
state that triggers it, and a suggested fix. Skip style nits the project's
linter already covers.

## Pass 2 - over-engineering

Separately, look for what to delete or shrink. Great changes are as small as they
can be:

- Reinvented standard library or built-in framework features.
- Needless new dependencies for something small.
- Speculative abstractions, options, or configurability nothing uses yet (YAGNI).
- Code that could be materially shorter or simpler with no loss of behaviour.
- Dead code, unreachable branches, redundant checks.

Point at the specific lines and say what to remove or collapse. Do not propose
removing validation, security, or error handling.

## Output

Report both passes as a single list the caller can act on, most severe first.
Lead with a one-line verdict (e.g. "2 high, 1 medium; plus 3 deletions"). If a
pass is clean, say so. Do not apply changes - hand the findings back to the
caller (or to `dev-workflow`, which will address them before opening the PR).
