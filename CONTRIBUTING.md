# Contributing to e-financials-mcp

Development happens on **GitHub** (`werkstatt-jasper/e-financials-mcp`). The default branch is **`main`**.

## Git setup

- Set your default branch name for new repos: `git config --global init.defaultBranch main`
- Clone with **HTTPS** (recommended for CI and forks):

  ```bash
  git clone https://github.com/werkstatt-jasper/e-financials-mcp.git
  ```

- To push via SSH while keeping an HTTPS remote:  
  `git config --global url."git@github.com:".insteadOf "https://github.com/"`  
  (optional; only if you use SSH keys with GitHub.)

- If your local branch is still named **`master`**, rename and track **`main`**:

  ```bash
  git branch -m master main
  git fetch origin
  git branch -u origin/main main
  ```

## Branch and PR workflow

Use the same discipline as a typical GitLab MR flow: work on a **feature branch** that actually contains your commits, then open a **pull request** into **`main`**.

1. `git fetch origin`
2. `git checkout main && git pull --ff-only`
3. `git checkout -b <issue-or-short-slug>` (e.g. `42-fix-client-list`)
4. Implement changes.
5. Before pushing:

   ```bash
   npm run lint:fix && npm run test:coverage && npm run build
   ```

6. `git push -u origin <issue-or-short-slug>`
7. Open a PR with the [GitHub CLI](https://cli.github.com/):

   ```bash
   gh pr create --base main --head <issue-or-short-slug> \
     --title "Short title" \
     --body $'What changed.\n\nCloses #<issue-number>'
   ```

   Or create the PR from the GitHub web UI. Always confirm the PR **compare** shows your commits (non-empty diff).

**Avoid empty PRs:** The PR **head** must be the branch you pushed. If `gh pr create` targets the wrong branch, the PR will show no changes—same pitfall as `glab mr create` without `-s` on GitLab.

## Requirements

- **Node.js 20+** (see `engines` in `package.json`; CI uses Node 20 and 22).
- Follow existing **Biome** / **TypeScript** / **ESM `.js` import** conventions in `src/`.

## Downstream (GitLab SaaS)

The hosted product at `werkstatt.ee/e-financials-mcp` consumes this repo as a **git submodule** at `packages/core/`. After your change is merged here, maintainers bump the submodule pointer on GitLab when releasing integrated builds.
