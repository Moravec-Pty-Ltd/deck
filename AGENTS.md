# AGENTS.md

Guidance for AI agents working in this repo. For the human-facing version, see
[CONTRIBUTING.md](CONTRIBUTING.md).

deck is a single-user, single-machine tool (SvelteKit + Svelte 5) for driving
Claude Code sessions and tmux terminals from one browser app, with native
SwiftUI clients in `apps/ios`. **This repository is public.**

## Public repo: never reference specific clients

Because this repo is public, never put the name of a specific client, customer,
tenant, employer's project, private repository, or any real local path into
anything committed here: source, comments, tests, fixtures, demo data, commit
messages, branch names, PR text, GitHub issues, or screenshots.

Use neutral placeholders instead: `acme`, `example`, `apps/web`, `frontend/app`,
`/path/to/project`, `~/code/deck`, ports like `3000`. Real project paths and
client names live only in the user's local `~/.deck/` data, which is not part of
this repo. Keep it that way. Screenshots must use the curated demo sessions, not
real work. If you spot a real client name anywhere in the tree or history, stop
and flag it.

(The "deck" name and the project's own brand mark and palette are intentional.)

## Commands

```sh
pnpm install
pnpm dev                                      # vite dev server
pnpm test                                     # vitest
pnpm test:e2e                                 # playwright, headless chromium (see e2e/README.md)
pnpm check                                    # svelte-check: types + Svelte diagnostics
pnpm audit                                    # fallow: dead code, complexity, duplication
pnpm build && PORT=4818 node build/index.js   # production build
```

Run `pnpm check` and `pnpm test` before claiming a change is done. A husky
pre-commit hook runs `fallow audit` and blocks only newly introduced findings.

### Running a second server beside a live one

Test against a throwaway data directory, never the real `~/.deck`:

```sh
DECK_DATA=/tmp/deck-fixture DECK_TOKEN=test \
  pnpm exec vite dev --port 4819
```

Each part earns its place. `DECK_DATA` keeps the fixture off the real sessions
and projects; without it the instance lock refuses to start, because two servers
sharing `~/.deck` race each other's writes. The dev server stays off the
tailnet unless `DECK_TAILSCALE=1` is set, so don't set it for a fixture.

Seed the fixture by writing `projects.json` and `sessions.json` into that
directory before starting. It still lists the machine's live tmux sessions,
which are read from tmux rather than from `~/.deck`.

Don't `git pull` the live checkout to try a change: vite reloads the modules
under the running server. Test in the worktree on its own port instead.

## Native apps (`apps/ios`)

SwiftUI clients for iPhone, iPad, Apple Watch and Mac, sharing the
`Packages/DeckKit` package. They talk to the server only through its HTTP API,
so a change to a route's request or response shape updates `DeckKit`'s models
and `ParityTests.swift` in the same PR. The full guide is
[apps/ios/README.md](apps/ios/README.md); run its commands from `apps/ios`.

```sh
brew install xcodegen fastlane                 # once
./generate.sh                                  # Deck.xcodeproj is generated, never committed
cd Packages/DeckKit && swift test              # unit tests
xcodebuild -project Deck.xcodeproj -scheme DeckApp \
  -destination 'generic/platform=iOS Simulator' \
  -skipMacroValidation CODE_SIGNING_ALLOWED=NO build
./uitest.sh [device...]                        # UI tests against a seeded throwaway deck
./ship.sh [ios|mac|all]                        # TestFlight via fastlane (default ios)
```

- `-skipMacroValidation` is required on every command-line build (mlx-swift-lm
  uses Swift macros).
- Run the UI tests with `./uitest.sh`, never against the live deck. It seeds a
  temp deck (`uitest/seed.mjs`, the fake claude from `e2e/`), serves it on
  127.0.0.1:4851 and runs the suite on an iPhone 17 Pro and an iPad simulator
  (pass names or ids to choose; `"iPhone Duo"` for the foldable tests). It
  exports `TEST_RUNNER_DECK_UITEST_URL` and `TEST_RUNNER_DECK_UITEST_TOKEN` in
  the shell: passed as trailing `KEY=value` arguments they become build
  settings and every test skips while the run still reports success.
- Use the Homebrew fastlane; `bundle exec` has no installed bundle.
- `.env` holds the signing team and App Store Connect key settings. It is
  gitignored, and none of its values belong in the repo.

## Conventions

- Tabs. No em dashes. Comments only where the *why* isn't obvious.
- No emoji in UI. Icons come from `@lucide/svelte` (a shared library), never
  inline `<svg>`; import once and reuse.
- Svelte 5 runes (`$state`, `$props`, `$derived`, `$effect`).
- Keep pure logic in a node-free `*-core.ts` with unit tests (e.g.
  `devservers-core.ts`); put tmux / fs / child_process orchestration in the
  sibling `*.ts` (e.g. `devservers.ts`). Tests sit next to code as `*.test.ts`.
- Confine all fs/git operations to registered projects and their worktrees (see
  `src/lib/server/confine.ts`). Never read or write outside them.
- Design language, palette, and themes live in `.impeccable.md` (loaded by the
  impeccable skill); the implemented theme tokens are in `src/routes/layout.css`.
- One logical change per PR; branch off `main`.
