import { describe, expect, it } from 'vitest';
import {
	NodeApiError,
	type IExecuteSingleFunctions,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeProperties,
} from 'n8n-workflow';
import {
	Ngram,
	buildGetStatusUrl,
	loadConfig,
	ngramPackageNodeLoaders,
	stripEmptyBodyFields,
	throwApiErrorPostReceive,
} from '../nodes/Ngram/Ngram.node';
import { buildHookContext } from './helpers/mock-context';

function buildExecuteSingleCtx(videoId: unknown): IExecuteSingleFunctions {
	return {
		getNodeParameter: (_name: string) => videoId,
		getNode: () => ({ name: 'Ngram', type: 'n8n-nodes-ngram.ngram' }),
	} as unknown as IExecuteSingleFunctions;
}

const EXPECTED_CREATE_FIELDS = [
	'prompt',
	'website_url',
	'director_model',
	'voice_id',
	'style_id',
	'aspect_ratio',
	'duration',
	'energy_level',
	'mood',
	'voice_language',
	'brand_kit',
	'video_format',
	'image_urls',
];

const V1_FIELDS = [
	'animation_mode',
	'scenario',
	'video_type_profile',
	'story_flow',
	'deep_research',
];

function findCreateFields(node: Ngram): INodeProperties[] {
	return findFieldsForOperation(node, 'create');
}

function findFieldsForOperation(node: Ngram, operation: string): INodeProperties[] {
	return node.description.properties.filter((p) => {
		const show = p.displayOptions?.show;
		return (
			p.name !== 'resource' &&
			p.name !== 'operation' &&
			show?.resource?.includes('video') &&
			show?.operation?.includes(operation)
		);
	});
}

