# Publishing

pi-memctx is published to npm and can also be installed directly from GitHub with Pi:

```bash
pi install npm:pi-memctx
pi install git:github.com/weauratech/pi-memctx
```

## Release workflow

Releases are tag-driven. Pushing a tag like `v0.3.0` runs `.github/workflows/release.yml`, which:

1. validates that the tag version matches `package.json`;
2. installs dependencies with `npm install --omit=optional --omit=peer --ignore-scripts --no-audit --no-fund --package-lock=false`;
3. runs `npm run ci`;
4. extracts release notes from `CHANGELOG.md`;
5. runs `npm pack --json`;
6. generates a SHA-256 checksum for the tarball;
7. publishes the tarball to npm when `NPM_TOKEN` is configured;
8. publishes a scoped mirror to GitHub Packages as `@weauratech/pi-memctx` using `GITHUB_TOKEN`;
9. creates or updates the GitHub Release and uploads the tarball plus checksum.

The publish steps are idempotent: if the version already exists on a registry, publishing to that registry is skipped. If `NPM_TOKEN` is not configured, the workflow still publishes the GitHub Packages mirror and creates/updates the GitHub Release; rerun it after adding the secret to publish to npmjs.com.

## Required secret

Configure this GitHub Actions secret before publishing to npm:

```txt
NPM_TOKEN
```

The workflow also requests `id-token: write` so the project can migrate to npm Trusted Publishing later.

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
4. Update `CHANGELOG.md` with a section matching the release version, for example `## [0.3.0] - YYYY-MM-DD`.
5. Update `package.json` and `package-lock.json` to the same version.
6. Merge the release commit to `main`.
7. Create and push the tag:

```bash
git checkout main
git pull
git tag v0.3.0
git push origin v0.3.0
```

## Versioning

Use semantic versioning where practical:

- patch: compatible fixes;
- minor: compatible features;
- major: breaking behavior or migration required.
