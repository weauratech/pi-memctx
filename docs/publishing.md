# Publishing

This project is installable directly from GitHub with Pi:

```bash
pi install git:github.com/weauratech/pi-memctx
```

Before publishing a release:

1. Run `npm run ci`.
2. Review `SECURITY.md` and ensure no sensitive data was committed.
3. Update `CHANGELOG.md`.
4. Create a version tag, for example `v0.1.1`.
5. Publish GitHub release notes from the changelog.

Use semantic versioning where practical:

- patch: compatible fixes;
- minor: compatible features;
- major: breaking behavior or migration required.
