# Contributing to NetPulse

Thank you for your interest in contributing to NetPulse! This guide outlines how to set up your development environment, claim issues, and submit pull requests.

---

## Prerequisites

- **Node.js**: Version 20 LTS or higher (matching CI environment).
- **npm**: Version 9 or higher.
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

- **Branch naming**: Name your branch using the format:
  ```text
  fix/issue-<number>-<short-slug>
  ```
  Example: `fix/issue-34-contributing-guide`

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

Before opening a pull request, ensure all local checks pass. These match the automated CI checks executed on pull requests:

### Backend Checks

In `backend/`:

```bash
# Type-check TypeScript
npx tsc --noEmit

# Run unit and integration tests
npm test
```

### Frontend Checks

In `frontend/`:

```bash
# Type-check and build production bundle
npm run build

# Run frontend tests
npm test
```

All CI workflows in `.github/workflows/ci.yml` must be fully green for PRs to be merged.
