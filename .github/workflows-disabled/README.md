# Workflows disabled

The repository's GitHub Actions setting is disabled (`enabled: false`), and its workflow definition is kept outside GitHub Actions' recognized `.github/workflows` directory. No repository workflow runs on pushes, pull requests, or manual dispatch while this setting remains disabled.

Run verification locally from the repository root:

```powershell
pnpm check
pnpm catalog:validate
pnpm exec prettier --check .
pnpm test:e2e
```

`pnpm check` runs workspace typechecks, tests, and configured builds. Browser tests require the documented local database/services and Playwright browser installation. Container image builds remain local Docker commands. Keep test evidence in the relevant phase implementation document. Restoring automation requires an explicit repository-owner decision to enable Actions in repository settings and move a workflow file back into `.github/workflows`.
