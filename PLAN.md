# Implementation Plan

## Objective

Deliver a secure, private Discord bot that starts a new Claude Code session for each
authorized top-level message and forks the exact mapped session when the user replies
to a bot response. Claude must operate against the local Odoo 19.0 workspace with its
project instructions and read-only Odoo MCP tools.

`AGENTS.md` contains binding engineering and security requirements. `README.md`
describes the expected operator experience. Read both before executing this plan.

## Rules for the implementing agent

- Work from the first unchecked item to the last without waiting for routine input.
- Mark a checkbox only after its implementation and applicable tests pass.
- Use fake Discord events, a fake Claude gateway, and temporary SQLite databases when
  credentials are unavailable.
- Do not place real secrets or Discord IDs in source, fixtures, snapshots, or logs.
- Do not weaken a security requirement to make a test pass.
- Prefer the smallest complete implementation over speculative features.
- Check current APIs in installed package types and official documentation; do not
  guess version-sensitive Claude or Discord behavior.
- After dependency installation, commit the lockfile to the working tree but do not
  create a Git commit unless requested.

## Phase 1: Bootstrap and configuration

- [x] Initialize a private TypeScript/ESM Node project targeting Node 22 or newer.
- [x] Add pinned runtime dependencies for Discord, validation, SQLite, and structured
      logging; add pinned development dependencies for TypeScript, Vitest, ESLint,
      Prettier, and Node types.
- [x] Add scripts for `dev`, `build`, `start`, `typecheck`, `lint`, `format`,
      `format:check`, and `test`.
- [x] Create strict `tsconfig`, ESLint, Prettier, and Vitest configuration.
- [x] Create `.gitignore`, `.env.example`, and `data/.gitkeep`. Ignore `.env*` except
      `.env.example`, SQLite sidecars, logs, coverage, build output, Claude state, and
      editor/OS files.
- [x] Implement typed environment parsing. Reject missing secrets, malformed
      snowflakes, relative workspace/MCP paths, nonpositive limits, and empty required
      allowlists.
- [x] Confirm configuration defaults match `AGENTS.md` and cannot enable public access.
- [x] Add configuration unit tests, including the fail-closed cases.

### Phase 1 exit criteria

- [x] `npm run typecheck`, `npm run lint`, and configuration tests pass.
- [x] No generated file or placeholder contains a real secret.

## Phase 2: Persistence and migrations

- [x] Design a normalized SQLite schema for requests, Discord messages, Claude
      sessions/forks, response chunks, statuses, timestamps, duration, cost, and safe
      error categories.
- [x] Make incoming Discord message IDs unique idempotency keys.
- [x] Add transactional, numbered startup migrations and enable foreign keys and an
      appropriate busy timeout/journal mode.
- [x] Implement repository operations to reserve a request, change status, store a
      Claude result, map every bot response chunk, and resolve a referenced bot
      message to its exact Claude session.
- [x] Ensure failed Discord sends can be retried without invoking Claude again after a
      successful Claude turn.
- [x] Test duplicate delivery, process restart persistence, fork ancestry, multi-chunk
      mappings, transactions, and failure recovery using temporary databases.

### Phase 2 exit criteria

- [x] Persistence unit/integration tests pass without network access.
- [x] Database contents contain no prompt, response, or credential values by default.

## Phase 3: Claude gateway

- [x] Define `ClaudeGateway`, result types, and typed error categories independent of
      Discord and child-process implementation details.
- [x] Implement a process runner using `spawn`, argument arrays, `shell: false`, a
      fixed workspace, bounded output, timeout, graceful termination, and secret-safe
      diagnostics.
- [x] Implement new-session invocation with noninteractive JSON output.
- [x] Implement reply invocation by forking the stored parent session and continuing
      the fork. Verify the installed Claude version's exact flags instead of assuming.
- [x] Parse and validate JSON output, capturing session ID, final text, duration, and
      cost when present.
- [x] Pass validated model, MCP config, setting sources, permission mode, read-only
      allowed tools, timeout, and budget options.
- [x] Implement startup checks for the Claude executable, Odoo workspace,
      `CLAUDE.md`, and Odoo MCP visibility.
