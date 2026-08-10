# Sync with upstream

Merge the latest upstream changes into this fork.

Upstream is `rohitg00/agentmemory` on branch `main`. This fork lives on `master`.
Read `README.md` for what this fork changes and why, and `AGENTS.md` for architecture and consistency rules.
`.github/workflows/upstream-check.yml` holds the upstream URL and is the weekly check that flags when we fall behind.

## Steps

1. Work on a new branch off `master`. Never merge straight into `master`.
2. Add the upstream remote if it is missing, then fetch it.
   `git remote add upstream https://github.com/rohitg00/agentmemory.git`
   `git fetch --no-tags upstream main`
3. Merge `upstream/main` into the branch with a merge commit.
4. Resolve each conflict so both sides survive. Take upstream's version for anything this fork never touched. When both sides changed the same code, reapply our patch on top of upstream's new version instead of restoring our old file.
5. Confirm our patches still exist after the merge. `git diff upstream/main -- <path>` shows what this fork adds for a file, and `README.md` lists the behavior that must hold.
6. Keep the diff against upstream as small as it was before the merge. No drive-by refactors, no formatting churn.
7. Verify with `npm run build`, `npm run skills:check`, and `npm test`. Fix what breaks.
8. Push the branch and open a PR into `master`.

## When to stop and ask

Stop and consult the user instead of guessing when:

- a conflict has no obvious resolution, for example upstream rewrote the code one of our patches depends on
- upstream removed or renamed something our patches build on
- keeping upstream's change would drop fork behavior described in `README.md`
- tests fail and the cause is not clear from the merge

Say what conflicted and what you propose. Do not invent a compromise on your own.
