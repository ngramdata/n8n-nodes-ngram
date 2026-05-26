import { beforeEach, describe, expect, it } from 'vitest';
import { buildWebhookMethods } from '../src/trigger/subscriptionLifecycle';
import {
	buildCreateResponse,
	buildHookContext,
	buildListResponse,
} from './helpers/mock-context';

const TARGET = 'https://n8n.example.com/webhook/abc';

describe('trigger webhookMethods.default.checkExists', () => {
	const methods = buildWebhookMethods('video.completed');

	beforeEach(() => {
		// each test builds its own context
	});

	it('returns true and stores the match id when a matching subscription exists', async () => {
		const { ctx, calls, staticData } = buildHookContext({
			webhookUrl: TARGET,
			responses: [
				buildListResponse([
					{ id: 'sub_old', event_type: 'video.failed', target_url: TARGET },
					{ id: 'sub_match', event_type: 'video.completed', target_url: TARGET },
					{ id: 'sub_other', event_type: 'video.completed', target_url: 'https://other.example.com/x' },
				]),
			],
		});

		const result = await methods.default.checkExists.call(ctx);

		expect(result).toBe(true);
		expect(staticData.subscriptionId).toBe('sub_match');
		expect(calls).toEqual([
			{ method: 'GET', url: 'https://www.ngram.com/api/v1/webhooks/subscriptions', body: undefined },
		]);
	});

	it('clears any stale subscriptionSecret when reusing a matched subscription', async () => {
		// The list endpoint does not return `secret`, so a cached secret from a
		// prior (potentially orphaned) subscription must not be trusted.
		const { ctx, staticData } = buildHookContext({
			webhookUrl: TARGET,
			staticData: {
				subscriptionId: 'sub_different',
				subscriptionSecret: 'secret-for-different-sub',
			},
			responses: [
				buildListResponse([
					{ id: 'sub_match', event_type: 'video.completed', target_url: TARGET },
				]),
			],
		});

		const result = await methods.default.checkExists.call(ctx);

		expect(result).toBe(true);
		expect(staticData.subscriptionId).toBe('sub_match');
		expect(staticData.subscriptionSecret).toBeUndefined();
	});

	it('returns false and clears stored ids when no match is found', async () => {
		const { ctx, staticData } = buildHookContext({
			webhookUrl: TARGET,
			staticData: { subscriptionId: 'sub_stale', subscriptionSecret: 'old' },
			responses: [
				buildListResponse([
					{ id: 'sub_mismatch', event_type: 'video.failed', target_url: TARGET },
				]),
			],
		});

		const result = await methods.default.checkExists.call(ctx);

		expect(result).toBe(false);
		expect(staticData.subscriptionId).toBeUndefined();
		expect(staticData.subscriptionSecret).toBeUndefined();
	});
});

describe('trigger webhookMethods.default.create', () => {
	const methods = buildWebhookMethods('video.completed');

	it('POSTs a new subscription and stores the returned id + secret', async () => {
		const { ctx, calls, staticData } = buildHookContext({
			webhookUrl: TARGET,
			responses: [
				buildCreateResponse({
					id: 'sub_new',
					event_type: 'video.completed',
					target_url: TARGET,
					secret: 'secret-xyz',
				}),
			],
		});

		const result = await methods.default.create.call(ctx);

		expect(result).toBe(true);
		expect(staticData.subscriptionId).toBe('sub_new');
		expect(staticData.subscriptionSecret).toBe('secret-xyz');
		expect(calls).toEqual([
			{
				method: 'POST',
				url: 'https://www.ngram.com/api/v1/webhooks/subscriptions',
				body: {
					event_type: 'video.completed',
					target_url: TARGET,
				},
			},
		]);
	});

	it('sends video.failed for the failed-event trigger', async () => {
		const failedMethods = buildWebhookMethods('video.failed');
		const { ctx, calls } = buildHookContext({
			webhookUrl: TARGET,
			responses: [
				buildCreateResponse({ id: 'sub_fail', event_type: 'video.failed', target_url: TARGET }),
			],
		});

		await failedMethods.default.create.call(ctx);

		expect(calls[0]?.body).toMatchObject({ event_type: 'video.failed' });
	});
});

describe('trigger webhookMethods.default.delete', () => {
	const methods = buildWebhookMethods('video.completed');

	it('deletes the stored subscription id and clears static data', async () => {
		const { ctx, calls, staticData } = buildHookContext({
			webhookUrl: TARGET,
			staticData: { subscriptionId: 'sub_stored', subscriptionSecret: 'secret' },
			responses: [
				{ success: true, data: { id: 'sub_stored', deleted: true } },
				buildListResponse([]), // orphan sweep finds nothing
			],
		});

		const result = await methods.default.delete.call(ctx);

		expect(result).toBe(true);
		expect(staticData.subscriptionId).toBeUndefined();
		expect(staticData.subscriptionSecret).toBeUndefined();
		expect(calls).toEqual([
			{
				method: 'DELETE',
				url: 'https://www.ngram.com/api/v1/webhooks/subscriptions/sub_stored',
				body: undefined,
			},
			{
				method: 'GET',
				url: 'https://www.ngram.com/api/v1/webhooks/subscriptions',
				body: undefined,
			},
		]);
	});

	it('sweeps orphan subscriptions when local static data is missing', async () => {
		const { ctx, calls, staticData } = buildHookContext({
			webhookUrl: TARGET,
			staticData: {}, // no stored id — regression: simulates static data cleared
			responses: [
				buildListResponse([
					{ id: 'sub_orphan_1', event_type: 'video.completed', target_url: TARGET },
					{ id: 'sub_orphan_2', event_type: 'video.completed', target_url: TARGET },
					{ id: 'sub_other', event_type: 'video.failed', target_url: TARGET },
				]),
				{ success: true, data: { id: 'sub_orphan_1', deleted: true } },
				{ success: true, data: { id: 'sub_orphan_2', deleted: true } },
			],
		});

		const result = await methods.default.delete.call(ctx);

		expect(result).toBe(true);
		expect(staticData.subscriptionId).toBeUndefined();
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			'GET https://www.ngram.com/api/v1/webhooks/subscriptions',
			'DELETE https://www.ngram.com/api/v1/webhooks/subscriptions/sub_orphan_1',
			'DELETE https://www.ngram.com/api/v1/webhooks/subscriptions/sub_orphan_2',
		]);
	});

	it('returns true even when the initial DELETE errors, and still runs the orphan sweep', async () => {
		const { ctx, calls, staticData, logger } = buildHookContext({
			webhookUrl: TARGET,
			staticData: { subscriptionId: 'sub_broken' },
			responses: [
				() => {
					throw new Error('404 not found');
				},
				buildListResponse([]),
			],
		});

		const result = await methods.default.delete.call(ctx);

		expect(result).toBe(true);
		expect(staticData.subscriptionId).toBeUndefined();
		expect(calls).toHaveLength(2);
		// Swallowed errors must still be logged so orphan-subscription bugs can
		// be diagnosed from server logs.
		expect(logger.warn).toHaveBeenCalledWith(
			'Ngram trigger: failed to delete stored subscription during cleanup',
			expect.objectContaining({ subscriptionId: 'sub_broken' }),
		);
	});
});