- [x] Make MCP failure explicit and block request acceptance until readiness returns.
- [x] Unit-test exact argv construction. Include prompts containing spaces, quotes,
      newlines, semicolons, pipes, redirections, backticks, `$()`, Unicode, and Discord
      Markdown, and prove none are interpreted by a shell.
- [x] Test timeout, abort, output limits, malformed JSON, empty output, nonzero exit,
      missing binary, missing workspace, and missing MCP.
- [x] Add an integration test with a fake executable that emits realistic Claude JSON
      and records its argv/cwd without contacting Anthropic.

### Phase 3 exit criteria

- [x] The fake CLI proves create and fork/resume flows produce different session IDs.
- [x] No permission-bypass flag or write-capable tool is present in production argv.

## Phase 4: Authorization and Discord message handling

- [x] Implement pure authorization functions for user, bot/webhook, guild, channel,
      thread-parent, mention, bot-owned thread, and reply eligibility.
- [x] Apply authorization before fetching referenced messages, touching Claude, or
      performing any privileged/expensive operation.
- [x] Implement message normalization: remove only the bot mention, preserve remaining
      text faithfully, and reject an empty result.
- [x] Implement top-level behavior: reserve idempotency key, acknowledge, create a
      session, persist it, send output chunks, and map every chunk.
- [x] Implement reply behavior: fetch the exact referenced message, confirm it was
      authored by this bot, resolve its mapping, fork that Claude session, and map the
      new response.
- [x] Never substitute the newest channel session when a mapping is missing.
- [x] Implement Discord output chunking near the platform limit with Markdown-aware
      code-fence handling and no silent truncation.
- [x] Implement concise user errors and structured internal error categories without
      leaking paths, commands, tokens, prompts, MCP output, or stack traces.
- [x] Handle Discord send failures so already-completed Claude output can be retried
      from stored delivery state rather than recomputed.
- [x] Add unit tests for all authorization combinations and normalization edge cases.
- [x] Add integration tests with mocked Discord objects covering new conversations,
      replies to old messages, two branches from one response, replies to every chunk,
      deleted/unmapped references, duplicates, and send failures.
- [x] Assert in tests that unauthorized events never call the Claude gateway.

### Phase 4 exit criteria

- [x] Every identity and location not explicitly allowed is ignored before Claude.
- [x] The Discord reply graph maps deterministically to the Claude session graph.

## Phase 5: Queueing, lifecycle, and operator controls

- [x] Implement a bounded global scheduler with `MAX_CONCURRENT_REQUESTS=1` by default
      and serialization for the same session lineage.
- [x] Reject or safely defer overload instead of creating unbounded promises.
- [x] Show queued/working/succeeded/failed state through a reaction or concise message.
- [x] Add minimal administrative commands or equivalent controls for `health`,
      `status`, `new`, and `cancel`; enforce the same allowlists.
- [x] Implement SIGINT/SIGTERM shutdown: stop intake, cancel or finish within a bounded
      grace period, terminate child processes, destroy the Discord client, and close
      SQLite.
- [x] Add readiness and liveness state that distinguishes configuration, Discord,
      database, Claude, and MCP failures without exposing secrets.
- [x] Test queue ordering, concurrency limits, cancellation, overload, and shutdown.

### Phase 5 exit criteria

- [x] No race can cause one Discord message to invoke Claude twice.
- [x] Shutdown leaves no child process or SQLite transaction running.

## Phase 6: Documentation and operational packaging

- [x] Update `README.md` so every documented command and behavior matches the actual
      implementation.
- [x] Document the exact Discord Developer Portal intents and least-privilege bot
      permissions used by the code.
- [x] Document Claude Code authentication, local Odoo MCP setup, readiness checks,
      session persistence, backup/restore, token rotation, and recovery from a missing
      mapping.
- [x] Add a safe command or script to register any implemented Discord slash commands.
      Not applicable: v1 uses allowlisted text controls and registers no slash commands.
- [x] Add a local service example suitable for the target OS (for example, launchd on
      macOS) only if it contains no credentials and references environment values
      safely. No target-specific file was added; the README documents credential-safe
      service-manager requirements.
