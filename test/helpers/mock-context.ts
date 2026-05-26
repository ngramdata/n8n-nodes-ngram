import { vi } from 'vitest';
import type { IHookFunctions, ILoadOptionsFunctions } from 'n8n-workflow';

export interface MockHookCallLog {
	method: string;
	url: string;
	body?: unknown;
}

export interface MockHookOptions {
	credentials?: { apiKey?: string; baseUrl?: string };
	webhookUrl?: string;
	staticData?: Record<string, unknown>;
	responses?: Array<unknown | ((call: MockHookCallLog) => unknown)>;
}

export function buildHookContext(options: MockHookOptions = {}) {
	const staticData = options.staticData ?? {};
	const credentials = {
		apiKey: 'ngs_test',
		baseUrl: 'https://www.ngram.com',
		...(options.credentials ?? {}),
	};
	const webhookUrl = options.webhookUrl ?? 'https://n8n.example.com/webhook/abc';
	const calls: MockHookCallLog[] = [];
	const queue = (options.responses ?? []).slice();

	const httpRequestWithAuthentication = vi.fn(async (_name: string, opts: { method: string; url: string; body?: unknown }) => {
		const logEntry: MockHookCallLog = { method: opts.method, url: opts.url, body: opts.body };
		calls.push(logEntry);
		const next = queue.shift();
		if (typeof next === 'function') {
			return (next as (call: MockHookCallLog) => unknown)(logEntry);
		}
		return next;
	});

	const getNodeWebhookUrl = vi.fn(() => webhookUrl);
	const getWorkflowStaticData = vi.fn(() => staticData);
	const getCredentials = vi.fn(async () => credentials);
	const logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};

	const ctx = {
		helpers: { httpRequestWithAuthentication },
		getNodeWebhookUrl,
		getWorkflowStaticData,
		getCredentials,
		logger,
	};

	return {
		ctx: ctx as unknown as IHookFunctions & ILoadOptionsFunctions,
		calls,
		staticData,
		logger,
	};
}

export function buildListResponse(rows: Array<{ id: string; event_type: string; target_url: string; created_at?: string }>) {
	return {
		success: true,
		data: rows.map((r) => ({ created_at: '2026-04-24T00:00:00.000Z', ...r })),
	};
}

export function buildCreateResponse(subscription: { id: string; event_type: string; target_url: string; secret?: string }) {
	return {
		success: true,
		data: {
			id: subscription.id,
			event_type: subscription.event_type,
			target_url: subscription.target_url,
			secret: subscription.secret ?? 'secret-abc',
			created_at: '2026-04-24T00:00:00.000Z',
		},
	};
}
