# Contributing

Thanks for your interest in improving the ngram n8n community node.

## Source of truth

This repository is the source of truth for the ngram n8n node; the ngram
monorepo no longer contains it.

- Change the node with a pull request to this repository.
- Merging to `main` with a version bump in `package.json` publishes the new
  version to npm under the `latest` tag through
  `.github/workflows/publish.yml`, using npm trusted publishing. A merge that
  does not change the version publishes nothing.
- When ngram's public API changes in a way that affects the node, the node
  needs a matching pull request here.

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

## Internal workflow checks

After building, run `pnpm test:engine <report-directory>` with Docker running.
The report directory must be on a filesystem Docker can mount. The check uses a
pinned official n8n image, imports all eight starters inactive, and executes the
current node against a simulated API on a temporary internal Docker network.
It checks text/URL creation, status handling, rejected inputs, the merged-PR
condition and repeated-event keys. It uses no production credentials or cloud
workspace and sends no notifications or social posts. Temporary containers,
database volume and network are removed at the end; logs stay in the report
directory.

This proves the import and automation logic. It does not prove live video
creation, third-party authorization or delivery to an external destination.
