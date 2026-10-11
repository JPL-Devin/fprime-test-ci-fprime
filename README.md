# fprime-test-ci-fprime

Scratch repository standing in for `nasa/fprime` in the dispatched external-CI prototype.

- `.github/ext-ci-manifest.json` — the list of external repositories to fan out to.
- `.github/workflows/ext-ci-trigger.yml` — no-op `pull_request` workflow; exists only so that the
  repository's normal "require approval" policy gates external CI for fork PRs.
- `.github/workflows/ext-ci.yml` — the orchestrator (`workflow_run` of the trigger, `push`,
  `workflow_dispatch`). Dispatches each external repo's own `ci.yml` with this repo's exact
  commit SHA, polls the remote runs and reports one Check Run per external repo on that SHA.
- `.github/scripts/ext-ci-orchestrator.mjs` — the orchestrator logic (dependency-free Node;
  destined for `nasa/fprime-actions` as a JS action).
- `compat.txt` — the "F´ API": an external repo's simulated build passes iff its id is listed here.
  Removing a line from it in a PR is how a "breaking F´ change" is simulated.
