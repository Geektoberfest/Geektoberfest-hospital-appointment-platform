# Issue #2: GitHub Actions Workflow for Automated Build & Test Checks

> File name note: sibling documentation uses `ISSUE_13_CHANGES.md` / `ISSUE_14_CHANGES.md`, while
> issues #5, #11 and #15 use lower-case names (`issue-5-changes.md`, `issue-11-changes.md`,
> `issue-15-changes.md`). This file keeps the name requested by the issue (`issue-2-changes.md`)
> and follows the same section structure and level of detail.

## 1. Issue Overview and Objective

**Objective:** add one minimal GitHub Actions workflow so that every push and every pull request is
verified by an automated run of the project's existing test and build commands, and the job fails
when a test or build fails.

**Delivered:** `.github/workflows/ci.yml` with two jobs, using only the tooling the repository
already has (npm + the lockfiles + `node --test` + `vite build`) and no new dependency:

| Job | What it verifies |
|---|---|
| **Frontend tests and production build** | `npm ci`, `npm test` (54 tests), `npm run build` — all inside `frontend/` |
| **Backend tests** | `npm ci`, a `node --check` parse sweep of every tracked backend file, `npm test` (90 tests) — all inside `backend/` |

The workflow is scoped to checking only. It contains no deployment, publish, release, container or
security-scanning steps, and it adds no GitHub repository secrets.

### Why the workflow also runs the backend suite

This issue's own acceptance criteria (`.github/workflows/ci.yml` for issue #2, recorded in
`CONTRIBUTING_ISSUES.md` as "Issue 1: [CI/CD] Add GitHub Actions Workflow for Automated Build &
Test Checks") are:

1. "Installs frontend dependencies (`npm ci`), runs tests (`npm test`), and executes Vite build
   (`npm run build`)."
2. "**Installs backend dependencies and executes test suite when configured.**"
3. "Fails CI job if any test fails or syntax errors occur."

Criterion 2 is conditional ("when configured"), and the backend test suite *is* configured
(`backend/package.json` → `"test": "node --test tests/*.test.js"`) and *can* run in a clean
environment: every backend test stubs the database calls it needs and sets its own `JWT_SECRET` /
`NODE_ENV` values, so no MongoDB instance, `.env` file or secret is required. Criterion 3 is what
justifies the small `node --check` step, which covers backend files the test suite never imports
(`backend/scripts/seed.js`); the frontend equivalent of that check is `vite build`, which fails on
any syntax or import error.

If this is considered out of scope, the `backend:` job is self-contained and can be deleted without
touching the frontend job.

## 2. Workflow Triggers

```yaml
on:
  push:
  pull_request:
```

- **Every push and every pull request**, with **no `branches:` filter**.
- The issue text suggests `main` and `feature/*`. That filter was deliberately *not* applied: this
  repository works on `feat/*`, `fix/*`, `test/*` and `chore/*` branch names (for example
  `feat/issue-15-session-security`, `feat/issue-11-waitlist-notifications`,
  `test/issue-5-frontend-utility-tests`), so a `feature/*` filter would silently skip CI for most
  real work — exactly what the issue asks to avoid. Running on all branches and PRs also covers the
  default branch and fork PRs.
- The only consequence is that a same-repository pull request produces two runs (one for the `push`
  event and one for the `pull_request` event). That is the default GitHub behaviour and is
  acceptable for a two-job check workflow; a `concurrency` group with `cancel-in-progress: true`
  could deduplicate them later (see section 9).
- `permissions: contents: read` is set so the workflow's `GITHUB_TOKEN` is read-only, which is all
  `actions/checkout` needs.

## 3. Node.js and Package-Manager Configuration

