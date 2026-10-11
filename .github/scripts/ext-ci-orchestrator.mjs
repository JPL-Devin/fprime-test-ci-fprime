#!/usr/bin/env node
// External-CI orchestrator prototype (dependency-free Node >= 20).
//
//   node ext-ci-orchestrator.mjs run     dispatch, poll, report
//   node ext-ci-orchestrator.mjs cancel  cancel remote runs recorded in the state file
//
// Two credentials, never mixed:
//   GITHUB_TOKEN   this repo only (checks/pull-requests/issues write) - reports results
//   DISPATCH_TOKEN external repos only (actions: write)                - starts remote runs
import fs from 'node:fs';

const env = process.env;
const mode = process.argv[2] ?? 'run';
const API = env.GITHUB_API_URL || 'https://api.github.com';
const SERVER = env.GITHUB_SERVER_URL || 'https://github.com';
const STATE_FILE = 'ext-ci-state.json';
const RESULTS_FILE = 'ext-ci-results.json';
const MANIFEST_PATH = '.github/ext-ci-manifest.json';
const POLL_MS = Number(env.POLL_INTERVAL_SECONDS || 30) * 1000;
const CORRELATE_TIMEOUT_MS = 5 * 60 * 1000;

const repo = env.GITHUB_REPOSITORY;
const runId = env.GITHUB_RUN_ID;
const attempt = Number(env.GITHUB_RUN_ATTEMPT || 1);
const eventName = env.GITHUB_EVENT_NAME;
const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
const orchestratorUrl = `${SERVER}/${repo}/actions/runs/${runId}${attempt > 1 ? `/attempts/${attempt}` : ''}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => sha.slice(0, 7);

// ---------------------------------------------------------------- REST helpers
function client(token, label) {
  if (!token) throw new Error(`${label} token missing`);
  async function request(method, url, body) {
    const res = await fetch(url.startsWith('http') ? url : API + url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fprime-ext-ci-orchestrator',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
  }
  async function api(method, url, body) {
    const r = await request(method, url, body);
    if (!r.ok) throw new Error(`${label}: ${method} ${url} -> ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
    return r.data;
  }
  return {
    get: (u) => api('GET', u),
    post: (u, b) => api('POST', u, b),
    patch: (u, b) => api('PATCH', u, b),
    exists: async (u) => (await request('GET', u)).status === 200,
  };
}
const own = client(env.GITHUB_TOKEN, 'GITHUB_TOKEN');
const ext = client(env.DISPATCH_TOKEN, 'DISPATCH_TOKEN');

