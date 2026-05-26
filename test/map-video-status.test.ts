import { describe, expect, it } from 'vitest';
import {
	isCompletedWebhookPayload,
	isFailedWebhookPayload,
	mapStatusResponse,
	mapWebhookPayload,
	type WebhookPayloadShape,
} from '../src/output/mapVideoStatus';

describe('mapStatusResponse', () => {
	it('flattens a completed /videos/:id response to Zapier-parity fields', () => {
		const response = {
			id: 'vid_abc',
			status: 'completed' as const,
			progress: 100,
			result: { url: 'https://cdn.example.com/video.mp4', duration_ms: 60000 },
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:01:00.000Z',
		};

		expect(mapStatusResponse(response)).toEqual({
			id: 'vid_abc',
			status: 'completed',
			progress: 100,
			video_url: 'https://cdn.example.com/video.mp4',
			duration_ms: 60000,
			error_code: null,
			error_message: null,
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:01:00.000Z',
		});
	});

	it('renames top-level `error` to `error_message` for failed jobs', () => {
		const response = {
			id: 'vid_fail',
			status: 'failed' as const,
			progress: 0,
			error_code: 'credits_exhausted',
			error: 'User has run out of credits',
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:00:10.000Z',
		};

		const output = mapStatusResponse(response);
		expect(output.error_code).toBe('credits_exhausted');
		expect(output.error_message).toBe('User has run out of credits');
		expect(output.video_url).toBeNull();
		expect(output.duration_ms).toBeNull();
	});

	it('preserves progress and null-fills optional fields for processing jobs', () => {
		const response = {
			id: 'vid_processing',
			status: 'processing' as const,
			progress: 42,
			created_at: '2026-04-24T00:00:00.000Z',
		};

		expect(mapStatusResponse(response)).toEqual({
			id: 'vid_processing',
			status: 'processing',
			progress: 42,
			video_url: null,
			duration_ms: null,
			error_code: null,
			error_message: null,
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: null,
		});
	});
});

describe('mapWebhookPayload', () => {
	it('produces the same flat output shape as mapStatusResponse for completed events', () => {
		const payload: WebhookPayloadShape = {
			event: 'video.completed',
			video_id: 'vid_abc',
			result: { url: 'https://cdn.example.com/video.mp4', duration_ms: 60000 },
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:01:00.000Z',
		};

		expect(mapWebhookPayload(payload)).toEqual({
			id: 'vid_abc',
			status: 'completed',
			progress: 100,
			video_url: 'https://cdn.example.com/video.mp4',
			duration_ms: 60000,
			error_code: null,
			error_message: null,
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: '2026-04-24T00:01:00.000Z',
		});
	});

	it('rejects malformed completed payloads via isCompletedWebhookPayload', () => {
		// Each of these must fail the guard so webhookReceive never calls the
		// mapper with them — the mapper would throw on a missing `result`.
		expect(isCompletedWebhookPayload(null)).toBe(false);
		expect(isCompletedWebhookPayload({ event: 'video.completed' })).toBe(false);
		expect(
			isCompletedWebhookPayload({ event: 'video.completed', video_id: 'vid_abc' }),
		).toBe(false);
		expect(
			isCompletedWebhookPayload({
				event: 'video.completed',
				video_id: 'vid_abc',
				created_at: '2026-04-24T00:00:00.000Z',
				// missing result
			}),
		).toBe(false);
		expect(
			isCompletedWebhookPayload({
				event: 'video.completed',
				video_id: 'vid_abc',
				created_at: '2026-04-24T00:00:00.000Z',
				result: { url: 'https://ok', duration_ms: 'not-a-number' },
			}),
		).toBe(false);
		expect(
			isCompletedWebhookPayload({
				event: 'video.completed',
				video_id: 'vid_abc',
				created_at: '2026-04-24T00:00:00.000Z',
				result: { url: 'https://cdn.example.com/v.mp4', duration_ms: 1000 },
			}),
		).toBe(true);
		// Wrong event keyword must still fail, even with a valid result.
		expect(
			isCompletedWebhookPayload({
				event: 'video.failed',
				video_id: 'vid_abc',
				created_at: '2026-04-24T00:00:00.000Z',
				result: { url: 'https://cdn.example.com/v.mp4', duration_ms: 1000 },
			}),
		).toBe(false);
	});

	it('rejects malformed failed payloads via isFailedWebhookPayload', () => {
		expect(isFailedWebhookPayload({ event: 'video.failed' })).toBe(false);
		expect(isFailedWebhookPayload({ event: 'video.failed', video_id: 123 })).toBe(false);
		expect(
			isFailedWebhookPayload({
				event: 'video.failed',
				video_id: 'vid_fail',
				created_at: '2026-04-24T00:00:00.000Z',
			}),
		).toBe(true);
	});

	it('falls back to "unknown" + canned message when the failed payload is sparse', () => {
		const payload: WebhookPayloadShape = {
			event: 'video.failed',
			video_id: 'vid_fail',
			created_at: '2026-04-24T00:00:00.000Z',
		};

		expect(mapWebhookPayload(payload)).toEqual({
			id: 'vid_fail',
			status: 'failed',
			progress: 0,
			video_url: null,
			duration_ms: null,
			error_code: 'unknown',
			error_message: 'Video generation failed',
			created_at: '2026-04-24T00:00:00.000Z',
			completed_at: null,
		});
	});
});
