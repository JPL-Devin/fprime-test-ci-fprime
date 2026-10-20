# F´ External CI: move execution to the external repos, dispatch from nasa/fprime

## 1. Where we are

`nasa/fprime` has 13 `ext-*.yml` workflows (plus 6 soak workflows) that each:

1. resolve a target branch on the ext repo (`reusable-get-pr-branch.yml`: `pr-<N>` -> same-named branch -> `devel`),
2. check out the ext repo, overlay the current fprime revision into its `lib/fprime` submodule (`nasa/fprime-actions/external-repository-setup`, which does `actions/checkout` with `ref: ${{ github.ref }}`),
3. build / UT / integration-test on nasa/fprime's runners (`ubuntu-22.04`, `apple-ci`, `[self-hosted, raspberrypi]`, `[self-hosted, aarch64-linux]`).

Triggers: every PR to `devel`/`release/**` (with `paths-ignore`), pushes to `release/**`, nightly cron.

Facts that shape the plan:

- Most ext repos have **no CI of their own** (checked: `fprime-workshop-led-blinker` has no `.github/` at all; `fprime-zephyr-reference` has `.github/actions/setup` but no workflows; `fprime-cfs-reference` and `fprime-examples` are the exceptions). So "CI on the ext repo" is net-new work per repo, not a refactor.
- All the heavy lifting is already in `nasa/fprime-actions` composite actions. The `ext-*.yml` files are mostly glue. That glue is what moves.
- `reusable-*.yml` workflows do **not** help with the scaling goal: a reusable workflow's jobs run in the *caller's* repo/org and count against the caller's concurrency. Only a real cross-repo dispatch moves compute to the ext repo's org.

## 2. Requirements

| # | Requirement | Status |
|---|---|---|
| R1 | A dispatched ext run must build against an explicit nasa/fprime commit (PR head SHA, possibly from a fork), and the matching `fprime-gds` `pr-<N>` branch if it exists | agreed |
| R2 | nasa/fprime must surface the result of every dispatched run as a check on the PR, one per ext repo, usable as a required check | agreed |
| R3 | All ext repos run in parallel, with nasa/fprime holding at most **one** runner slot for the whole fan-out | agreed (hybrid) |
| R4 | "Re-run failed jobs" on the nasa/fprime side re-dispatches **only the ext repos that failed** in the previous attempt, and carries the passing results forward | agreed |
| R5 | A subset of ext repos can be run on demand (manual `workflow_dispatch`) and the result lands on the PR | agreed |
| R6 | Ext build jobs run untrusted PR code with no secrets, as today. No credential able to write to nasa/fprime is stored in any ext repo | proposed |
| R7 | Adding an ext repo to the fan-out is a one-entry manifest change in nasa/fprime | proposed |
| R8 | No dispatch happens for a PR unless the repo's existing GitHub Actions approval policy would already have let that PR's workflows run. No new trust decision is introduced; `pull_request_target` is excluded | agreed |
| R9 | Per ext repo, a failure can either block the PR or only notify the repo's owners (PR comment / tracking issue tagging them) without failing the check | agreed |

## 3. Target architecture

```
nasa/fprime PR
  └─ ext-ci-trigger.yml   on: pull_request (paths-ignore as today)
       └─ one no-op job, no secrets, ~10 s.  Gated by the repo's existing
          "require approval" policy exactly like every other pull_request workflow.
              │ completes
              ▼
  └─ ext-ci.yml   on: workflow_run [ext-ci-trigger], schedule, push release/**, workflow_dispatch
       (workflow file always taken from the default branch; runs with secrets in base context)
       └─ job "External CI" (single ubuntu job, the only long-lived nasa/fprime slot)
            0. derive PR from the trusted event payload only:
               workflow_run.head_sha / head_repository.full_name / head_branch,
               PR number via GET /commits/{sha}/pulls  (workflow_run.pull_requests is empty for forks)
            1. load manifest, filter (inputs.repos | failed-only on re-run attempt)
            2. for each ext repo: resolve ext ref (pr-<N> / base-branch / default),
               POST workflow_dispatch on <ext repo>/ci.yml @ <ext ref>
                 inputs: fprime_repository, fprime_ref (PR head SHA),
                         fprime_gds_ref, dispatch_id, concurrency_key
               create Check Run "<ext repo>" on PR head SHA, status=in_progress, details_url=remote run
            3. poll all remote runs (~60 s interval) until every one is completed
            4. update each Check Run with conclusion + summary (failed jobs/steps, remote log link)
            5. upload results-attempt-<n>.json artifact; fail the job if any repo failed
            6. if: cancelled()  -> cancel every remote run still in progress

fprime-community/<ext repo>
  └─ ci.yml
       on: push, pull_request, workflow_dispatch(inputs above)
       run-name: "fprime ext CI <dispatch_id>" when inputs.dispatch_id is set   (correlation)
       concurrency: group = inputs.concurrency_key || github.ref, cancel-in-progress
       jobs: uses nasa/fprime-actions/.github/workflows/project-ci.yml@<pin>
             with: build_location, ci_config_file, runs_on*, fprime_location,
                   fprime_repository/fprime_ref (overlay only when set)
```