// ---------------------------------------------------------------- target resolution
// What F´ revision are we testing, and which PR (if any) gets the Check Runs?
async function resolveTarget() {
  const t = { pr: null, headRepo: repo, headSha: null, headBranch: null, baseRef: null };
  if (eventName === 'workflow_run') {
    const wr = event.workflow_run;
    // Trust only the event payload: nothing produced by the (untrusted) trigger run is read.
    t.headSha = wr.head_sha;
    t.headRepo = wr.head_repository.full_name;
    t.headBranch = wr.head_branch;
    // workflow_run.pull_requests is empty for fork PRs; find the PR by commit, then by head ref.
    let pr = (await own.get(`/repos/${repo}/commits/${t.headSha}/pulls?per_page=20`))
      .find((p) => p.state === 'open' && p.head.sha === t.headSha && p.base.repo.full_name === repo);
    if (!pr) {
      const owner = t.headRepo.split('/')[0];
      pr = (await own.get(`/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${t.headBranch}`)}`))
        .find((p) => p.head.sha === t.headSha);
    }
    if (!pr) throw new Error(`no open PR found for ${t.headRepo}@${t.headSha} (${t.headBranch}); the PR may have been updated or closed`);
    t.pr = pr.number;
    t.baseRef = pr.base.ref;
  } else if (eventName === 'workflow_dispatch') {
    const prNumber = (env.INPUT_PR_NUMBER || '').trim();
    if (prNumber) {
      const pr = await own.get(`/repos/${repo}/pulls/${prNumber}`);
      t.pr = pr.number; t.headSha = pr.head.sha; t.headRepo = pr.head.repo.full_name;
      t.headBranch = pr.head.ref; t.baseRef = pr.base.ref;
    } else {
      const ref = (env.INPUT_FPRIME_REF || '').trim() || env.GITHUB_REF_NAME;
      const commit = await own.get(`/repos/${repo}/commits/${encodeURIComponent(ref)}`);
      t.headSha = commit.sha; t.headBranch = ref; t.baseRef = ref;
    }
  } else { // push, schedule
    t.headSha = env.GITHUB_SHA; t.headBranch = env.GITHUB_REF_NAME; t.baseRef = env.GITHUB_REF_NAME;
  }
  return t;
}

// Manifest is read from the base branch of the PR (the orchestrator itself always runs from
// the default branch), so release/** PRs use their own branch's manifest.
async function loadManifest(ref) {
  try {
    const file = await own.get(`/repos/${repo}/contents/${MANIFEST_PATH}?ref=${encodeURIComponent(ref)}`);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  } catch (e) {
    console.log(`manifest not readable at ${ref} (${e.message}); using checked-out copy`);
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }
}

const checkName = (manifest, id) => `${manifest.check_prefix || 'ext-ci'} / ${id}`;

async function latestCheckRun(name, sha) {
  const r = await own.get(`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(name)}&per_page=50`);
  return r.check_runs.sort((a, b) => b.id - a.id)[0] ?? null;
}

async function selectRepos(manifest, target) {
  let repos = manifest.repos;
  const wanted = (env.INPUT_REPOS || 'all').trim();
  if (eventName === 'workflow_dispatch' && wanted && wanted !== 'all') {
    const ids = wanted.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = ids.filter((id) => !repos.some((r) => r.id === id));
    if (unknown.length) throw new Error(`unknown manifest ids: ${unknown.join(', ')}`);
    repos = repos.filter((r) => ids.includes(r.id));
  } else if (target.pr) {
    repos = repos.filter((r) => r.on_pr !== false);
  }
  // Failed-only re-run: on attempt > 1 keep every repo whose latest Check Run on this SHA
  // already succeeded, and dispatch only the rest.
  const carried = [];
  const dispatch = [];
  const forceAll = (env.INPUT_FORCE_ALL || '').toString() === 'true';
  for (const entry of repos) {
    const prior = attempt > 1 && !forceAll ? await latestCheckRun(checkName(manifest, entry.id), target.headSha) : null;
    if (prior && prior.status === 'completed' && prior.conclusion === 'success') carried.push({ entry, prior });
    else dispatch.push(entry);
  }
  return { carried, dispatch };
}

// pr-<N> branch on the ext repo, else the F´ base branch name, else the manifest default.
async function resolveExtRef(entry, target) {
  const candidates = [];
  if (target.pr) candidates.push(`pr-${target.pr}`);
  if (target.baseRef) candidates.push(target.baseRef);
  for (const c of candidates) {
    if (await ext.exists(`/repos/${entry.repository}/branches/${encodeURIComponent(c)}`)) return c;
  }
  return entry.default_ref || 'main';
}

// ---------------------------------------------------------------- state
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
function loadState() { return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null; }

// ---------------------------------------------------------------- dispatch + correlate
async function dispatchOne(manifest, entry, target, state) {
  const dispatchId = `${runId}-${attempt}-${entry.id}`;
  const extRef = await resolveExtRef(entry, target);
  const name = checkName(manifest, entry.id);
  const s = state.repos[entry.id] = {
    id: entry.id, repository: entry.repository, workflow: entry.workflow, ext_ref: extRef,
    failure_policy: entry.failure_policy || 'block', owners: entry.owners || [],
    timeout_minutes: entry.timeout_minutes || 60, dispatch_id: dispatchId, dispatched_at: new Date().toISOString(),
    check_run_id: null, remote_run_id: null, remote_run_url: null, remote_conclusion: null, conclusion: null,
  };
  const check = await own.post(`/repos/${repo}/check-runs`, {
    name, head_sha: target.headSha, status: 'queued', external_id: dispatchId, details_url: orchestratorUrl,
    output: {
      title: `Dispatching ${entry.repository} @ ${extRef}`,
      summary: `Dispatching \`${entry.workflow}\` on \`${entry.repository}\` @ \`${extRef}\` with F´ \`${target.headRepo}@${short(target.headSha)}\`.\n\nOrchestrator: ${orchestratorUrl}`,
    },
  });
  s.check_run_id = check.id;
  try {
    await ext.post(`/repos/${entry.repository}/actions/workflows/${entry.workflow}/dispatches`, {
      ref: extRef,
      inputs: { fprime_repository: target.headRepo, fprime_ref: target.headSha, dispatch_id: dispatchId },
    });
    console.log(`[${entry.id}] dispatched ${entry.repository}/${entry.workflow} @ ${extRef} (dispatch_id=${dispatchId})`);
  } catch (e) {
    s.error = `dispatch failed: ${e.message}`;
    s.remote_conclusion = 'dispatch_failed';
    console.log(`::error::[${entry.id}] ${s.error}`);
  }
  saveState(state);
}

