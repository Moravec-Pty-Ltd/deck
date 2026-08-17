# Contributing to deck

Thanks for your interest in deck. It's a single-user tool that someone decided to
share, so the bar for contributions is "does it stay simple and keep working",
not "does it cover every use case". Small, focused changes are easiest to accept.

## Getting set up

You'll need the things listed under [Requirements](README.md#requirements):
Node 20+, [pnpm](https://pnpm.io), the `claude` CLI, plus `tmux` and `git`.

```sh
pnpm install
pnpm dev        # vite dev server
```

Only one deck server may own a data directory at a time. If another one is
already running against `~/.deck`, boot refuses and names the holder's pid and
port. To run a second server (a worktree checkout alongside your main instance,
say), give it its own directory:

```sh
DECK_DATA=~/.deck-worktree PORT=4819 pnpm dev
```

To run the production build locally:

```sh
pnpm build
PORT=4818 node build/index.js
```

## Before you open a pull request

Run both of these and make sure they're clean:

```sh
pnpm check      # svelte-check: types and Svelte diagnostics
pnpm audit      # fallow: dead code, complexity, duplication
```

A husky pre-commit hook runs `fallow audit` against your upstream/base on every
commit. It only flags *newly introduced* findings, so pre-existing issues won't
block you. If `pnpm`/`fallow` isn't on the machine, the hook skips quietly.

## Pull requests

- Branch off `main` and keep each PR to one logical change.
- Match the surrounding style: tabs, no em dashes, minimal comments (only when the
  *why* isn't obvious), no emoji in UI code.
- Update `README.md` if you change behaviour, env vars, or setup steps.
- Describe what changed and why. Link an issue if there is one.

## Reporting bugs and ideas

Open a GitHub issue. For bugs, include what you ran, what you expected, and what
happened (a snippet of the JSONL transcript or server log helps). For features,
describe the workflow you're trying to support before the implementation you have
in mind.

## Scope

deck is intentionally a one-machine, one-user tool. Changes that add multi-user
auth, accounts, or hosted-service machinery are likely out of scope. If you're
unsure whether something fits, open an issue to discuss it before building.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