| Setting | Value | Reason |
|---|---|---|
| Runner | `ubuntu-latest` (pinned once per job) | The project's supported deployment targets are Linux; GitHub-hosted runners are always current, which matters for `actions/*@v7`. |
| Node.js | `'24'` | `vite@8.3.2` and `@vitejs/plugin-react@6.1.1` declare `engines.node: "^20.19.0 \|\| >=22.12.0"` and `react-router-dom@7.18.4` declares `>=20.0.0`; the project's test runner (`node --test`) needs Node ≥ 18. Node 24 is the current LTS line and is the exact major (24.21.0) used for the local verification in section 8. |
| Package manager | npm | Both apps ship `package-lock.json` (`lockfileVersion: 3`, npm ≥ 7). No yarn/pnpm/bun lockfile, workspace config or `packageManager` field exists, so npm is the verified choice. |
| Actions | `actions/checkout@v7`, `actions/setup-node@v7` | The current major lines of both actions as of this change (verified on their release pages: [checkout releases](https://github.com/actions/checkout/releases) latest `v7.0.1`, [setup-node releases](https://github.com/actions/setup-node/releases) latest `v7.1.0`). Major tags are used so patch/minor security fixes are picked up automatically. |
| Version pinning for Node | `node-version: '24'` — quoted | Quoting prevents YAML from treating the value as a number and matches the documented `setup-node` usage. |

There is no `.nvmrc`, `.node-version` or `engines` field anywhere in the repository, so the workflow
is the only place that pins a Node version (see section 9).

## 4. Dependency Installation and Caching

- **Install command:** `npm ci` in each job, with `defaults.run.working-directory` set to the
  package directory (`frontend/` and `backend/` respectively). `npm ci` installs exactly the
  versions in the lockfile, fails if the lockfile and `package.json` disagree, and never rewrites
  the lockfile — so CI cannot silently change dependency versions.
- **Cache:** `actions/setup-node` with `cache: npm`, which caches the npm download directory keyed
  on the lockfile.
- **Cache key path:** `cache-dependency-path: frontend/package-lock.json` /
  `backend/package-lock.json`. This input is resolved from the repository root (it is a `uses:` step,
  so it is *not* affected by `defaults.run.working-directory`) and would otherwise default to
  `./package-lock.json`, which does not exist at the root — the cache would be missed and, more
  importantly, `setup-node` would fail to find a lockfile to key on.
- **Cross-platform install was verified, not assumed.** The lockfiles were generated on Windows, and
  the frontend build uses native binaries. The frontend lockfile lists the Linux/x64 variants that
  `ubuntu-latest` needs — `@rolldown/binding-linux-x64-gnu`, `@tailwindcss/oxide-linux-x64-gnu` and
  `lightningcss-linux-x64-gnu` (plus the vite-nested copy) — including 8 os/cpu-restricted
  `linux`+`x64` entries in total, so `npm ci` resolves them on Ubuntu. The backend lockfile's only
  os-restricted entry is `fsevents` (`darwin`), an optional dependency npm skips on Linux.
- No lockfile was created, modified or regenerated, and no dependency version was changed.

## 5. Unit-Test and Production-Build Steps

Frontend job (`working-directory: frontend`):

| Step name | Command | Why it is safe in CI |
|---|---|---|
| Install dependencies | `npm ci` | Reproducible install from `package-lock.json`. |
| Run frontend unit tests | `npm test` | The script is `node --test tests/*.test.js` — a single, non-interactive run. It does **not** launch a watch process, so **no CI-specific script variant or flag was needed** (the script was left untouched). The shell expands the glob to the five test files. |
| Build production bundle | `npm run build` | `vite build` writes to `dist/`, which is gitignored (no dirty-tree side effects) and also fails the job on any frontend syntax/import error. |

Backend job (`working-directory: backend`):

| Step name | Command | Why it is safe in CI |
|---|---|---|
| Install dependencies | `npm ci` | Same as above. |
| Check that every backend file parses | `for file in $(git ls-files '*.js'); do node --check "$file"; done` | `git ls-files` lists tracked files only (never `node_modules`), and every backend file is CommonJS (`backend/package.json` has no `"type"`), so `node --check` is the correct syntax check. |
| Run backend test suite | `npm test` | `node --test tests/*.test.js`; the suites stub their model calls and set their own `JWT_SECRET`/`NODE_ENV`/cookie variables, so no database or secrets are needed. |

**Failure behaviour (no masking):** each required command is its own step, so a non-zero exit fails
that step and the job. There is no `continue-on-error`, no `|| true`, no `if: always()` and no
`set +e` anywhere in the workflow, and no step is configured to report success after a failed
command. Because the two areas are separate jobs, the failing job name ("Frontend tests and
production build" vs "Backend tests") is visible in the PR check list, and the failing step name is
visible in the job log.

## 6. Environment-Variable Handling

**No environment variables, `.env` files, secrets or external services are required, and none were
added.**

- The frontend tests reference no environment variables at all (verified by searching
  `frontend/tests` for `process.env` / `import.meta.env`): they build their own inputs and inject
  fakes. `src/api/axios.js` reads `import.meta.env?.VITE_API_URL`, which is `undefined` under plain
  Node and falls back to the documented `http://localhost:5000/api` default, so the tests pass
  without it. `vite build` does not require `VITE_API_URL` either — the app has the same fallback.
- The backend suites set every variable they consume themselves (`process.env.JWT_SECRET`,
  `process.env.NODE_ENV = 'test'`, and, in the auth suite, the `REFRESH_*` variables, each restored
  in a `t.after` hook). Nothing reads `MONGO_URI`, `CLIENT_URL` or `REDIS_URL`, and no test opens a
  database or Redis connection.
- Consequently the workflow declares **no `env:` block and no `secrets:` reference**, and no
  repository secret needs to be configured for CI to pass. Application security configuration was
  not weakened to make CI green: production cookie/CSRF/session settings are asserted *harder* by
  the backend suite, which sets `NODE_ENV=production` itself.

## 7. Files Added or Modified

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | **Added** (the only change required by the issue). The repository had no `.github/` directory and no CI configuration of any kind. |
| `issue-2-changes.md` | **Added** — this document. |

No application source file, package manifest, lockfile, `README.md` or other documentation was
modified, and no test script was altered.

## 8. Commands Executed and Actual Results

Every command below was executed locally from the same working directory (`frontend/` or `backend/`)
with the exit status captured explicitly rather than inferred from filtered output. All rows are the
workflow's own step commands, **except** the two `npm ci --dry-run` rows, which are the safety-
checked variants of the workflow's `npm ci` steps (see "What was NOT verified" below).

| Command | Working dir | Actual result |
|---|---|---|
| `npm test` | `frontend/` | **exit 0** — `tests 54, pass 54, fail 0` |
| `npm run build` | `frontend/` | **exit 0** — `✓ 716 modules transformed`, `✓ built in 539ms`; only the pre-existing `>500 kB` chunk-size advisory |
| `for file in $(git ls-files '*.js'); do node --check "$file"; done` | `backend/` | **exit 0** — 54 files checked, no failures |
| `npm test` | `backend/` | **exit 0** — `tests 90, pass 90, fail 0` |
| `npm ci --dry-run` | `frontend/` | **exit 0** — "up to date"; the lockfile is in sync with `package.json` |
| `npm ci --dry-run` | `backend/` | **exit 0** — "up to date"; the lockfile is in sync with `package.json` |
| YAML parse of `.github/workflows/ci.yml` | repo root | **Parsed successfully.** Triggers read as `['push', 'pull_request']`; jobs read as `['frontend', 'backend']`, each with `ubuntu-latest`, the expected `working-directory`, the two `uses:` steps and the expected `run:` commands. |

### YAML validation details

No YAML validator was installed in this environment (no `ruby`, and Python 3.14.8 without PyYAML).
`pyyaml` was therefore installed **into a temporary directory only**
(`python -m pip install --target /tmp/yamlcheck pyyaml`), used with `PYTHONPATH` for this single
parse, and never added to the repository or to the system's site-packages. The repository itself
gained no dependency.

Two notes on the parser, so the validation output is not misread:

- PyYAML implements YAML 1.1, where the bare key `on` is a boolean, so it reported the top-level
  keys as `['name', True, 'permissions', 'jobs']` and the triggers were read through the `True`
  key. This is a well-known PyYAML/YAML-1.1 quirk. GitHub Actions uses a YAML 1.2 parser and reads
  `on:` as the trigger key; the conventional unquoted `on:` (used by the overwhelming majority of
  workflows, and verified here to parse) was kept deliberately rather than risking a parser
  incompatibility for a lint nicety.
- `npm ci --dry-run` verifies lockfile/manifest consistency and resolution without touching
  `node_modules`. A full `npm ci` was **not** run locally, because it deletes and re-downloads the
  entire `node_modules` tree of the working checkout; the workflow will run the real `npm ci`.

### What was NOT verified

**No GitHub Actions run has been observed.** These changes are unpushed local edits, so this
document reports *local* command results and a YAML parse only. It does **not** claim that a remote
workflow run passed; that can only be confirmed after the branch is pushed (the user's
responsibility, and explicitly out of scope for this task).

## 9. Remaining CI and Environment Limitations

1. **No remote run yet.** The workflow has never executed on GitHub. The first push will be its
   first real test; the most likely first-run surprises would be a typo in an input name or a
   runner-image difference, neither of which can be checked from here.
2. **Timing-sensitive assertions are the main flakiness risk.** Some backend tests assert
   scheduled behaviour (the notification heartbeat tests shorten the interval via
   `SSE_HEARTBEAT_MS` and the SSE transport tests allow generous timeouts for frames). They pass
   comfortably here, but a heavily loaded or throttled runner is the one place they could become
   flaky. If the workflow ever shows an intermittent failure, review those assertions before
   assuming a code regression.
3. **Node version is only pinned in CI.** There is no `.nvmrc`, `.node-version` or `engines` field,
   so a contributor on an older Node could still hit local-only failures that CI does not
   reproduce. Adding `.nvmrc` (or `engines`) would align local development with CI — a small,
   separate follow-up.
4. **Same-repo PRs run twice** (a `push` run and a `pull_request` run). A `concurrency` group with
   `cancel-in-progress: true` would cancel superseded runs and save minutes; it was left out to keep
   the workflow minimal.
5. **Actions are referenced by major tag, not by commit SHA.** `@v7` receives patch and minor
   updates automatically, which is the GitHub-recommended default, but it is not immutable. Pinning
   to full SHAs (with Dependabot bumps) is the stronger supply-chain practice if that is wanted.
6. **`ubuntu-latest` is a moving target.** It is currently an Ubuntu LTS image and GitHub updates it
   over time, so a future image change could alter the toolchain. Pinning `ubuntu-24.04` would make
   the environment reproducible at the cost of manual bumps.
7. **npm cache and runner minutes.** The `setup-node` cache removes most of `npm ci`'s download cost
   after the first run, but two jobs each install their own dependency tree, so each push consumes
   two install steps. Merging both into one job would halve that, at the cost of losing independent
   job-level status checks.
8. **No branch protection or required-status-check configuration.** Making the two jobs *required*
   for merging into the default branch is a repository setting, not something a workflow file can
   declare.
9. **No coverage, lint or type-check step.** The repository has no linter, no type checker and no
   coverage tooling configured (no `lint` script, no ESLint/Biome config, no TypeScript), so CI runs
   exactly the checks the project actually supports. Adding any of those would first require adding
   the tooling to the project.
10. **`actions/*@v7` and self-hosted runners.** The v7 action lines update dependencies and use a
    newer Node runtime; GitHub-hosted runners satisfy their minimum runner version, but a
    self-hosted runner pinned to an old version would need updating first. Not applicable to this
    repository, which uses hosted runners (`runs-on: ubuntu-latest`).