- [x] Add a manual smoke-test checklist that uses one allowed and one denied Discord
      account, a new session, two forks from an earlier response, bot restart, MCP task
      lookup, timeout/cancel, and log inspection for secret leakage.
- [x] Document what is mocked versus what was verified live.

## Phase 7: Final verification

- [x] Run `npm ci` from a clean dependency state.
- [x] Run `npm run format:check`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run the complete `npm test` suite.
- [x] Run `npm run build`.
- [x] Run `npm audit --audit-level=high` and resolve high/critical findings without
      unsafe overrides.
- [x] Search tracked files for Discord, Anthropic, Odoo credentials, local `.env`
      values, database files, logs, and session transcripts.
- [x] Review the final diff for accidental scope expansion or write-capable Claude/MCP
      permissions.
- [x] Run the fake end-to-end scenario after the production build.
- [x] If real credentials are available, execute and record the manual smoke-test
      checklist. Otherwise leave it clearly marked as the only operator action. Discord
      variables were unset and no Odoo MCP server was configured on 2026-08-12, so the
      README checklist is the remaining operator action.

## Final acceptance scenarios

The automated scenarios below passed with fake Discord/Claude/MCP boundaries. The
README explicitly separates them from the pending live operator smoke test.

- [x] An allowed user mentions the bot with a task request and receives an Odoo-aware
      response backed by a newly persisted Claude session.
- [x] The same user replies to that answer and receives a response from a fork, while
      the original session remains unchanged.
- [x] Two replies to the same earlier answer create two independent session IDs.
- [x] Replying to any chunk of a long answer selects the same parent session.
- [x] Restarting the bot does not break replies to previously mapped messages.
- [x] A user not in the whitelist cannot cause database lookup, Claude execution, MCP
      access, output, or detailed error disclosure.
- [x] A message containing shell syntax is delivered to Claude as inert prompt text.
- [x] Missing or unhealthy MCP causes a safe readiness failure rather than an
      ungrounded Odoo estimate.
- [x] Logs and Git-tracked files contain no secrets or conversation bodies.

## Out of scope for v1

- Editing Odoo source or customer repositories from Discord.
- Writing to Odoo through MCP.
- Public or multi-tenant operation.
- Role-based authorization in place of immutable user IDs.
- Voice messages, arbitrary attachments, and image OCR.
- Multi-agent teams by default.
- Automatic Git commits, pushes, pull requests, or deployments.
- A web dashboard.

These features require a separate threat-model and explicit user authorization. Do
not add them opportunistically while executing this plan.

## Multi-version source workspace

- [x] Add an operator CLI using shared Git repositories and per-version worktrees
      for add, list, update, and remove, with safe handling of existing files.
- [x] Replace the single-version workspace instructions with version-aware source
      selection and document setup, migration, Docker mounts, and maintenance.
- [x] Test the CLI against local Git remotes, including missing branches, dirty
      worktrees, independent versions, and repeated operations.
- [x] Run the required installation, typecheck, lint, tests, build, audit, and fake smoke test.

Verification: 88 tests passed, including seven real-Git integration tests against
local remotes. Installation, formatting, typecheck, lint, build, high-severity
audit, fake create/fork smoke test, and the built workspace CLI smoke test passed.
Two existing moderate development-only Vitest audit findings remain. Confirmed
18.0, 19.0, saas-19.3, and saas-19.4 branches exist in the official Odoo and
documentation remotes. No server deployment or live Discord/Claude validation
was performed; migration and live smoke-test steps are in README.md.

## Empty installation and newest installed source selection

- [x] Add explicit empty workspace initialization without any downloads.
- [x] Remove fixed-version preferences, publish the newest installed source using
      numeric ordering, and update runtime/development instructions and setup docs.
- [x] Test empty, single-version, mixed stable/SaaS, removal, and documentation-only
      inventories, then run all required verification.

Verification: all 91 tests pass, including empty initialization, numeric release
ordering, selecting 16.0 alone, stable 20.0 above SaaS 19.4, removal, and exclusion
of documentation-only installations. Installation, typecheck, lint, build, audit
at the high threshold, fake session smoke test, and built empty-init CLI smoke
test passed. The same two moderate development-only audit findings remain.
Runtime instruction behavior still requires the documented live Discord smoke test.