describe('Ngram action node — description', () => {
	const node = new Ngram();

	it('keeps trigger node modules reachable from the package entrypoint', async () => {
		const triggerModules = await Promise.all(ngramPackageNodeLoaders.map((load) => load()));

		expect(triggerModules[0]).toHaveProperty('NgramTriggerCompleted');
		expect(triggerModules[1]).toHaveProperty('NgramTriggerFailed');
	});

	it('declares all Create Video inputs with parity to Make/Zapier', () => {
		const created = findCreateFields(node).map((p) => p.name);
		for (const field of EXPECTED_CREATE_FIELDS) {
			expect(created).toContain(field);
		}
		expect(created).toHaveLength(EXPECTED_CREATE_FIELDS.length);
	});

	it('routes every Create Video input to the request body under its API name', () => {
		const createFields = findCreateFields(node);
		for (const field of createFields) {
			// Every create input must map to body.<same_name>.
			const routing = field.routing as { send?: { type?: string; property?: string } } | undefined;
			expect(routing?.send?.type).toBe('body');
			expect(routing?.send?.property).toBe(field.name);
		}
	});

	it('keeps first-class create operations aligned with their expected fields', () => {
		const expectedByOperation: Record<string, string[]> = {
			create: EXPECTED_CREATE_FIELDS,
			createFromText: EXPECTED_CREATE_FIELDS.filter((field) => field !== 'website_url'),
			createFromUrl: EXPECTED_CREATE_FIELDS,
		};

		for (const [operation, expectedFields] of Object.entries(expectedByOperation)) {
			const actual = findFieldsForOperation(node, operation).map((p) => p.name);
			expect(actual).toEqual(expectedFields);
		}
	});

	it('marks source-specific fields correctly for URL creation', () => {
		const fields = findFieldsForOperation(node, 'createFromUrl');
		const prompt = fields.find((field) => field.name === 'prompt');
		const websiteUrl = fields.find((field) => field.name === 'website_url');

		expect(prompt?.required ?? false).toBe(false);
		expect(websiteUrl?.required).toBe(true);
	});

	it('exposes videoId as the only input for Get Status', () => {
		const statusInputs = node.description.properties.filter((p) => {
			const show = p.displayOptions?.show;
			return show?.operation?.includes('getStatus');
		});
		expect(statusInputs).toHaveLength(1);
		expect(statusInputs[0]?.name).toBe('videoId');
		expect(statusInputs[0]?.required).toBe(true);
	});

	it('declares loadOptions for every API-backed dropdown', () => {
		const loadOptionsByField: Record<string, string> = {
			voice_id: 'listVoices',
			style_id: 'listStyles',
			duration: 'listDurations',
			energy_level: 'listEnergyLevels',
			mood: 'listMoods',
			voice_language: 'listVoiceLanguages',
			brand_kit: 'listBrandKits',
			director_model: 'listModels',
		};
		for (const [name, method] of Object.entries(loadOptionsByField)) {
			const field = node.description.properties.find((p) => p.name === name);
			expect(field?.typeOptions?.loadOptionsMethod).toBe(method);
			expect(node.methods.loadOptions).toHaveProperty(method);
		}
	});

	it('offers no deprecated V1 input, no Mode, and no option source for either', () => {
		const names = node.description.properties.map((p) => p.name);
		for (const field of [...V1_FIELDS, 'mode']) expect(names).not.toContain(field);
		for (const method of ['listAnimationModes', 'listScenarios', 'listVideoTypeProfiles', 'listModes']) {
			expect(node.methods.loadOptions).not.toHaveProperty(method);
		}
	});

	it('describes Model, Duration, and Video Format with the current pricing and length rules', () => {
		const field = (name: string) => node.description.properties.find((p) => p.name === name);
		expect(field('director_model')).toMatchObject({ displayName: 'Model Name or ID', default: '' });
		expect(field('director_model')?.description).toContain("Leave empty to use your account's default model");
		expect(field('director_model')?.description).toContain('The price depends on the model chosen');
		expect(field('director_model')?.description).toContain('needs a paid ngram plan');
		expect(field('duration')?.description).toContain(
			'any length of at least 1 second; leave empty to let ngram choose (Auto)',
		);
		for (const name of ['director_model', 'duration', 'video_format']) {
			expect(field(name)?.description).not.toMatch(/180|15-second|Lite|\d+ credits/);
		}
	});

	it('reports API errors from every create operation through throwApiErrorPostReceive', () => {
		const operation = node.description.properties.find((p) => p.name === 'operation');
		const creates = (
			operation?.options as Array<{
				value: string;
				routing?: { request?: { ignoreHttpStatusErrors?: boolean }; output?: { postReceive?: unknown[] } };
			}>
		).filter((option) => option.value.startsWith('create'));

		expect(creates.map((option) => option.value).sort()).toEqual([
			'create',
			'createFromText',
			'createFromUrl',
		]);
		for (const option of creates) {
			expect(option.routing?.request?.ignoreHttpStatusErrors).toBe(true);
			expect(option.routing?.output?.postReceive?.[0]).toBe(throwApiErrorPostReceive);
		}
	});

	it('declares first-class create operations for text and URL video capabilities', () => {
		const operation = node.description.properties.find((p) => p.name === 'operation');
		const options = operation?.options as Array<{
			name: string;
			value: string;
			routing?: { request?: { url?: string } };
		}>;

		expect(options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: 'Create From Text',
					value: 'createFromText',
					routing: expect.objectContaining({
						request: expect.objectContaining({ url: '/api/v1/videos:fromText' }),
					}),
				}),
				expect.objectContaining({
					name: 'Create From URL',
					value: 'createFromUrl',
					routing: expect.objectContaining({
						request: expect.objectContaining({ url: '/api/v1/videos:fromUrl' }),
					}),
				}),
			]),
		);
	});
});

