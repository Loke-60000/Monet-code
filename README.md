# Monet

Monet is a tool letting you easily use and manage any LLM provider on Claude Code

## Install

After the package is published to npm, install it globally with:

```bash
npm install -g monet-code
```

## Local env

Monet loads a local `.env` file automatically on startup.

Published packages can include bundled Antigravity OAuth defaults.

If you want to override them locally, set:

- `MONET_ANTIGRAVITY_CLIENT_ID`
- `MONET_ANTIGRAVITY_CLIENT_SECRET`

## Release workflow

The repository includes a GitHub Actions workflow at `.github/workflows/publish.yml`.

It:

1. Optionally writes a CI-only `.env` file from the `MONET_ENV_FILE` GitHub secret.
2. Runs `npm ci`, `npm test`, and `npm run build`.
3. Verifies the package contents with `npm pack --dry-run`.
4. Publishes the package to npm.

Required GitHub secrets:

- `NPM_TOKEN`: npm publish token.
- `MONET_ENV_FILE`: optional full contents of a `.env` file for CI builds.

Publish options:

- Create and push a tag like `v0.1.0` to publish automatically.
- Or run the `Publish Package` workflow manually from GitHub Actions.