### 3.1 Pieces to build in `nasa/fprime-actions`

| Piece | What | Notes |
|---|---|---|
| `external-repository-setup` (extend) | new inputs `fprime_repository`, `fprime_ref`; when set, overlay that instead of `github.ref` | Today it overlays "the current repo". In the ext repo context "current repo" is the ext repo, so an explicit overlay source is required. Same for the `upgrade-package` (fprime-gds) step: take an explicit ref instead of inferring `pr-<N>` from the event. |
| `ext-ci-orchestrator` (new action, JS) | steps 1-6 above: manifest filtering, dispatch, correlation, Check Run create/update, polling, results artifact, failed-only re-run, cancellation, `notify` policy (PR comment / tracking issue) | Own it here rather than pulling a marketplace action (zero-trust). Single action keeps `ext-ci.yml` in nasa/fprime tiny. |
| `project-ci.yml`, `project-builder.yml` (new reusable workflows) | Move `reusable-project-ci.yml` / `reusable-project-builder.yml` from nasa/fprime to fprime-actions so ext repos can call them | Cross-repo `uses:` of a reusable workflow is allowed for public repos. Ext repo `ci.yml` becomes ~30 lines. |

### 3.2 `ext-ci.yml` in nasa/fprime

Manifest (`.github/ext-ci-manifest.json`): per entry `id`, `repository`, `workflow`, `default_ref`, `timeout_minutes`, `failure_policy: block | notify` (default `block`), `owners: [github handles]`, optional `paths` filter and `on_pr: true|false` (some repos nightly-only).

`failure_policy` (R9):

- `block`: Check Run conclusion `failure`; orchestrator job fails. Eligible as a branch-protection required check.
- `notify`: Check Run conclusion `neutral` (visible on the PR, never blocks merge, cannot be a required check). The orchestrator additionally:
  - on a PR: posts one comment "External CI for `<repo>` failed against this PR: <remote run link> @owner..." and **updates** that comment on later attempts/pushes (marker comment id in the results artifact or an HTML marker), so a PR gets at most one comment per ext repo;
  - on schedule/push (no PR): opens or updates a tracking issue in nasa/fprime titled `External CI: <repo> failing on <branch>`, tagging owners; closes it when the next run passes.
  - Notifications rely on GitHub's @mention emails; no separate mail path. Team mentions (`@org/team`) from the actions bot may not notify, so `owners` should be user handles until verified in phase 1b.
  - Uses only the orchestrator's `GITHUB_TOKEN` (`pull-requests: write`, `issues: write` on nasa/fprime); nothing is written to ext repos.

`notify` is also the onboarding state for a newly added repo before it is promoted to `block`.

Triggers:

- `workflow_run` on `ext-ci-trigger` completing -> all entries with `on_pr` (see 5.1 for why this and not `pull_request`/`pull_request_target`).
- `push: release/**`, `schedule` -> all entries.
- `workflow_dispatch` with inputs `repos` (comma list, default `all`), `pr_number` (resolves head SHA + ext `pr-<N>` refs), `fprime_ref` (for non-PR use), `force_all`. Also the way to test orchestrator changes from a branch, since the `workflow_run` path always uses the default-branch file.

