import { describe, expect, it } from 'vitest';
import type {
	IExecuteSingleFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeProperties,
} from 'n8n-workflow';
import {
	Ngram,
	buildGetStatusUrl,
	loadConfig,
	stripEmptyBodyFields,
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
	'voice_id',
	'style_id',
	'aspect_ratio',
	'duration',
	'animation_mode',
	'video_mode',
	'scenario',
	'video_type_profile',
	'energy_level',
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

	it('declares loadOptions for all config-backed dropdowns', () => {
		const configBacked = [
			'voice_id',
			'style_id',
			'duration',
			'animation_mode',
			'video_mode',
			'scenario',
			'video_type_profile',
		];
		for (const name of configBacked) {
			const field = node.description.properties.find((p) => p.name === name);
			expect(field?.typeOptions?.loadOptionsMethod).toBeTruthy();
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
				deep_research: false,
				aspect_ratio: null,
				scenario: undefined,
			},
		};

		const result = await stripEmptyBodyFields.call(
			{} as unknown as IExecuteSingleFunctions,
			requestOptions,
		);

		expect(result.body).toEqual({
			prompt: 'hello',
			duration: 30,
			deep_research: false,
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
					{ id: 'cinematic', label: 'Cinematic' },
					{ id: 'minimal', label: 'Minimal' },
				],
				default_voice_id: null,
				aspect_ratios: ['16:9', '9:16', '1:1'],
				durations: [15, 30, 60],
				animation_modes: ['basic', 'motion_graphics'],
				animation_mode_options: [
					{
						id: 'basic',
						label: 'Basic',
						description: 'Photo-motion video with generated visuals.',
						best_for: 'Simple explainers',
					},
					{
						id: 'motion_graphics',
						label: 'Motion Graphics',
						description: 'Remotion-driven graphics and layout animation.',
						best_for: 'Product storytelling',
					},
				],
				video_modes: ['explainer', 'teaser'],
				scenarios: ['product_launch', 'changelog'],
				video_type_profiles: [
					{ name: 'Feature Explainer', subtitle: 'Walks through a single feature' },
				],
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

	it('listStyles returns label/id pairs', async () => {
		const options = await callLoadOption('listStyles');
		expect(options).toEqual([
			{ name: 'Cinematic', value: 'cinematic' },
			{ name: 'Minimal', value: 'minimal' },
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

	it('listAnimationModes prefers rich labels and descriptions when present', async () => {
		const options = await callLoadOption('listAnimationModes');
		expect(options).toEqual([
			{
				name: 'Basic',
				value: 'basic',
				description: 'Photo-motion video with generated visuals. Best for: Simple explainers',
			},
			{
				name: 'Motion Graphics',
				value: 'motion_graphics',
				description:
					'Remotion-driven graphics and layout animation. Best for: Product storytelling',
			},
		]);
	});

	it('listVideoModes humanizes mode ids', async () => {
		const options = await callLoadOption('listVideoModes');
		expect(options).toEqual([
			{ name: 'Explainer', value: 'explainer' },
			{ name: 'Teaser', value: 'teaser' },
		]);
	});

	it('listScenarios humanizes ids', async () => {
		const options = await callLoadOption('listScenarios');
		expect(options).toEqual([
			{ name: 'Product Launch', value: 'product_launch' },
			{ name: 'Changelog', value: 'changelog' },
		]);
	});

	it('listVideoTypeProfiles concatenates name and subtitle', async () => {
		const options = await callLoadOption('listVideoTypeProfiles');
		expect(options).toEqual([
			{
				name: 'Feature Explainer — Walks through a single feature',
				value: 'Feature Explainer',
			},
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
