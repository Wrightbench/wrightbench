# GitHub repository settings checklist

The distribution pipeline assumes the repository/organization settings
below. They require **admin** permissions on `Wrightbench/wrightbench`
and must be applied by an owner through the GitHub UI (or `gh api`);
they are deliberately not applied automatically by any workflow.

Work through this list top to bottom after merging the pipeline PR.

## 1. General

- [ ] **Default branch** is `main` (Settings → General).
- [ ] **Automatically delete head branches** after merge: enabled
      (Settings → General → Pull Requests).

## 2. Actions token hardening

Settings → Actions → General:

- [ ] **Workflow permissions**: "Read repository contents and packages
      permissions" (read-only default `GITHUB_TOKEN`). The workflows in
      this repo declare the few write permissions they need per job.
- [ ] "Allow GitHub Actions to create and approve pull requests":
      **disabled**.

## 3. Branch protection for `main`

Settings → Branches (or a Ruleset targeting `main`) — require:

- [ ] Pull request before merging, **at least 1 approval**.
- [ ] **Dismiss stale approvals** when new commits are pushed.
- [ ] **Require conversation resolution** before merging.
- [ ] **Status checks must pass**: add the CI check **`test`**
      (from `.github/workflows/ci.yml`; it must have run at least once
      to be selectable).
- [ ] **Require branches to be up to date** before merging.
- [ ] **Block force pushes**.
- [ ] **Block deletions** of the branch.
- [ ] Apply the rules to administrators too ("Do not allow bypassing the
      above settings"), unless the org needs a break-glass path.

## 4. Tag protection

- [ ] Add a ruleset for tags matching `v*`: restrict creation to
      maintainers and block deletion/updates, so release tags are
      immutable and only maintainers can trigger the release pipeline.

## 5. `release` environment (required for releases)

Settings → Environments → New environment: **`release`**

- [ ] **Required reviewers**: at least one maintainer (signing and
      publishing jobs then pause for human approval).
- [ ] Deployment branches and tags: allow only `main` and tags matching
      `v*`.
- [ ] Add the environment **secrets** listed in
      [docs/RELEASING.md](RELEASING.md#9-required-github-secrets):
      `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`,
      `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `WIN_CSC_LINK`,
      `WIN_CSC_KEY_PASSWORD`.
      Do **not** create these as repository-level secrets.

## 6. Releases

- [ ] Enable **immutable releases** if available on the plan/UI
      (Settings → General → Releases): published release assets and tags
      then cannot be silently altered — this matches the pipeline's
      "never overwrite a published release" rule.

## 7. Security features

Settings → Security:

- [ ] Enable **Private vulnerability reporting** (SECURITY.md points
      reporters at it).
- [ ] Enable **Dependency graph**, **Dependabot alerts**, and
      **Dependabot security updates** (version updates are already
      configured in `.github/dependabot.yml`).
- [ ] Optional: enable **Secret scanning** and **Push protection**.

## 8. Verification after configuring

- [ ] Open a trivial PR from a fork: CI runs without any secrets, and
      merging is blocked until `test` passes and a review is present.
- [ ] Run *Actions → Release → Run workflow* (dry run): the mac/win jobs
      pause for `release` environment approval, then fail closed with a
      clear message listing any missing signing secrets — or build,
      sign, notarize, and verify end-to-end once the secrets are in
      place. Nothing is published in dry-run mode.