No `issue_comment` (`/ext-ci`) trigger in v1: `workflow_dispatch` + failed-only re-run cover the same cases, and a comment trigger would be one more privileged trigger needing its own commenter-permission check. Revisit if the Actions-tab round trip proves to be real friction.

The orchestrator reads the manifest from the PR's **base branch** via API (not from its own checkout), so `release/**` PRs use the release manifest even though the orchestrator code comes from `devel`.

## 4. How each requirement is met

### R1: explicit fprime commit

`fprime_repository=<workflow_run.head_repository.full_name>` (or `github.repository` for schedule/push), `fprime_ref=<workflow_run.head_sha>`. The ext workflow overlays that exact commit (public forks are checkout-able without credentials). SHA rather than branch so re-runs are reproducible. `fprime_gds_ref` is resolved by the orchestrator (`pr-<N>` on nasa/fprime-gds if it exists, else empty) and passed along.

The `pr-<N>` convention on the ext repo maps onto `workflow_dispatch`'s `ref`: dispatching at `ref: pr-<N>` runs `ci.yml` **from that branch**. Caveat: `ci.yml` must exist on that branch (it will if branches are cut after rollout).

### R2: one check per ext repo

The orchestrator creates a Check Run per ext repo on the PR head SHA using the workflow's own `GITHUB_TOKEN` (`checks: write` on nasa/fprime itself; no cross-org credential). `details_url` points at the remote run and the summary links the orchestrator run (the `workflow_run` run is not listed under the PR, so this is how a maintainer finds the "Re-run failed jobs" button). On completion the check gets the remote conclusion, plus a summary listing failed jobs/steps fetched from the remote run so nasa/fprime is not just "remote failed". Check names are stable (`ext-ci / <id>`) so they can be branch-protection required checks.

Correlation detail (the dispatch API returns 204 with no run id): pass `dispatch_id=${{ github.run_id }}-${{ github.run_attempt }}` as an input, have the ext workflow set `run-name` from it, then list runs with `event=workflow_dispatch&created>=<dispatch time - 1 min>` and match `display_title`. Retry for ~2 min (dispatch -> run creation is asynchronous).

### R3: one slot

Single orchestrator job dispatches everything then polls. Compute moves to the ext repo owner's pool (`fprime-community`, a different org from `nasa`), so the two pools add up. Poll interval >= 30 s keeps API usage trivial (~15 repos, 1 h -> under 2k calls).

To verify before relying on it: GitHub-hosted minutes are free on public repos and the real limit is the per-org concurrent-job cap, so the gain is concurrency. If nasa and fprime-community sit under one Enterprise account, check whether the cap is per-enterprise, which would shrink the gain.

Cancellation: cancelling the orchestrator does not cancel remote runs by itself. Two mitigations, use both: (1) `concurrency_key=fprime-pr-<N>` so the ext repo's own `concurrency` group cancels the previous dispatch for the same PR, (2) `if: cancelled()` step in the orchestrator that cancels remote runs still in progress.

### R4: failed-only re-run

Each attempt uploads `results-attempt-<n>.json` (per repo: conclusion, remote run URL). Artifacts are scoped to the run, not the attempt, so attempt `n` can list and download attempt `n-1`'s artifact via the API. On `github.run_attempt > 1` the orchestrator:

1. loads the newest previous results file,
2. re-dispatches only repos whose conclusion was not `success` (plus any repo missing from the file, e.g. manifest grew),
3. re-emits the previous `success` results as fresh Check Runs on the same SHA (so the PR check list is complete for this attempt),
4. writes a new results file containing the merged picture.

The built-in "Re-run failed jobs" button therefore means "re-run failed ext repos". "Re-run all jobs" is the same code path; add a `force_all` `workflow_dispatch` input for an explicit full re-run.

### R5: subset on demand

`workflow_dispatch` (`repos`, `pr_number`) filters the manifest before dispatching, then emits Check Runs on the PR head SHA. A later subset run creates new Check Runs with the same names on the same SHA; I believe GitHub uses the latest Check Run per name for required-status purposes. **Verify on a scratch repo first** (5-minute test); if it does not hold, fall back to updating the existing Check Run ids (store them in the results artifact / find them via `GET /commits/{sha}/check-runs?check_name=`).

### R6: security boundary