// The dispatch API returns 204 with no run id: find the run whose title carries our dispatch_id.
async function correlate(state) {
  const pending = Object.values(state.repos).filter((s) => !s.remote_run_id && !s.remote_conclusion);
  const deadline = Date.now() + CORRELATE_TIMEOUT_MS;
  while (pending.length && Date.now() < deadline) {
    for (const s of [...pending]) {
      const since = new Date(new Date(s.dispatched_at).getTime() - 60_000).toISOString();
      const runs = await ext.get(`/repos/${s.repository}/actions/runs?event=workflow_dispatch&created=${encodeURIComponent('>=' + since)}&per_page=50`);
      const run = runs.workflow_runs.find((r) => (r.display_title || r.name || '').includes(s.dispatch_id));
      if (!run) continue;
      s.remote_run_id = run.id; s.remote_run_url = run.html_url;
      pending.splice(pending.indexOf(s), 1);
      console.log(`[${s.id}] remote run ${run.html_url}`);
      await own.patch(`/repos/${repo}/check-runs/${s.check_run_id}`, {
        status: 'in_progress', details_url: run.html_url,
        output: { title: `Running on ${s.repository} @ ${s.ext_ref}`, summary: `Remote run: ${run.html_url}\n\nOrchestrator: ${orchestratorUrl}` },
      });
      saveState(state);
    }
    if (pending.length) await sleep(Math.min(POLL_MS, 15_000));
  }
  for (const s of pending) {
    s.remote_conclusion = 'not_found';
    s.error = `no run with dispatch_id ${s.dispatch_id} appeared on ${s.repository} within ${CORRELATE_TIMEOUT_MS / 60000} min`;
    console.log(`::error::[${s.id}] ${s.error}`);
  }
  saveState(state);
}

// ---------------------------------------------------------------- poll
async function pollAll(state) {
  const active = () => Object.values(state.repos).filter((s) => s.remote_run_id && !s.remote_conclusion);
  while (active().length) {
    await sleep(POLL_MS);
    for (const s of active()) {
      const run = await ext.get(`/repos/${s.repository}/actions/runs/${s.remote_run_id}`);
      if (run.status === 'completed') {
        s.remote_conclusion = run.conclusion;
        console.log(`[${s.id}] completed: ${run.conclusion}`);
      } else if (Date.now() - new Date(s.dispatched_at).getTime() > s.timeout_minutes * 60_000) {
        console.log(`::warning::[${s.id}] timed out after ${s.timeout_minutes} min; cancelling remote run`);
        await ext.post(`/repos/${s.repository}/actions/runs/${s.remote_run_id}/cancel`).catch(() => {});
        s.remote_conclusion = 'timed_out';
      }
    }
    saveState(state);
  }
}

