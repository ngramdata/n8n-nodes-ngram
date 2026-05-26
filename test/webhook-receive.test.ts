import { describe, expect, it, vi } from 'vitest';
import type { IWebhookFunctions } from 'n8n-workflow';
import { webhookReceive } from '../src/trigger/subscriptionLifecycle';

function buildWebhookCtx(body: unknown) {
	const getBodyData = vi.fn(() => body);
	return { getBodyData } as unknown as IWebhookFunctions;
}

describe('webhookReceive', () => {
	it('flattens a video.completed payload to the Zapier-parity shape and preserves the raw body', async () => {
		const payload = {
			event: 'video.completed',
			video_id: 'vid_abc',
			result: { url: 'https://cdn.example.com/video.mp4', duration_ms: 60000 },
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:01:00.000Z',
		};
		const ctx = buildWebhookCtx(payload);

		const response = await webhookReceive.call(ctx);

		expect(response.workflowData?.[0]?.[0]?.json).toMatchObject({
			id: 'vid_abc',
			status: 'completed',
			progress: 100,
			video_url: 'https://cdn.example.com/video.mp4',
			duration_ms: 60000,
			error_code: null,
			error_message: null,
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:01:00.000Z',
			_raw: payload,
		});
	});

	it('flattens a video.failed payload', async () => {
		const payload = {
			event: 'video.failed',
			video_id: 'vid_xyz',
			error_code: 'credits_exhausted',
			error: 'User has run out of credits',
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:00:10.000Z',
		};
		const ctx = buildWebhookCtx(payload);

		const response = await webhookReceive.call(ctx);

		expect(response.workflowData?.[0]?.[0]?.json).toMatchObject({
			id: 'vid_xyz',
			status: 'failed',
			progress: 0,
			video_url: null,
			duration_ms: null,
			error_code: 'credits_exhausted',
			error_message: 'User has run out of credits',
		});
	});

	it('passes through an unrecognised body verbatim so a debugging receiver still sees something', async () => {
		const body = { unexpected: 'shape' };
		const ctx = buildWebhookCtx(body);

		const response = await webhookReceive.call(ctx);

		expect(response.workflowData?.[0]?.[0]?.json).toEqual(body);
	});

	it('does not crash when a spoofed video.completed payload omits required fields', async () => {
		// Adversarial: right `event` header, missing everything else.
		// webhookReceive must NOT throw — the mapper would, but the type guard
		// keeps this from ever reaching the mapper.
		const malformed = { event: 'video.completed' };
		const ctx = buildWebhookCtx(malformed);

		const response = await webhookReceive.call(ctx);

		expect(response.workflowData?.[0]?.[0]?.json).toEqual(malformed);
	});

	it('does not crash when a video.completed payload has event + video_id but an invalid result', async () => {
		const malformed = {
			event: 'video.completed',
			video_id: 'vid_abc',
			created_at: '2026-04-24T00:00:00.000Z',
			result: { url: 123 }, // wrong type
		};
		const ctx = buildWebhookCtx(malformed);

		const response = await webhookReceive.call(ctx);

		expect(response.workflowData?.[0]?.[0]?.json).toEqual(malformed);
	});
});
