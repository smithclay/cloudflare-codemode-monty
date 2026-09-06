# Releasing

Releases are built and published only by [`.github/workflows/publish.yml`](../.github/workflows/publish.yml). The workflow accepts a `v<package-version>` tag, re-runs all Node and Worker checks, and publishes through npm trusted publishing with provenance. It has no npm token.

## One-time repository setup

1. Install the GitHub Renovate App and grant it access to this repository. The included [configuration](../renovate.json) uses Renovate's maintained best-practices preset, including action SHA pinning, pinned development tools, a three-day npm release-age guard, and weekly lockfile maintenance. Only aged npm patch updates are merged automatically after CI passes.
2. On npmjs.com, add a trusted publisher for `smithclay/cloudflare-codemode-monty`: GitHub Actions, owner `smithclay`, repository `cloudflare-codemode-monty`, workflow `publish.yml`, environment `npm`, with direct `npm publish` allowed. Then remove or restrict all traditional publish tokens.
3. In GitHub, create the `npm` environment and require a reviewer. Protect `main` so the `check` and `worker integration` jobs must pass, disallow direct pushes, and require an up-to-date branch before merge. Add a `v*` tag ruleset that only maintainers can create or update. Enable immutable releases and GitHub's default CodeQL setup for this public TypeScript repository.

## Release

After the version change has landed on `main` and CI is green:

```bash
git tag v0.0.2
git push origin v0.0.2
```

Approve the protected `npm` environment when GitHub requests it. The workflow refuses a tag that does not exactly equal `v` plus the version in `package.json`.

Do not run the production Worker smoke test in this workflow: it creates a public temporary deployment and is intentionally an explicit, separately authorized check.