// ---------------------------------------------------------------- report
async function failureDetails(s) {
  if (!s.remote_run_id) return '';
  const jobs = await ext.get(`/repos/${s.repository}/actions/runs/${s.remote_run_id}/jobs?per_page=100`);
  const bad = jobs.jobs.filter((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped');
  return bad.map((j) => {
    const steps = (j.steps || []).filter((st) => st.conclusion && st.conclusion !== 'success' && st.conclusion !== 'skipped')
      .map((st) => `    - step \`${st.name}\`: ${st.conclusion}`).join('\n');
    return `- [${j.name}](${j.html_url}): **${j.conclusion}**${steps ? '\n' + steps : ''}`;
  }).join('\n');
}

function checkConclusion(s) {
  if (s.remote_conclusion === 'success') return 'success';
  if (s.failure_policy === 'notify') return 'neutral';
  if (s.remote_conclusion === 'cancelled') return 'cancelled';
  if (s.remote_conclusion === 'timed_out') return 'timed_out';
  return 'failure';
}

async function finalizeOne(target, s) {
  s.conclusion = checkConclusion(s);
  const details = s.remote_conclusion === 'success' ? '' : await failureDetails(s);
  const header = `\`${s.repository}\` @ \`${s.ext_ref}\` with F´ \`${target.headRepo}@${short(target.headSha)}\`: **${s.remote_conclusion}**`;
  const lines = [header, ''];
  if (s.remote_run_url) lines.push(`Remote run: ${s.remote_run_url}`);
  if (s.error) lines.push(`Error: ${s.error}`);
  if (s.failure_policy === 'notify' && s.remote_conclusion !== 'success') {
    lines.push('', `This repo is \`failure_policy: notify\`: the failure does not block the PR; owners (${s.owners.map((o) => '@' + o).join(' ')}) have been notified.`);
  }
  lines.push('', `Orchestrator run (use "Re-run failed jobs" there to re-dispatch only the failed repos): ${orchestratorUrl}`);
  await own.patch(`/repos/${repo}/check-runs/${s.check_run_id}`, {
    status: 'completed', conclusion: s.conclusion, details_url: s.remote_run_url || orchestratorUrl,
    output: { title: `${s.remote_conclusion} (${s.repository} @ ${s.ext_ref})`, summary: lines.join('\n'), text: details || undefined },
  });
  if (s.failure_policy === 'notify') await notifyOwners(target, s, details);
}

// notify policy: one PR comment per ext repo (updated in place), or one tracking issue when
// there is no PR (closed again once the repo passes).
async function notifyOwners(target, s, details) {
  const marker = `<!-- ext-ci-notify:${s.id} -->`;
  const mentions = s.owners.map((o) => '@' + o).join(' ');
  const failed = s.remote_conclusion !== 'success';
  if (target.pr) {
    const comments = await own.get(`/repos/${repo}/issues/${target.pr}/comments?per_page=100`);
    const existing = comments.find((c) => c.body && c.body.includes(marker));
    if (!failed && !existing) return;
    const body = failed
      ? `${marker}\n### External CI: \`${s.id}\` failed (non-blocking)\n\n\`${s.repository}\` @ \`${s.ext_ref}\` does not pass against ${short(target.headSha)}: ${s.remote_run_url || s.error}\n\n${details}\n\n${mentions} — this repo is \`failure_policy: notify\`, so the PR is not blocked, but it needs a look.`
      : `${marker}\n### External CI: \`${s.id}\` passing again\n\n\`${s.repository}\` @ \`${s.ext_ref}\` passes against ${short(target.headSha)}: ${s.remote_run_url}`;
    if (existing) await own.patch(`/repos/${repo}/issues/comments/${existing.id}`, { body });
    else await own.post(`/repos/${repo}/issues/${target.pr}/comments`, { body });
    return;
  }
  const title = `[ext-ci] ${s.id} failing on ${target.headBranch}`;
  const issues = await own.get(`/repos/${repo}/issues?state=open&per_page=100`);
  const existing = issues.find((i) => !i.pull_request && i.body && i.body.includes(marker) && i.title === title);
  if (failed) {
    const body = `${marker}\n\`${s.repository}\` @ \`${s.ext_ref}\` fails against \`${target.headBranch}\` (${short(target.headSha)}): ${s.remote_run_url || s.error}\n\n${details}\n\n${mentions}\n\nThis issue is closed automatically once the repo passes again.`;
    if (existing) await own.post(`/repos/${repo}/issues/${existing.number}/comments`, { body: `Still failing at ${short(target.headSha)}: ${s.remote_run_url || s.error}` });
    else await own.post(`/repos/${repo}/issues`, { title, body });
  } else if (existing) {
    await own.post(`/repos/${repo}/issues/${existing.number}/comments`, { body: `Passing again at ${short(target.headSha)}: ${s.remote_run_url}` });
    await own.patch(`/repos/${repo}/issues/${existing.number}`, { state: 'closed', state_reason: 'completed' });
  }
}

async function carryForward(manifest, target, { entry, prior }, state) {
  state.repos[entry.id] = {
    id: entry.id, repository: entry.repository, failure_policy: entry.failure_policy || 'block', carried_forward: true,
    check_run_id: prior.id, remote_run_url: prior.details_url, remote_conclusion: 'success', conclusion: 'success',
  };
  await own.patch(`/repos/${repo}/check-runs/${prior.id}`, {
    output: {
      title: prior.output.title,
      summary: `${prior.output.summary}\n\n_Not re-run in attempt ${attempt} of ${orchestratorUrl}: previous success carried forward._`,
    },
  });
  console.log(`[${entry.id}] carried forward success from ${prior.details_url}`);
}

function writeSummary(target, state) {
  const rows = Object.values(state.repos).map((s) =>
    `| \`${s.id}\` | ${s.repository} | \`${s.ext_ref || '-'}\` | ${s.failure_policy} | ${s.carried_forward ? 'carried forward' : s.remote_conclusion} | ${s.conclusion} | ${s.remote_run_url ? `[run](${s.remote_run_url})` : (s.error || '')} |`);
  const md = [
    `### External CI for \`${target.headRepo}@${short(target.headSha)}\`${target.pr ? ` (PR #${target.pr})` : ` (${target.headBranch})`} — attempt ${attempt}`,
    '', '| id | repository | ext ref | policy | remote | check | link |', '|---|---|---|---|---|---|---|', ...rows, '',
  ].join('\n');
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  console.log(md);
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ target, attempt, orchestrator_url: orchestratorUrl, repos: state.repos }, null, 2));
}

