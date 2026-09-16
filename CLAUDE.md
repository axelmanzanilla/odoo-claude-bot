@AGENTS.md

Before making changes, read `README.md` and `PLAN.md` completely. Execute the plan
from the first unchecked item through the definition of done, updating its checkboxes
as verified work is completed. Work autonomously and use mocks for unavailable
credentials or external services instead of stopping for routine questions.

## Multi-version Odoo support

No Odoo source ships with the bot. The operator explicitly installs any desired
versions through the CLI. References to an exclusively Odoo 19.0
workspace in `AGENTS.md` describe the original baseline, not a current version
restriction. Preserve its authorization, read-only tool, and session guarantees.

- `ODOO_WORKSPACE` is a fixed external directory containing `CLAUDE.md`,
  `VERSIONS.md`, and `versions/<version>/{odoo,documentation,enterprise}/`.
  Enterprise is optional per version; Community and documentation are installed
  by ordinary `add`. The legacy single-version configuration remains supported.
  Do not copy Odoo into this repo.
- Several source versions can be present and read in the same Claude turn. A
  comparison must inspect each requested version, including relevant model
  extensions in other modules, and cite version-specific paths and line numbers.
- Keep `deploy/workspace-CLAUDE.md.example` as the runtime instruction template.
  This repository's `CLAUDE.md` guides development of the bridge; it is not the
  instruction file to copy into the Odoo source workspace.
- The runtime instructions must require checking `VERSIONS.md` and actual files
  on every turn, including resumed sessions. Never hardcode the installed set or
  claim that an unavailable version can be inspected.
- Without a version in the current request, use the numerically newest installed
  Odoo source, including on follow-ups. There is no fixed preferred version. With
  no code installed, report that source inspection is unavailable. Documentation
  or Enterprise addons alone do not count as installed code.
  An explicit version must be respected.
- Version maintenance uses `npm run versions -- <init|add|list|update|remove>` on the
  host with an explicit `--workspace` path. Keep Git mutations out of Discord and
  Claude's tool permissions. Preserve local changes and existing custom instructions.
- `add --enterprise` includes Enterprise using the operator's configured Git HTTPS
  credentials. `remove --enterprise` removes only its checkout; ordinary `remove`
  removes the full version. `update` refreshes only installed repositories. No
  Enterprise download occurs without explicit opt-in. Keep credentials outside
  the workspace and never embed them in remote URLs or diagnostics.
- Runtime instructions must consult installed Enterprise extensions when relevant,
  alongside the same version's Community source. Missing Enterprise must not change
  newest-version selection or be mistaken for a module removed upstream.