- Dispatch credential lives only in nasa/fprime (see 4.2). It has `actions: write` on ext repos and nothing on nasa/fprime.
- Ext `ci.yml` build jobs: `permissions: contents: read`, no secrets referenced. They run untrusted PR code, same exposure as today.
- The orchestrator never checks out PR code; it only reads `head.sha` and calls APIs.

## 5. Caveats to iron out

### 5.1 Fork PRs (resolved: `pull_request` trigger + `workflow_run` orchestrator)

Problem: `pull_request` runs from forks get no secrets, and a dispatch needs the App credential. Most nasa/fprime PRs are fork PRs (including `JPL-Devin/fprime` -> `nasa/fprime`), so ext CI must still run automatically for them.

Rejected: `pull_request_target`. It runs immediately, bypassing the repo's "require approval" policy, so a drive-by PR would fan out builds into fprime-community (including self-hosted runners) with no human in the loop. Any author-permission gate added inside the orchestrator would be a new trust decision on top of GitHub's; not acceptable (R8).

Rejected: comment/label-only for fork PRs. Human-in-the-loop on every push for the majority of PRs is a regression from today.

Chosen: `workflow_run` chaining.

- `ext-ci-trigger.yml` is an ordinary `pull_request` workflow with a no-op job. It is subject to exactly the repo's current approval policy: not approved -> never runs -> nothing downstream fires.
- `ext-ci.yml` runs `on: workflow_run` when the trigger completes. It runs in base-repo context with secrets, and GitHub always takes the `workflow_run` workflow file from the default branch, so a PR cannot alter the orchestrator or manifest that acts on it.
- The orchestrator trusts **only** the `workflow_run` event payload (`head_sha`, `head_repository.full_name`, `head_branch`). No artifact handoff from the trigger job: a malicious PR controls the trigger workflow file and could forge an artifact to post green checks on another PR's SHA. PR number is looked up with `GET /repos/nasa/fprime/commits/{head_sha}/pulls`, since `workflow_run.pull_requests` is empty for fork PRs.
- Check Runs are posted on `head_sha`, so results appear on the PR even though the `workflow_run` run itself is not listed under it.

Costs: one ~10 s trigger job per PR push; orchestrator for `release/**` PRs comes from `devel` (manifest is read from the PR base branch to compensate); `paths-ignore` lives on the trigger workflow, not the orchestrator.

To validate in phase 1b: an approval-pending `pull_request` run does not emit `workflow_run`; `workflow_run.head_sha` is the PR head (not the merge commit) for fork PRs.

### 5.2 Credential

Dedicated GitHub App ("fprime-ci-dispatcher") installed on `nasa` (for `pr-<N>` lookups it can use the public API) and `fprime-community` (permissions: `actions: write` on the ext repos only). Token minted per run with `actions/create-github-app-token`; private key as a nasa/fprime repo secret. Avoids PAT expiry and personal attribution. Needs an org admin on both orgs to create/install.

### 5.3 Self-hosted runners

`apple-ci`, `raspberrypi`, `aarch64-linux`, `soak-test` are registered somewhere under `nasa`. Ext repos in `fprime-community` cannot see them. Either move them to org-level runner groups in fprime-community (group restricted to the specific repos), or register second runner instances. The runner group is now reachable from every allowed repo, so scope it tightly; those repos' `ci.yml` also run on their own (fork) PRs, so require approval for first-time contributors / restrict self-hosted jobs to dispatched runs (`if: github.event_name == 'workflow_dispatch'`).

### 5.4 Forks of nasa/fprime running CI (JPL-Devin workflow)

`ext-ci.yml` runs on the fork too and would fail without the App secret. Preflight step outputs whether the credential is present and skips gracefully (job-level `if:` cannot read `secrets`).

### 5.5 Two failure classes get separated (a feature)

Ext repo `ci.yml` on its own PRs builds against the pinned submodule; dispatched runs build against fprime `devel`/PR head. A nightly dispatch with `fprime_ref=devel` catches "devel broke the tutorial" without a nasa/fprime PR.

### 5.6 Soak workflows

Scheduled/release-triggered, self-hosted, persistent state. Leave in nasa/fprime; out of scope for the first pass.

### 5.7 Zero-trust / pinning