// ---------------------------------------------------------------- modes
async function run() {
  const target = await resolveTarget();
  console.log(`target: ${JSON.stringify(target)}`);
  const manifest = await loadManifest(target.baseRef);
  const { carried, dispatch } = await selectRepos(manifest, target);
  console.log(`dispatch: [${dispatch.map((e) => e.id)}]  carried forward: [${carried.map((c) => c.entry.id)}]`);
  const state = { target, attempt, repos: {} };
  saveState(state);
  for (const c of carried) await carryForward(manifest, target, c, state);
  for (const entry of dispatch) await dispatchOne(manifest, entry, target, state);
  await correlate(state);
  await pollAll(state);
  for (const s of Object.values(state.repos)) if (!s.carried_forward) await finalizeOne(target, s);
  writeSummary(target, state);
  const blocking = Object.values(state.repos).filter((s) => s.failure_policy !== 'notify' && s.conclusion !== 'success');
  if (blocking.length) {
    console.log(`::error::blocking external repos failed: ${blocking.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }
}

async function cancel() {
  const state = loadState();
  if (!state) return console.log('no state file; nothing to cancel');
  for (const s of Object.values(state.repos)) {
    if (s.carried_forward || s.remote_conclusion) continue;
    if (s.remote_run_id) {
      console.log(`[${s.id}] cancelling ${s.remote_run_url}`);
      await ext.post(`/repos/${s.repository}/actions/runs/${s.remote_run_id}/cancel`).catch((e) => console.log(`  ${e.message}`));
    }
    if (s.check_run_id) {
      await own.patch(`/repos/${repo}/check-runs/${s.check_run_id}`, {
        status: 'completed', conclusion: 'cancelled',
        output: { title: 'Cancelled by orchestrator', summary: `The orchestrator run was cancelled; remote run ${s.remote_run_url || '(not started)'} was cancelled too.\n\n${orchestratorUrl}` },
      }).catch((e) => console.log(`  ${e.message}`));
    }
  }
}

await (mode === 'cancel' ? cancel() : run());
