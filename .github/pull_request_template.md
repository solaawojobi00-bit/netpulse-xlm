<!--
Thanks for contributing to NetPulse.

Keep the headings below — reviewers rely on the structure being consistent
across PRs. Delete these instructional comment blocks as you fill each one
in, and drop any section that genuinely doesn't apply (say why in Notes for
Reviewers rather than leaving it empty).

Open the PR as a draft if it isn't ready for review yet.
-->

## Short title describing what this PR does

### Problem

<!--
What was broken, missing, or unsatisfying before this change, and why it
mattered. Point at the issue for full context rather than restating it.

The table below is worth filling in whenever the change alters observable
behavior; delete it for pure refactors or documentation changes.
-->

| Scenario | Prior Behavior | Desired Behavior |
| --- | --- | --- |
| _when does this come up_ | _what happened before_ | _what happens now_ |

### Solution

<!-- How you solved it. One bullet per meaningful decision. -->

-

### Changes

<!--
One row per file touched. Say what changed *and* why — the rationale is the
part a reviewer can't reconstruct from the diff.
-->

| File | Changes & Rationale |
| --- | --- |
| `path/to/file.ts` | _what changed here, and why_ |

### Regression Tests

<!--
Map each acceptance criterion from the issue to how you verified it.
"Verified" means you ran or observed it, not that the code looks correct.
-->

| Acceptance Criterion | Verification Status | Details |
| --- | --- | --- |
| _criterion from the issue_ | Verified | _how you confirmed it_ |

### Testing

<!--
Paste literal command output — not a summary of it. Include the test run,
and the build for frontend changes. Trim long output to the relevant parts,
but don't paraphrase it.
-->

```text

```

### Notes for Reviewers

<!--
Tradeoffs you weighed, things you deliberately did not do, anything you'd
like a closer look at, and follow-up work that deserves its own issue.
-->

### Checklist

- [ ] Backend type-checks — `npx tsc --noEmit` in `backend/`
- [ ] Frontend builds — `npm run build` in `frontend/`
- [ ] Tests pass — `npm test` in `backend/` and in `frontend/`
- [ ] Docs updated if behavior changed — `README.md`, `ARCHITECTURE.md`,
      `PRD.md`, or `backend/.env.example`, whichever the change affects
- [ ] Scope matches the issue — no unrelated changes bundled in

Closes #
