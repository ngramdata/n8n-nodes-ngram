# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-10-06

0.2.0 was not published separately; its changes ship in this release.

### Added

- Add the `Model` field (`director_model`). It lists the models available to
  your account with each one's live rate in credits per second; leave it empty
  to use the account's default model.
- Add `Mood`, `Narration Language` (`voice_language`), and `Brand Kit`
  (`brand_kit`) fields, loaded from your ngram account.
- `Get Status` now returns `app_url` (a link that opens the video in ngram)
  and `warnings` (inputs ngram ignored or adjusted, one per line).

### Changed

- `Duration` accepts any length of at least 1 second through an expression,
  or Auto when left empty.
- `Energy` is now a dropdown loaded from your ngram account, and `Style` and
  `Voice` describe their choices.
- Creating videos through the API needs a paid ngram plan. The create
  operations now show ngram's own error message, such as the paid-plan
  requirement or the rejected field, instead of n8n's generic HTTP status text.
- The `On Video Ready` / `On Video Failed` triggers keep cleaning up leftover
  webhook subscriptions when one cleanup request fails.
- Write the brand as ngram in the node and trigger names, field descriptions,
  error messages, and starter templates. The credential stays `Ngram API`
  because n8n requires credential names in title case. Saved workflows are
  unaffected: node and credential types are unchanged.

### Removed

- Remove the `Animation Mode`, `Scenario`, `Video Type Profile`, `Story Flow`,
  and `Deep Research` fields. Model choice replaces the Lite/Pro mode, and Lite
  is retired; the node has no Mode setting. Saved workflows that set a removed
  field keep running; the node no longer sends it.
- Starter templates no longer set `scenario` or `deep_research`.

## [0.1.7] - 2026-07-30

### Added

- Add the `Video Format` field for selecting the regular Studio-equivalent
  workflow or an explicit silent, 15-second Hybrid short video.
- Add top-level `Image URLs` input so public images are processed as uploaded
  assets.

### Changed

- Remove the legacy `Video Mode` (`video_mode`) field, including the obsolete
  `teaser` option.
- Leave optional creation settings unset by default so the Ngram API applies
  the same regular Video, 60-second, Hybrid defaults as Studio.

## [0.1.6] - 2026-07-16

### Changed

- Point the `Ngram API` credential's documentation link at the dedicated n8n
  setup guide instead of the generic public API reference.
- Refresh README to lead with verified status and cross-link the n8n.io
  listing, the setup guide, and the self-hosted/Cloud value proposition.

## [0.1.5] - 2026-07-13

### Changed

- Polish npm package metadata for the verified n8n integration listing.
- Improve in-editor node descriptions and operation labels.
- Refresh README installation, usage, and workflow automation guidance.

### Added

- Add Google Sheets, RSS, Gmail, Airtable, Twilio, HubSpot, and GitHub starter workflow templates.

## [0.1.4] - 2026-05-27

### Changed

- Route package author and maintainer contact metadata to eng@ngram.com.

## [0.1.3] - 2026-05-27

### Changed

- Publish from the standalone repository with npm provenance.
- Align n8n node metadata with the current community-node scanner.
- Store package author metadata without angle-bracket placeholder syntax.

## [0.1.2] - 2026-05-26

### Changed

- Prepare the public mirror repository for the n8n community node package.
- Add public contribution, conduct, packaging, and CI metadata.

## [0.1.1] - 2026-05-26

### Changed

- Align package publishing with the current n8n Node.js runtime requirements.

## [0.1.0] - 2026-05-26

### Added

- Add the initial Ngram action node for creating videos and checking video status.
- Add trigger nodes for completed and failed video webhook events.
- Add webhook subscription reconciliation and cleanup behavior.
- Add a ready-to-import notification workflow template.