All action code lives in `nasa/fprime-actions`; ext repos pin `@devel` today. A compromise of fprime-actions `devel` would now affect every ext repo's CI. Decide whether dispatched ext workflows pin a tag/SHA and how that is bumped (Dependabot / Renovate on the ext repos).

## 6. Phased rollout

| Phase | Work | Effort |
|---|---|---|
| 0. Decisions | Section 7 | you |
| 1. Building blocks in `nasa/fprime-actions` | extend `external-repository-setup`; `ext-ci-orchestrator` action (dispatch, correlate, check runs, poll, results artifact, failed-only re-run, cancel); move `project-ci.yml` / `project-builder.yml` there | ~1–2 sessions |
| 1b. Scratch-repo validation | Check Run supersede semantics (R5), artifact-across-attempts (R4), `run-name` correlation, `workflow_run` gating + payload for fork PRs (R8), bot @mention notifications for users/teams (R9) | inside phase 1 |
| 2. Pilot: led-blinker | add `ci.yml` to `fprime-workshop-led-blinker` (native UT + RPi + aarch64, exercising hosted and self-hosted); `ext-ci.yml` + one-entry manifest in nasa/fprime; run **alongside** the three existing led-blinker `ext-*.yml` for a couple of weeks; then delete them | ~1 session + wait on App install and runner-group setup |
| 3. Roll out | `ci.yml` in each remaining ext repo (hello-world, math-comp, examples, python-reference, zephyr, cfs, generic-hub, yamcs, cookiecutters/bootstrap); grow the manifest; delete `ext-*.yml` one by one as each is proven | ~1–2 sessions, mostly mechanical |
| 4. Docs | CONTRIBUTING.md (`pr-<N>` convention still holds; adding an ext repo; reading a remote failure; re-running / subset via `workflow_dispatch`), fprime-actions README | small |

Every write to an ext repo (`ci.yml` PRs) or to nasa/fprime-actions goes through you for explicit approval per repo before it is opened.

## 7. Decisions still open