describe('stripEmptyBodyFields preSend', () => {
	it('removes empty strings, null, and undefined from the body', async () => {
		const requestOptions: IHttpRequestOptions = {
			method: 'POST',
			url: '/api/v1/videos',
			body: {
				prompt: 'hello',
				voice_id: '',
				website_url: '',
				duration: 30,
				director_model: 'opus-5.5',
				aspect_ratio: null,
				mood: undefined,
			},
		};

		const result = await stripEmptyBodyFields.call(
			{} as unknown as IExecuteSingleFunctions,
			requestOptions,
		);

		expect(result.body).toEqual({
			prompt: 'hello',
			duration: 30,
			director_model: 'opus-5.5',
		});
	});

	it('converts newline-separated image URLs into an asset array', async () => {
		const requestOptions: IHttpRequestOptions = {
			method: 'POST',
			url: '/api/v1/videos',
			body: {
				prompt: 'hello',
				image_urls: 'https://example.com/a.png\nhttps://example.com/b.png',
			},
		};

		const result = await stripEmptyBodyFields.call(
			{} as unknown as IExecuteSingleFunctions,
			requestOptions,
		);

		expect(result.body).toEqual({
			prompt: 'hello',
			image_urls: ['https://example.com/a.png', 'https://example.com/b.png'],
		});
	});

	it('is a no-op when the body is not an object', async () => {
		const requestOptions: IHttpRequestOptions = {
			method: 'POST',
			url: '/api/v1/videos',
			body: 'not-an-object',
		};

		const result = await stripEmptyBodyFields.call(
			{} as unknown as IExecuteSingleFunctions,
			requestOptions,
		);

		expect(result.body).toBe('not-an-object');
	});
});

describe('throwApiErrorPostReceive', () => {
	const ctx = {
		getNode: () => ({ name: 'Ngram', type: 'n8n-nodes-ngram.ngram' }),
	} as unknown as IExecuteSingleFunctions;
	const items: INodeExecutionData[] = [{ json: {} }];

	it('passes successful responses through unchanged', async () => {
		const result = await throwApiErrorPostReceive.call(ctx, items, {
			statusCode: 202,
			headers: {},
			body: { success: true, data: { id: 'vid_1' } },
		});

		expect(result).toBe(items);
	});

	it("headlines the API's paid-plan message instead of n8n's generic 403 text", async () => {
		const paidPlanMessage =
			'API and MCP videos are delivered as MP4 downloads, which require a paid plan. Create the video in the ngram app and share an ngram-hosted link, or upgrade.';

		const attempt = throwApiErrorPostReceive.call(ctx, items, {
			statusCode: 403,
			headers: {},
			body: {
				success: false,
				error: {
					code: 'FORBIDDEN',
					message: paidPlanMessage,
					statusCode: 403,
					details: { reason: 'download_requires_paid_plan' },
				},
			},
		});

		await expect(attempt).rejects.toBeInstanceOf(NodeApiError);
		await expect(attempt).rejects.toMatchObject({ message: paidPlanMessage, httpCode: '403' });
	});

	it('names each field the API rejected', async () => {
		const attempt = throwApiErrorPostReceive.call(ctx, items, {
			statusCode: 400,
			headers: {},
			body: {
				success: false,
				error: {
					code: 'BAD_REQUEST',
					message: 'Invalid request body',
					details: { issues: [{ path: 'mode', message: 'Invalid option: expected "pro"' }] },
				},
			},
		});

		await expect(attempt).rejects.toMatchObject({
			message: 'Invalid request body: mode: Invalid option: expected "pro"',
			httpCode: '400',
		});
	});

	it('falls back to the status code when the body carries no message', async () => {
		const attempt = throwApiErrorPostReceive.call(ctx, items, {
			statusCode: 502,
			headers: {},
			body: '<html>Bad gateway</html>',
		});

		await expect(attempt).rejects.toMatchObject({
			message: 'The ngram API returned HTTP 502',
			httpCode: '502',
		});
	});
});

