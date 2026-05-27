#!/usr/bin/env node
/**
 * Headless end-to-end smoke test for n8n-nodes-ngram against the live API.
 *
 * Imports the *built* node modules from dist/ and runs them under a minimal
 * fake n8n runtime (just enough to satisfy the IHookFunctions /
 * IExecuteSingleFunctions / IWebhookFunctions surfaces our code touches).
 *
 * Run: NGRAM_TOKEN=ngs_... node scripts/e2e-smoke.mjs
 *
 * Never logs the token. Cleans up any subscription it creates.
 */

import { request } from 'node:https';
import { URL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const TOKEN = process.env.NGRAM_TOKEN;
const BASE = process.env.NGRAM_BASE_URL ?? 'https://www.ngram.com';
if (!TOKEN) {
	console.error('NGRAM_TOKEN env var required');
	process.exit(1);
}

const results = [];
function record(name, status, detail) {
	results.push({ name, status, detail });
	const icon = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
	console.log(`[${icon}] ${name}${detail ? ' — ' + detail : ''}`);
}

// Minimal fake n8n http helper that signs with the bearer token.
async function httpRequestWithAuthentication(_credName, opts) {
	const url = new URL(opts.url);
	return new Promise((resolve, reject) => {
		const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
		const req = request(
			{
				method: opts.method,
				hostname: url.hostname,
				port: url.port || 443,
				path: url.pathname + url.search,
				headers: {
					Authorization: `Bearer ${TOKEN}`,
					Accept: 'application/json',
					...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
				},
			},
			(res) => {
				let chunks = '';
				res.on('data', (c) => (chunks += c));
				res.on('end', () => {
					if (res.statusCode >= 400) {
						const err = new Error(`HTTP ${res.statusCode}: ${chunks.slice(0, 300)}`);
						err.httpCode = res.statusCode;
						return reject(err);
					}
					try {
						resolve(opts.json !== false ? JSON.parse(chunks) : chunks);
					} catch (e) {
						reject(new Error(`Bad JSON: ${chunks.slice(0, 200)}`));
					}
				});
			},
		);
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

const credentials = { apiKey: TOKEN, baseUrl: BASE };
const logger = {
	debug: () => {},
	info: () => {},
	warn: (msg, ctx) => console.log(`  [logger.warn] ${msg}`, ctx ?? ''),
	error: (msg, ctx) => console.log(`  [logger.error] ${msg}`, ctx ?? ''),
};
const staticData = {};
// Public resolvable URL for the trigger create→delete round-trip. We never
// actually receive at this URL — we delete the subscription right after
// creating it. Using httpbin so DNS resolves and the webhook-url SSRF guard
// passes; n8n in production would use a real n8n.example.com webhook URL.
const fakeWebhookUrl = `https://httpbin.org/anything/n8n-smoke-${Date.now()}`;

function buildHookCtx(extraStatic = {}) {
	const sd = { ...staticData, ...extraStatic };
	return {
		helpers: { httpRequestWithAuthentication },
		getCredentials: async () => credentials,
		getNodeWebhookUrl: () => fakeWebhookUrl,
		getWorkflowStaticData: () => sd,
		logger,
		_staticData: sd,
	};
}

function buildExecuteSingleCtx(params = {}) {
	return {
		helpers: { httpRequestWithAuthentication },
		getCredentials: async () => credentials,
		getNodeParameter: (name) => params[name],
		getNode: () => ({ name: 'Ngram', type: 'n8n-nodes-ngram.ngram' }),
		logger,
	};
}

// --- Load the built node modules ------------------------------------------
const credentialMod = require('../dist/credentials/NgramApi.credentials.js');
const ngramNode = require('../dist/nodes/Ngram/Ngram.node.js');
const triggerCompletedMod = require('../dist/nodes/NgramTriggerCompleted/NgramTriggerCompleted.node.js');
const lifecycleMod = require('../dist/src/trigger/subscriptionLifecycle.js');
const mapMod = require('../dist/src/output/mapVideoStatus.js');

// --- 1. Credential test request ---------------------------------------------
{
	const cred = new credentialMod.NgramApi();
	const expected = '/api/v1/account';
	if (cred.test?.request?.url === expected) {
		record('Credential test endpoint', 'pass', expected);
	} else {
		record('Credential test endpoint', 'fail', `expected ${expected}, got ${cred.test?.request?.url}`);
	}
}

// --- 2. /account live ------------------------------------------------------
const account = await httpRequestWithAuthentication('ngramApi', {
	method: 'GET',
	url: `${BASE}/api/v1/account`,
});
record('GET /api/v1/account', 'pass', 'authenticated');

// --- 3. /config + every loadOptions hydration -------------------------------
const node = new ngramNode.Ngram();
const loadOptions = node.methods.loadOptions;
for (const key of Object.keys(loadOptions)) {
	try {
		const ctx = buildHookCtx();
		const items = await loadOptions[key].call(ctx);
		if (!Array.isArray(items) || items.length === 0) {
			record(`loadOptions.${key}`, 'fail', `empty/non-array: ${JSON.stringify(items).slice(0, 80)}`);
		} else {
			record(`loadOptions.${key}`, 'pass', `${items.length} items, first=${items[0].name}`);
		}
	} catch (err) {
		record(`loadOptions.${key}`, 'fail', err.message.slice(0, 200));
	}
}

// --- 4. Trigger checkExists (the new GET subscriptions route) ---------------
{
	const methods = lifecycleMod.buildWebhookMethods('video.completed');
	const ctx = buildHookCtx();
	try {
		const result = await methods.default.checkExists.call(ctx);
		record('Trigger checkExists', 'pass', `result=${result} (no match expected for fake URL)`);
	} catch (err) {
		if (err.httpCode === 404 || err.message.includes('<!doctype')) {
			record('Trigger checkExists', 'skip', 'GET /webhooks/subscriptions not deployed yet (this PR adds it)');
		} else {
			record('Trigger checkExists', 'fail', err.message.slice(0, 200));
		}
	}
}

// --- 5. Trigger create -> delete (full round-trip) --------------------------
{
	const methods = lifecycleMod.buildWebhookMethods('video.completed');
	const ctx = buildHookCtx();
	let createdId = null;
	try {
		await methods.default.create.call(ctx);
		createdId = ctx._staticData.subscriptionId;
		const hasSecret = !!ctx._staticData.subscriptionSecret;
		if (createdId?.startsWith('sub_') && hasSecret) {
			record('Trigger create', 'pass', `id=${createdId.slice(0, 12)}…, secret stored`);
		} else {
			record('Trigger create', 'fail', `id=${createdId} secret=${hasSecret}`);
		}
	} catch (err) {
		record('Trigger create', 'fail', err.message.slice(0, 200));
	}
	if (createdId) {
		try {
			const ctx2 = buildHookCtx({ subscriptionId: createdId, subscriptionSecret: 'whatever' });
			await methods.default.delete.call(ctx2);
			if (ctx2._staticData.subscriptionId === undefined) {
				record('Trigger delete', 'pass', `cleared local state for ${createdId.slice(0, 12)}…`);
			} else {
				record('Trigger delete', 'fail', `static still has ${ctx2._staticData.subscriptionId}`);
			}
		} catch (err) {
			record('Trigger delete', 'fail', err.message.slice(0, 200));
		}
	}
}

// --- 6. buildGetStatusUrl validator (vid_ pattern) --------------------------
try {
	const ctx = buildExecuteSingleCtx({ videoId: 'vid_abc/../account' });
	await ngramNode.buildGetStatusUrl.call(ctx, { method: 'GET', url: '/api/v1/videos' });
	record('buildGetStatusUrl rejects path traversal', 'fail', 'should have thrown');
} catch (err) {
	if (err.message.includes('Invalid video ID')) {
		record('buildGetStatusUrl rejects path traversal', 'pass', `threw NodeOperationError`);
	} else {
		record('buildGetStatusUrl rejects path traversal', 'fail', err.message.slice(0, 200));
	}
}
{
	const ctx = buildExecuteSingleCtx({ videoId: 'vid_smokeTest123' });
	const opts = await ngramNode.buildGetStatusUrl.call(ctx, { method: 'GET', url: '/api/v1/videos' });
	if (opts.url === '/api/v1/videos/vid_smokeTest123') {
		record('buildGetStatusUrl accepts valid id', 'pass', opts.url);
	} else {
		record('buildGetStatusUrl accepts valid id', 'fail', opts.url);
	}
}

// --- 7. Webhook receive type guards (pure, no network) ----------------------
{
	const malformed = { event: 'video.completed' };
	const valid = mapMod.isCompletedWebhookPayload(malformed);
	record('Webhook type guard rejects malformed', valid === false ? 'pass' : 'fail', `valid=${valid}`);
}
{
	const ok = {
		event: 'video.completed',
		video_id: 'vid_x',
		created_at: 'now',
		result: { url: 'https://x', duration_ms: 1 },
	};
	const valid = mapMod.isCompletedWebhookPayload(ok);
	record('Webhook type guard accepts well-formed', valid === true ? 'pass' : 'fail', `valid=${valid}`);
}

// --- 8. Live POST /videos (creates ONE small video, then polls once) --------
let createdVideoId = null;
try {
	const created = await httpRequestWithAuthentication('ngramApi', {
		method: 'POST',
		url: `${BASE}/api/v1/videos`,
		body: {
			prompt: 'A 15-second smoke-test from the n8n-nodes-ngram package. Just a placeholder.',
			duration: 15,
			animation_mode: 'basic',
		},
	});
	createdVideoId = created.data?.id;
	if (createdVideoId?.startsWith('vid_') && created.data?.status === 'processing') {
		record('POST /api/v1/videos (Create Video)', 'pass', `id=${createdVideoId}, status=processing`);
	} else {
		record('POST /api/v1/videos (Create Video)', 'fail', JSON.stringify(created).slice(0, 200));
	}
} catch (err) {
	record('POST /api/v1/videos (Create Video)', 'fail', err.message.slice(0, 200));
}

// --- 9. Get Status flattening (declarative postReceive equivalent) ----------
if (createdVideoId) {
	try {
		const status = await httpRequestWithAuthentication('ngramApi', {
			method: 'GET',
			url: `${BASE}/api/v1/videos/${encodeURIComponent(createdVideoId)}`,
		});
		// Simulate flattenStatusPostReceive.
		const flat = mapMod.mapStatusResponse(status.data);
		const expectedKeys = [
			'id',
			'status',
			'progress',
			'video_url',
			'duration_ms',
			'error_code',
			'error_message',
			'created_at',
			'completed_at',
		];
		const got = Object.keys(flat).sort();
		const expected = expectedKeys.sort();
		if (JSON.stringify(got) === JSON.stringify(expected) && flat.id === createdVideoId) {
			record(
				'Get Status + flatten (Zapier parity shape)',
				'pass',
				`status=${flat.status} progress=${flat.progress}`,
			);
		} else {
			record('Get Status + flatten (Zapier parity shape)', 'fail', `keys: ${got.join(',')}`);
		}
	} catch (err) {
		record('Get Status + flatten (Zapier parity shape)', 'fail', err.message.slice(0, 200));
	}
}

// --- 10. Summary ------------------------------------------------------------
console.log('');
const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
console.log(`SUMMARY: pass=${counts.pass ?? 0}, fail=${counts.fail ?? 0}, skip=${counts.skip ?? 0}`);
process.exit((counts.fail ?? 0) === 0 ? 0 : 1);