1. Credential: dedicated GitHub App (recommended) vs machine-user PAT. Who creates/installs it on `nasa` and `fprime-community`?
2. Where are the self-hosted runners registered today; is moving them to fprime-community org runner groups acceptable? (Note: ext repos' own fork PRs would also reach those runners unless self-hosted jobs are restricted to dispatched runs, see 5.3.)
3. Keep "every PR runs all ext CI", or take the opportunity to make it nightly + `release/**` + `workflow_dispatch` on demand, with a small always-on subset (e.g. led-blinker native) on PRs?
4. Pinning policy for `nasa/fprime-actions` in ext repos (`@devel` vs tag/SHA + bot bumps).
5. Where the agreed plan lands (nasa/fprime issue, `docs/` design note, or fprime-actions README).

## 8. Prototype results (JPL-Devin scratch repos)

Repos: `JPL-Devin/fprime-test-ci-fprime` (simulated nasa/fprime: manifest, `ext-ci-trigger.yml`, `ext-ci.yml`, dependency-free Node orchestrator `.github/scripts/ext-ci-orchestrator.mjs`), `fprime-test-ci-ext-a` / `-ext-b` (simulated ext repos with a dispatchable `ci.yml`: build + UT + 2-platform integration matrix, overlaying the requested F´ repo/SHA under `lib/fprime`). `ext-b` can be broken from the F´ side by dropping it from `compat.txt`.

| Req | Demonstrated | Evidence |
|---|---|---|
| R1 explicit SHA | ext runs titled `ext-ci <run>-<attempt>-<id> (<repo>@<sha>)` build exactly the PR head SHA, also for `pr_number` dispatches | PR #1 runs: ext-a [39364874791](https://github.com/JPL-Devin/fprime-test-ci-ext-a/actions/runs/39364874791), ext-b [39364878282](https://github.com/JPL-Devin/fprime-test-ci-ext-b/actions/runs/39364878282) |
| R2 one check per repo | `ext-ci / ext-a` = success, `ext-ci / ext-b` = failure on the PR head, each linking remote run + orchestrator run | [PR #1 checks](https://github.com/JPL-Devin/fprime-test-ci-fprime/pull/1/checks) |
| R3 one slot | one `External CI` job dispatches both repos, polls every 15 s, finishes seconds after the slowest remote run | orchestrator [39364860268](https://github.com/JPL-Devin/fprime-test-ci-fprime/actions/runs/39364860268) |
| R4 failed-only re-run | "Re-run failed jobs" (attempt 2) carried `ext-a` forward from its attempt-1 Check Run and re-dispatched only `ext-b`, which now resolved to the ext repo's `pr-1` branch and passed; PR shows both green | same run, attempt 2; ext-b [39365397217](https://github.com/JPL-Devin/fprime-test-ci-ext-b/actions/runs/39365397217) |
| R5 subset | `workflow_dispatch` with `repos=ext-a, pr_number=1` dispatched only ext-a and refreshed only its Check Run on the PR head | [39365506483](https://github.com/JPL-Devin/fprime-test-ci-fprime/actions/runs/39365506483) |
| R6 boundary | orchestrator never checks out PR code; ext jobs run with `contents: read` only, no secrets | workflows as committed |
| R8 approval gate | chain `pull_request` (no-op, `permissions: {}`) → `workflow_run` orchestrator works; orchestrator resolves the PR from the SHA | trigger [39364849034](https://github.com/JPL-Devin/fprime-test-ci-fprime/actions/runs/39364849034) → orchestrator 39364860268 |
| R9 notify policy | `ext-b: notify` + break → Check Run `neutral`, PR mergeable, orchestrator job green, one PR comment @-mentioning owners; once passing again the same comment is edited to "passing again" | [PR #2](https://github.com/JPL-Devin/fprime-test-ci-fprime/pull/2) |
| R9 notify, no PR | push to `main` breaking `ext-b` → orchestrator green, `ext-b` check `neutral`, tracking issue opened and owners @-mentioned; next passing push comments and closes it | [issue #3](https://github.com/JPL-Devin/fprime-test-ci-fprime/issues/3) |
| cancel | cancelling the orchestrator run → `Cancel remote runs` step cancels both ext runs (took ~75 s for GitHub to stop the running job) and marks the Check Runs `cancelled` | [39366011356](https://github.com/JPL-Devin/fprime-test-ci-fprime/actions/runs/39366011356) |

GitHub behaviours confirmed on the way:
- A later Check Run with the same name on the same SHA supersedes the earlier one in the PR checks view and in `GET /commits/{sha}/check-runs` (default `filter=latest`); the earlier one stays retrievable with `filter=all`. So subset / re-run refreshes "just work" for required checks.
- `workflow_run` runs are recorded against the default branch (`head_sha` = default-branch head), not the PR head; the per-repo Check Runs on the PR head are the only PR-visible artefact, as designed. `workflow_run.pull_requests` was populated for a same-repo PR; the SHA lookup fallback is still needed for forks.
- `pull_request` with `paths-ignore` is evaluated on the PR's whole diff vs base: pushing a commit that makes the PR diff empty does not start the trigger workflow at all (`GET /pulls/N/files` = 0). Harmless, but explains a "nothing ran" case.
- Cancellation via `POST /actions/runs/{id}/cancel` is asynchronous; a job in the middle of a long step takes ~1 min to actually stop.
- Secrets: a repo secret can be set by anyone with repo admin (fine-grained PAT needs the **Secrets** permission); dispatch into another repo needs **Actions: write** there (a classic PAT with `repo`+`workflow` scope works only once the user has write access on the target repo — the API says "Must have admin rights" but write is enough).

Not yet demonstrated:
- The approval gate itself with an actual outside-collaborator fork (needs a GitHub account that is not a JPL-Devin member / collaborator; `thomas-bc-autowot` is now a collaborator). By construction the orchestrator cannot start before the `pull_request` trigger has run, so the gate reduces to GitHub's documented behaviour; a one-off fork PR from a non-member account would close this.
- Self-hosted runner visibility, GitHub App credential, `release/**` manifest selection: production-only concerns.

Production deltas vs. the prototype: credential becomes a GitHub App installation token minted per run (`actions: write` on fprime-community repos only); orchestrator script moves to `nasa/fprime-actions` as a composite/JS action; ext `ci.yml` files call the existing `nasa/fprime-actions` reusable pieces instead of the simulated `ci/*.sh`.