describe('buildGetStatusUrl preSend', () => {
	it('builds a safe URL-encoded path from a valid video id', async () => {
		const ctx = buildExecuteSingleCtx('vid_abc123_XYZ-');
		const result = await buildGetStatusUrl.call(ctx, {
			method: 'GET',
			url: '/api/v1/videos',
		});
		expect(result.url).toBe('/api/v1/videos/vid_abc123_XYZ-');
	});

	it('rejects ids containing path separators that would rewrite the route', async () => {
		// The attack surface: a user-supplied id like "vid_abc/../account" would
		// hit /api/v1/account with the bearer token if we let the string flow
		// into the URL unchecked.
		for (const attack of [
			'vid_abc/../account',
			'vid_abc/../../user',
			'vid_abc?override=true',
			'vid_abc#fragment',
			'vid_abc%2F..',
			'../../etc/passwd',
			'',
			'   ',
			'not-a-vid-prefix',
			'vid_',
			'vid_!!invalid!!',
		]) {
			const ctx = buildExecuteSingleCtx(attack);
			await expect(
				buildGetStatusUrl.call(ctx, { method: 'GET', url: '/api/v1/videos' }),
			).rejects.toThrow(/Invalid video ID/);
		}
	});

	it('trims surrounding whitespace before validating', async () => {
		const ctx = buildExecuteSingleCtx('  vid_trimmed  ');
		const result = await buildGetStatusUrl.call(ctx, {
			method: 'GET',
			url: '/api/v1/videos',
		});
		expect(result.url).toBe('/api/v1/videos/vid_trimmed');
	});
});

