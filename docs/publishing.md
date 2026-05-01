# Publishing

pi-memctx is published to npm and can also be installed directly from GitHub with Pi:

```bash
pi install npm:pi-memctx
pi install git:github.com/weauratech/pi-memctx
```

## Release workflow

Releases are generated automatically when a pull request is merged to `main` with a release branch prefix:

- `feat/...` or `feature/...` creates a minor release;
- `fix/...`, `bugfix/...`, or `hotfix/...` creates a patch release;
- other branch prefixes run no release.

The merge to `main` runs `.github/workflows/release.yml`, which:

1. detects the merged pull request branch;
2. bumps `package.json` and `package-lock.json` with `npm version --no-git-tag-version`;
3. moves the `CHANGELOG.md` `Unreleased` notes into the new version section, or creates a release note from the merged PR;
4. commits the release bump back to `main` and pushes the matching `vX.Y.Z` tag;
5. installs dependencies deterministically with `npm ci --omit=optional --omit=peer --ignore-scripts --no-audit --no-fund`;
6. runs `npm run ci`;
7. extracts release notes from `CHANGELOG.md`;
8. runs `npm pack --json` and generates a SHA-256 checksum for the tarball;
9. publishes the tarball to npmjs.com with npm Trusted Publishing and provenance;
10. publishes a scoped mirror to GitHub Packages as `@weauratech/pi-memctx` using `GITHUB_TOKEN`;
11. creates or updates the GitHub Release and uploads the tarball plus checksum.

The workflow can also be run manually with a `vX.Y.Z` tag when the tag version already matches `package.json`. The publish steps are idempotent: if the version already exists on a registry, publishing to that registry is skipped.

## npm Trusted Publishing

Publishing to npmjs.com uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) instead of a long-lived npm automation token. Do not configure or use an `NPM_TOKEN` secret for npmjs.com publishing.

Before the first trusted publish, configure the `pi-memctx` package on npmjs.com with a GitHub Actions trusted publisher:

```txt
Repository owner: weauratech
Repository name: pi-memctx
Workflow file: release.yml
Environment: npm
```

The release workflow requests `id-token: write` and runs `npm publish --provenance --access public`, which lets npm exchange the GitHub Actions OIDC identity for a short-lived publish credential.

## GitHub Packages mirror

The release workflow also publishes a GitHub Packages mirror under the organization scope:

```txt
@weauratech/pi-memctx
```

The repository package name remains `pi-memctx` for npmjs.com. During release, the workflow extracts the generated npm tarball into a temporary directory, rewrites only the temporary `package.json` name to `@weauratech/pi-memctx`, and publishes that scoped package to `https://npm.pkg.github.com`.

To install the GitHub Packages mirror, configure npm for the scope and authenticate with a GitHub token that can read packages:

```bash
npm config set @weauratech:registry https://npm.pkg.github.com
pi install npm:@weauratech/pi-memctx
```

For most public users, npmjs.com remains the recommended registry:

```bash
pi install npm:pi-memctx
```

## Before publishing a release

1. Run `npm run ci`.
2. Run `npm pack --dry-run --json` and inspect included files.
3. Review `SECURITY.md` and ensure no sensitive data was committed.
4. Add user-facing release notes under `## [Unreleased]` in `CHANGELOG.md`.
5. Open the PR from a release branch prefix:
   - `feat/...` for a minor release;
   - `fix/...` for a patch release.
6. Merge the PR to `main` with a merge commit so the release workflow can identify the source branch.

## Versioning

Use semantic versioning where practical:

- patch: compatible fixes;
- minor: compatible features;
- major: breaking behavior or migration required.
