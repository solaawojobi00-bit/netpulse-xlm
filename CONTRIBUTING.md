# Contributing to NetPulse

Thank you for your interest in contributing to NetPulse! This guide outlines how to set up your development environment, claim issues, and submit pull requests.

---

## Prerequisites

- **Node.js**: Version 24 (matching the CI environment, which pins
  `node-version: 24`). Older versions may work but are not what CI runs
  against, and the dependency-audit step behaves differently on npm 10 and
  older — see [Running Checks](#running-checks).
- **npm**: Whatever ships with Node 24 (npm 11). No separate install needed.
- **Git**: Configured with your name and email.

NetPulse is organized as two separate npm packages:
- `backend/`: Express HTTP server, Horizon SSE subscriber, SQLite persistence, and WebSocket fan-out.
- `frontend/`: React + Vite dashboard with Recharts visualizations and WebSocket subscription.

---

## Local Setup

Run the backend and frontend in separate terminal windows:

### 1. Backend Setup

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

The backend server will start on port `4000` (configurable via `PORT` in `backend/.env`).

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

The frontend dev server runs Vite (default `http://localhost:5173`) and proxies `/api` and `/ws` to the backend on port `4000`.

---

## Claiming an Issue

1. **Find an issue**: Check the [issue tracker](https://github.com/solaawojobi00-bit/netpulse-xlm/issues) for open issues.
2. **Claim by commenting**: Comment on the issue you wish to work on to claim it. Claims are honored on a first-comment timestamp basis.
3. **One issue at a time**: Claim and complete one issue before picking up another.
4. **Unclaiming**: If you can no longer work on an issue, please leave a comment to unclaim it so others can take it on.

---

## Branch and PR Conventions

- **Branch naming**: Name your branch `<type>/issue-<number>-<short-slug>`,
  where `<type>` describes the change:

  | Type | Use for | Example |
  | --- | --- | --- |
  | `fix` | bug fixes | `fix/issue-34-contributing-guide` |
  | `feat` | new features | `feat/issue-41-congestion-webhook-alerts` |
  | `docs` | documentation | `docs/issue-40-api-reference` |
  | `ci` | workflows and build tooling | `ci/add-codeql-scanning` |
  | `chore` | maintenance | `chore/pr-template-and-contributing-fix` |

  Work with no issue behind it — a CI fix, a maintenance pass — drops the
  `issue-<number>` segment, as the `ci` and `chore` examples above show.

- **Scope**: Keep changes strictly within the scope of the claimed issue. Do not bundle unrelated refactors, file modifications, or additional features into the PR.

- **One issue per PR**: Each pull request should resolve exactly one issue.

- **PR Description**: Reference the issue in your PR description using the GitHub keyword:
  ```text
  Closes #<number>
  ```
  Follow the repository's pull request template, providing:
  - Problem description (and scenarios table where applicable)
  - Solution summary
  - Table of changed files with rationale
  - Regression tests table mapped against the issue's acceptance criteria
  - Literal testing output
  - Notes for reviewers

---

## Running Checks

Before opening a pull request, ensure all local checks pass. These mirror the
steps CI runs on pull requests, in the same order.

### Backend Checks

From the repository root:

```bash
# Audit dependencies for high/critical advisories
node .github/scripts/audit-deps.mjs backend
```

In `backend/`:

```bash
# Type-check TypeScript
npx tsc --noEmit

# Run unit and integration tests
npm test
```

### Frontend Checks

From the repository root:

```bash
# Audit production dependencies for high/critical advisories
node .github/scripts/audit-deps.mjs frontend --omit=dev
```

In `frontend/`:

```bash
# Type-check and build production bundle
npm run build

# Measure the styles.css palette against WCAG AA
npm run audit:contrast

# Run frontend tests
npm test
```

`npm run audit:contrast` is easy to forget locally and will fail the frontend
job if a palette change regresses contrast. jsdom cannot resolve cascaded
colours, so the axe checks in the test suite skip contrast and this script
covers it instead.

### A note on the dependency audit

`audit-deps.mjs` wraps `npm audit` rather than calling it directly, because
`npm audit` exits non-zero both for a real advisory and for a registry outage.
The script tells the two apart: a high or critical advisory fails, while an
unreachable audit endpoint produces a warning and passes. **A run that warns
means your dependencies were not audited — it is not a clean bill of health.**

### What must be green

Five checks run on a pull request, across two workflow files, and all must pass
before merge:

| Check | Workflow |
| --- | --- |
| Backend Type-Check & Tests | `.github/workflows/ci.yml` |
| Frontend Build & Tests | `.github/workflows/ci.yml` |
| Secret Scan (gitleaks) | `.github/workflows/ci.yml` |
| Analyze (javascript-typescript) | `.github/workflows/codeql.yml` |
| CodeQL | `.github/workflows/codeql.yml` |

The Secret Scan and CodeQL checks have no local equivalent in the commands
above; they run only in CI.

Branch protection also requires your branch to be up to date with `main`, so a
PR that has fallen behind needs updating before it can merge:

```bash
gh pr update-branch <number>
```
