# Contributing

Thanks for your interest in improving the Ngram n8n community node.

This repository is the public mirror for the standalone npm package. The source
of truth lives in the Ngram monorepo under `apps/n8n/`, so maintainers may
cherry-pick or replay accepted changes upstream before they appear here.

## Development

Use Node.js 24 when developing or validating this package.

```bash
npm install
npm run typecheck
npm run build
npm run test
npm run lint
```

Before opening a pull request, run the checks above and include the results in
the PR description. If your change affects package contents, also run:

```bash
npm pack --dry-run
```

## Pull Requests

- Keep changes focused on the n8n node package.
- Add or update tests for behavior changes.
- Do not commit `node_modules/`, `dist/`, or generated tarballs.
- Explain any user-facing behavior change in the README when relevant.

## Issues

Please include:

- The n8n version and Node.js version you are using.
- Whether you are using n8n Cloud, self-hosted Docker, or another setup.
- Steps to reproduce the issue.
- Any relevant error output with secrets removed.