describe('Ngram loadOptions', () => {
	const node = new Ngram();

	function buildConfigResponse() {
		return {
			success: true,
			data: {
				voices: [
					{ id: 'voice_a', name: 'Amelia', provider: 'elevenlabs' },
					{ id: 'voice_b', name: 'Ben', provider: 'azure' },
				],
				styles: [
					{ id: 'auto', label: 'Auto', description: 'Ngram chooses the look.' },
					{ id: 'whiteboard', label: 'Whiteboard' },
				],
				default_voice_id: null,
				aspect_ratios: ['16:9', '9:16', '1:1'],
				durations: [15, 30, 60],
				energy_levels: [
					{ id: 'calm', label: 'Calm', description: 'Room to breathe' },
					{ id: 'energetic', label: 'Energetic', description: 'Fast and expressive' },
				],
				moods: [
					{ id: 'auto', label: 'Auto' },
					{ id: 'warm', label: 'Warm' },
				],
				voice_languages: [
					{ code: 'en', label: 'English' },
					{ code: 'es', label: 'Spanish' },
				],
				v2_creation: {
					directors: [
						{ id: 'ngram-flash', label: 'ngram-flash', credits_per_second: 3, requires_paid_plan: true },
						{ id: 'opus-5.5', label: 'Opus 5.5', credits_per_second: 10, requires_paid_plan: true },
					],
					default_director_models: { free: 'ngram-flash', paid: 'opus-5.5' },
				},
				// Deprecated V1 catalogs the API still returns for older clients.
				animation_modes: [],
				scenarios: [],
				video_type_profiles: [],
			},
		};
	}

	async function callLoadOption(
		method: keyof typeof node.methods.loadOptions,
	): Promise<INodePropertyOptions[]> {
		const { ctx } = buildHookContext({ responses: [buildConfigResponse()] });
		return node.methods.loadOptions[method].call(ctx as unknown as ILoadOptionsFunctions);
	}

	it('listVoices returns provider-suffixed names', async () => {
		const options = await callLoadOption('listVoices');
		expect(options).toEqual([
			{ name: 'Amelia (elevenlabs)', value: 'voice_a' },
			{ name: 'Ben (azure)', value: 'voice_b' },
		]);
	});

	it('listStyles returns the V2 style labels and descriptions', async () => {
		const options = await callLoadOption('listStyles');
		expect(options).toEqual([
			{ name: 'Auto', value: 'auto', description: 'Ngram chooses the look.' },
			{ name: 'Whiteboard', value: 'whiteboard' },
		]);
	});

	it('listDurations formats seconds suffixes and preserves numeric values', async () => {
		const options = await callLoadOption('listDurations');
		expect(options).toEqual([
			{ name: '15 seconds', value: 15 },
			{ name: '30 seconds', value: 30 },
			{ name: '60 seconds', value: 60 },
		]);
	});

	it('listEnergyLevels, listMoods, and listVoiceLanguages read the V2 catalogs', async () => {
		expect(await callLoadOption('listEnergyLevels')).toEqual([
			{ name: 'Calm', value: 'calm', description: 'Room to breathe' },
			{ name: 'Energetic', value: 'energetic', description: 'Fast and expressive' },
		]);
		expect(await callLoadOption('listMoods')).toEqual([
			{ name: 'Auto', value: 'auto' },
			{ name: 'Warm', value: 'warm' },
		]);
		expect(await callLoadOption('listVoiceLanguages')).toEqual([
			{ name: 'English', value: 'en' },
			{ name: 'Spanish', value: 'es' },
		]);
	});

	it('listModels lists v2_creation.directors from /api/v1/config with their live rate', async () => {
		const { ctx, calls } = buildHookContext({ responses: [buildConfigResponse()] });

		const options = await node.methods.loadOptions.listModels.call(
			ctx as unknown as ILoadOptionsFunctions,
		);

		expect(calls[0]?.url).toBe('https://www.ngram.com/api/v1/config');
		expect(options).toEqual([
			{ name: 'ngram-flash — 3 credits/sec', value: 'ngram-flash' },
			{ name: 'Opus 5.5 — 10 credits/sec', value: 'opus-5.5' },
		]);
	});

	it('listModels is empty when the backend lists no models', async () => {
		const config = buildConfigResponse();
		const { ctx } = buildHookContext({
			responses: [{ ...config, data: { ...config.data, v2_creation: null } }],
		});

		const options = await node.methods.loadOptions.listModels.call(
			ctx as unknown as ILoadOptionsFunctions,
		);

		expect(options).toEqual([]);
	});

	it('listBrandKits lists the Brand Kits from /api/v1/brand-kits', async () => {
		const { ctx, calls } = buildHookContext({
			responses: [
				{
					success: true,
					data: {
						brand_kits: [
							{ id: 'kit-1', name: 'Acme', is_default: true },
							{ id: 'kit-2', name: 'Side project', is_default: false },
						],
					},
				},
			],
		});

		const options = await node.methods.loadOptions.listBrandKits.call(
			ctx as unknown as ILoadOptionsFunctions,
		);

		expect(calls[0]?.url).toBe('https://www.ngram.com/api/v1/brand-kits');
		expect(options).toEqual([
			{ name: 'Acme (default)', value: 'kit-1' },
			{ name: 'Side project', value: 'kit-2' },
		]);
	});

	it('loadConfig passes the caller credentials through ngramRequest', async () => {
		const { ctx, calls } = buildHookContext({ responses: [buildConfigResponse()] });
		await loadConfig.call(ctx as unknown as ILoadOptionsFunctions);
		expect(calls).toEqual([
			{
				method: 'GET',
				url: 'https://www.ngram.com/api/v1/config',
				body: undefined,
			},
		]);
	});

	it('loadConfig honours the credential baseUrl override (staging)', async () => {
		const { ctx, calls } = buildHookContext({
			credentials: { apiKey: 'ngs_test', baseUrl: 'https://staging.ngram.com/' },
			responses: [buildConfigResponse()],
		});
		await loadConfig.call(ctx as unknown as ILoadOptionsFunctions);
		// Trailing slash is stripped by ngramRequest.
		expect(calls[0]?.url).toBe('https://staging.ngram.com/api/v1/config');
	});
});
