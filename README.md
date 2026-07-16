# n8n-nodes-ngram

![n8n.io - Verified Community Node](https://img.shields.io/badge/n8n-verified-FF6D5A)
[![npm version](https://img.shields.io/npm/v/n8n-nodes-ngram.svg)](https://www.npmjs.com/package/n8n-nodes-ngram)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Official [Ngram](https://www.ngram.com) community node for [n8n](https://n8n.io),
**verified by n8n**. Generate polished AI videos from prompts, text, URLs,
docs, and product content, then automate follow-up workflows the instant a
render is ready or fails — no polling, HMAC-signed callbacks, self-hosted or
n8n Cloud.

This is a [verified n8n community node](https://n8n.io/integrations/ngram/).
It lets you use Ngram in your n8n workflows.

## Features

- **Action - Create Video**: start an Ngram video render with optional brand context.
- **Action - Create From Text**: turn a prompt or source text into a video.
- **Action - Create From URL**: research a page, article, product page, or doc and create a video.
- **Action - Get Status**: check a submitted job by id.
- **Trigger - On Video Ready**: instant `video.completed` webhook — no polling loop needed.
- **Trigger - On Video Failed**: instant `video.failed` webhook, with error code and message.
- **Signed and reconciled**: every webhook is HMAC-SHA256 signed, and subscriptions are
  auto-reconciled on activate/deactivate so redeploys never leak orphan hooks.

## Installation

Follow the [n8n verified community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes/).

### n8n Cloud

1. Open the **nodes panel** from the canvas.
2. Search for **Ngram**.
3. Select the verified community node and install it for your instance.
4. Add your **Ngram API** credential before running workflows.

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
| `Create From Text` | `prompt` | Job descriptor including `id` and status |
| `Create From URL` | `website_url` | Job descriptor including `id` and status |
| `Get Status` | `id` returned by a create operation | Current status and output URLs when ready |

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

Ready-to-use workflow templates are included in [`templates`](./templates):

- [`notify-on-video-ready.json`](./templates/notify-on-video-ready.json):
  post to Slack when any Ngram video finishes rendering.
- [`create-video-from-google-sheets-row.json`](./templates/create-video-from-google-sheets-row.json):
  generate a video from new Google Sheets rows.
- [`create-video-from-rss-item.json`](./templates/create-video-from-rss-item.json):
  turn new RSS feed items into videos.
- [`email-on-video-ready.json`](./templates/email-on-video-ready.json):
  email a stakeholder when a video is ready.
- [`save-video-to-airtable.json`](./templates/save-video-to-airtable.json):
  archive completed video metadata in Airtable.
- [`sms-on-video-failed.json`](./templates/sms-on-video-failed.json):
  send an SMS alert when a render fails.
- [`create-video-from-hubspot-contact.json`](./templates/create-video-from-hubspot-contact.json):
  create personalized intro videos for new HubSpot contacts.
- [`changelog-video-from-github-merged-pr.json`](./templates/changelog-video-from-github-merged-pr.json):
  turn merged GitHub pull requests into changelog videos.

Import a template with **Workflow menu > Import from file**, replace credential
references and app-specific settings, then activate the workflow.

## What You Can Automate

- Turn product launch rows, changelog entries, or campaign briefs into videos.
- Create short videos from blog posts, RSS feed items, landing pages, or docs.
- Generate on-brand updates for Slack, social scheduling, CRM, and marketing ops.
- Poll render status or trigger downstream workflows when videos are ready.
- Alert your team when a render fails so the workflow can recover quickly.

Because the node runs inside your own n8n instance — self-hosted or n8n
Cloud — there's no separate vendor hop for the workflow runner: renders run
against Ngram, everything else stays in your workflow.

The Slack notification template uses only the **On Video Ready** trigger.
Ngram's public API does not currently expose a per-workflow correlation id, so a
template that chains `Create Video` with the trigger would fire for every video
on the account. For a correlated create-and-wait flow, chain `Create Video` with
a `Wait` node followed by a `Get Status` loop.

## Resources

- [Ngram n8n setup guide](https://www.ngram.com/docs/n8n)
- [Ngram documentation](https://www.ngram.com/docs)
- [Ngram public API reference](https://www.ngram.com/docs/api)
- [Verified listing on n8n.io](https://n8n.io/integrations/ngram/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)
- [n8n community node verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines/)

## Contributing

This package is source-mirrored from the Ngram monorepo, where primary
development happens. Pull requests and issues filed here are welcome and will be
reviewed for upstream inclusion.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License

[MIT](./LICENSE) - Copyright (c) 2026 Ngram.
