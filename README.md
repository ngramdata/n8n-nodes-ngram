# n8n-nodes-ngram

![n8n.io - Community Node](https://img.shields.io/badge/n8n-community-FF6D5A)
[![npm version](https://img.shields.io/npm/v/n8n-nodes-ngram.svg)](https://www.npmjs.com/package/n8n-nodes-ngram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Official [Ngram](https://www.ngram.com) community node for [n8n](https://n8n.io).
Generate AI videos, look up their status, and react to completion events from
n8n workflows.

This is an [n8n community node](https://docs.n8n.io/integrations/community-nodes/).
It lets you use Ngram in your n8n workflows.

## Features

- **Action - Create Video**: start an Ngram video render from any workflow.
- **Action - Get Status**: check a submitted job by id.
- **Trigger - On Video Ready**: receive `video.completed` webhook events.
- **Trigger - On Video Failed**: receive `video.failed` webhook events.

## Installation

Follow the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

### Self-hosted n8n

1. Open **Settings > Community nodes > Install**.
2. Enter `n8n-nodes-ngram` and confirm.
3. Restart n8n. The Ngram nodes appear in the node picker.

### Docker or CLI

```bash
docker exec -u node <your-n8n-container> sh -c "
  cd /home/node/.n8n/nodes
  npm install n8n-nodes-ngram
"
docker restart <your-n8n-container>
```

If the package is still on the `beta` dist-tag, install
`n8n-nodes-ngram@beta` instead.

### n8n Cloud

n8n Cloud support is available after the node is verified through the
[n8n Creator Portal](https://creators.n8n.io). Until verification is complete,
Cloud users can use the [Make](https://www.ngram.com/docs/integrations/make)
or [Zapier](https://www.ngram.com/docs/integrations/zapier) integrations.

## Credentials

1. Generate an API key at
   [ngram.com/app/settings/api-keys](https://www.ngram.com/app/settings/api-keys).
   The key starts with `ngs_`.
2. In n8n, create a new **Ngram API** credential and paste the key.
3. Leave **Base URL** as `https://www.ngram.com` for production. Override it
   only for staging or preview environments.

Use the credential **Test** button to verify access. It calls
`GET /api/v1/account`.

## Operations

### Ngram node

| Operation | Required inputs | Returns |
| --- | --- | --- |
| `Create Video` | `prompt` | Job descriptor including `id` and status |
| `Get Status` | `id` returned by `Create Video` | Current status and output URLs when ready |

### Trigger nodes

| Trigger | Event subscribed | Payload |
| --- | --- | --- |
| `Ngram: On Video Ready` | `video.completed` | Video metadata and signed download URLs |
| `Ngram: On Video Failed` | `video.failed` | Job id and failure reason |

## Trigger Behavior

The trigger nodes register a webhook subscription with the Ngram API when
activated and delete it when deactivated. On re-activation, they query
`GET /api/v1/webhooks/subscriptions` and reuse any matching subscription
instead of creating a duplicate.

When a trigger is deleted, it also sweeps residual orphan subscriptions for the
same `(event_type, target_url)` pair.

## HMAC Signature Verification

Webhook payloads are HMAC-signed with `X-Ngram-Signature` and
`X-Ngram-Timestamp` headers.

This version of the node does not surface the signing secret for inline
verification inside n8n. The secret is returned only at subscription creation
time and is not exposed by the list endpoint. If you need signature
verification, chain an `HTTP Request` or `Function` node downstream and validate
the headers against your stored secret.

## Compatibility

- n8n: `>= 1.82.0`
- Node.js: `>= 24`

## Usage

A ready-to-use workflow is included at
[`templates/notify-on-video-ready.json`](./templates/notify-on-video-ready.json).
Import it with **Workflow menu > Import from file**, replace the credential
reference and Slack channel, then activate the workflow.

The template uses only the **On Video Ready** trigger. Ngram's public API does
not currently expose a per-workflow correlation id, so a template that chains
`Create Video` with the trigger would fire for every video on the account. For a
correlated create-and-wait flow, chain `Create Video` with a `Wait` node followed
by a `Get Status` loop.

## Resources

- [Ngram documentation](https://www.ngram.com/docs)
- [Ngram public API reference](https://www.ngram.com/docs/api)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [n8n community node verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/)

## Contributing

This package is source-mirrored from the Ngram monorepo, where primary
development happens. Pull requests and issues filed here are welcome and will be
reviewed for upstream inclusion.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

[MIT](./LICENSE) - Copyright (c) 2026 Ngram.
