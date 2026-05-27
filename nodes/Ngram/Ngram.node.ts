import {
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteSingleFunctions,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type IN8nHttpFullResponse,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { mapStatusResponse } from '../../src/output/mapVideoStatus';
import { ngramRequest } from '../../src/transport/ngramRequest';

// vid_ ids are base64url-encoded (alphanumerics plus `_` / `-`) per
// backend/services/public-api-jobs.ts. Rejecting anything outside that
// alphabet prevents a user-supplied id from rewriting the URL path (e.g.
// passing "foo/../account" would otherwise hit /api/v1/account with the
// connected API key attached).
const VIDEO_ID_PATTERN = /^vid_[A-Za-z0-9_-]+$/;

interface NgramConfigResponse {
	data: {
		voices: Array<{ id: string; name: string; provider: string }>;
		styles: Array<{ id: string; label: string }>;
		default_voice_id: string | null;
		aspect_ratios: string[];
		durations: number[];
		animation_modes: string[];
		animation_mode_options?: Array<{
			id: string;
			label: string;
			description: string;
			best_for: string;
		}>;
		video_modes: string[];
		scenarios: string[];
		video_type_profiles: Array<{ name: string; subtitle: string }>;
	};
}

export async function loadConfig(
	this: ILoadOptionsFunctions,
): Promise<NgramConfigResponse['data']> {
	const response = (await ngramRequest.call(this, {
		method: 'GET',
		url: '/api/v1/config',
	})) as NgramConfigResponse;
	return response.data;
}

function humanize(value: string): string {
	return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Strip empty strings, null, and undefined from the request body so we don't
 * send blank optionals to /api/v1/videos. The backend already tolerates these
 * (see PR #2664) but dropping them client-side keeps requests small and lets
 * the backend's Zod defaults apply cleanly.
 */
export async function stripEmptyBodyFields(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	if (requestOptions.body && typeof requestOptions.body === 'object') {
		const body = requestOptions.body as IDataObject;
		const cleaned: IDataObject = {};
		for (const [key, value] of Object.entries(body)) {
			if (value === undefined || value === null || value === '') continue;
			cleaned[key] = value;
		}
		requestOptions.body = cleaned;
	}
	return requestOptions;
}

/**
 * Flatten the Get Status response to the Zapier-parity shape before returning
 * items downstream. Runs as a declarative postReceive hook so the raw
 * {success, data: {...}} envelope is unwrapped and the nested `result` is
 * hoisted to top-level `video_url` / `duration_ms`.
 */
export async function flattenStatusPostReceive(
	this: IExecuteSingleFunctions,
	_items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	const body = response.body as { data?: Record<string, unknown> } | undefined;
	const data = body?.data ?? {};
	const flat = mapStatusResponse(data as Parameters<typeof mapStatusResponse>[0]);
	return [{ json: flat as unknown as IDataObject }];
}

/**
 * Build the Get Status URL in code instead of interpolating the user-supplied
 * `videoId` directly into the route template. Validates shape, URL-encodes
 * the segment, and throws on anything outside the expected alphabet — so an
 * id containing `/`, `..`, or query fragments cannot rewrite the path.
 */
export async function buildGetStatusUrl(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const videoId = String(this.getNodeParameter('videoId') ?? '').trim();
	if (!VIDEO_ID_PATTERN.test(videoId)) {
		throw new NodeOperationError(
			this.getNode(),
			`Invalid video ID: ${JSON.stringify(videoId)} — expected a value like "vid_..." returned by Create Video.`,
		);
	}
	requestOptions.url = `/api/v1/videos/${encodeURIComponent(videoId)}`;
	return requestOptions;
}

export class Ngram implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ngram',
		name: 'ngram',
		icon: 'file:../../icons/ngram.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{ $parameter["operation"] }}: {{ $parameter["resource"] }}',
		description: 'Create videos and look up video status from the Ngram public API.',
		defaults: {
			name: 'Ngram',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'ngramApi',
				required: true,
			},
		],
		requestDefaults: {
			baseURL: '={{$credentials.baseUrl}}',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [{ name: 'Video', value: 'video' }],
				default: 'video',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['video'] } },
				options: [
					{
						name: 'Create',
						value: 'create',
						action: 'Create a video',
						description:
							'Submit a new video job. Returns immediately; chain the "On Video Ready" trigger or Get Status for the final URL.',
						routing: {
							request: {
								method: 'POST',
								url: '/api/v1/videos',
							},
							send: {
								preSend: [stripEmptyBodyFields],
							},
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: { property: 'data' },
									},
								],
							},
						},
					},
					{
						name: 'Create From Text',
						value: 'createFromText',
						action: 'Create a video from text',
						description:
							'Submit a new video job from a text prompt. Returns immediately; chain the "On Video Ready" trigger or Get Status for the final URL.',
						routing: {
							request: {
								method: 'POST',
								url: '/api/v1/videos:fromText',
							},
							send: {
								preSend: [stripEmptyBodyFields],
							},
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: { property: 'data' },
									},
								],
							},
						},
					},
					{
						name: 'Create From URL',
						value: 'createFromUrl',
						action: 'Create a video from URL',
						description:
							'Submit a new video job from a webpage, article, product page, or docs URL. Returns immediately; chain the "On Video Ready" trigger or Get Status for the final URL.',
						routing: {
							request: {
								method: 'POST',
								url: '/api/v1/videos:fromUrl',
							},
							send: {
								preSend: [stripEmptyBodyFields],
							},
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: { property: 'data' },
									},
								],
							},
						},
					},
					{
						name: 'Get Status',
						value: 'getStatus',
						action: 'Get video status',
						description: 'Look up the current status of a previously submitted video job',
						routing: {
							request: {
								method: 'GET',
								// Placeholder — buildGetStatusUrl replaces this with a
								// validated, URL-encoded path before the request fires.
								url: '/api/v1/videos',
							},
							send: {
								preSend: [buildGetStatusUrl],
							},
							output: {
								postReceive: [flattenStatusPostReceive],
							},
						},
					},
				],
				default: 'create',
			},

			// ---------- Create Video fields ----------
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				description: 'Describe the video you want Ngram to create',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText'],
					},
				},
				routing: { send: { type: 'body', property: 'prompt' } },
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Optional direction for how Ngram should use the URL',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'prompt' } },
			},
			{
				displayName: 'Website URL',
				name: 'website_url',
				type: 'string',
				default: '',
				description: 'Optional brand context used for research',
				displayOptions: {
					show: { resource: ['video'], operation: ['create'] },
				},
				routing: { send: { type: 'body', property: 'website_url' } },
			},
			{
				displayName: 'Website URL',
				name: 'website_url',
				type: 'string',
				required: true,
				default: '',
				description: 'Page Ngram should research and turn into a video',
				displayOptions: {
					show: { resource: ['video'], operation: ['createFromUrl'] },
				},
				routing: { send: { type: 'body', property: 'website_url' } },
			},
			{
				displayName: 'Voice Name or ID',
				name: 'voice_id',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'listVoices' },
				default: '',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'voice_id' } },
			},
			{
				displayName: 'Style Name or ID',
				name: 'style_id',
				type: 'options',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'listStyles' },
				default: '',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'style_id' } },
			},
			{
				displayName: 'Aspect Ratio',
				name: 'aspect_ratio',
				type: 'options',
				options: [
					{ name: '1:1', value: '1:1' },
					{ name: '16:9', value: '16:9' },
					{ name: '9:16', value: '9:16' },
					{ name: 'Use API Default', value: '' },
				],
				// Empty default preserves parity with Make/Zapier: aspect_ratio is
				// optional, and an unset field is stripped by stripEmptyBodyFields
				// so the backend applies its own default. Keeping '' as a named
				// option here satisfies the n8n lint rule that requires the default
				// to match one of the listed `options` values.
				default: '',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'aspect_ratio' } },
			},
			{
				displayName: 'Duration Name or ID',
				name: 'duration',
				type: 'options',
				description:
					'Target duration in seconds. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listDurations' },
				default: '',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'duration' } },
			},
			{
				displayName: 'Animation Mode Name or ID',
				name: 'animation_mode',
				type: 'options',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'listAnimationModes' },
				default: '',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'animation_mode' } },
			},
			{
				displayName: 'Video Mode Name or ID',
				name: 'video_mode',
				type: 'options',
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
				typeOptions: { loadOptionsMethod: 'listVideoModes' },
				default: '',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'video_mode' } },
			},
			{
				displayName: 'Scenario Name or ID',
				name: 'scenario',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'listScenarios' },
				default: '',
				description:
					'Canonical scenario ID such as product_launch, explainer_video, changelog. Leave blank for free-form prompts. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'scenario' } },
			},
			{
				displayName: 'Video Type Profile Name or ID',
				name: 'video_type_profile',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'listVideoTypeProfiles' },
				default: '',
				description:
					'Optional narrative template — picks one of Ngram\'s prebuilt story patterns (Feature Explainer, Customer Proof Reel, etc.). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'video_type_profile' } },
			},
			{
				displayName: 'Energy Level',
				name: 'energy_level',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'energy_level' } },
			},
			{
				displayName: 'Story Flow',
				name: 'story_flow',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'Freeform narrative direction. Max 1024 characters.',
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'story_flow' } },
			},
			{
				displayName: 'Deep Research',
				name: 'deep_research',
				type: 'boolean',
				default: false,
				displayOptions: {
					show: {
						resource: ['video'],
						operation: ['create', 'createFromText', 'createFromUrl'],
					},
				},
				routing: { send: { type: 'body', property: 'deep_research' } },
			},

			// ---------- Get Status fields ----------
			{
				displayName: 'Video ID',
				name: 'videoId',
				type: 'string',
				required: true,
				default: '',
				description: 'The vid_... ID returned by Create Video.',
				displayOptions: { show: { resource: ['video'], operation: ['getStatus'] } },
			},
		],
	};

	methods = {
		loadOptions: {
			async listVoices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.voices.map((voice) => ({
					name: `${voice.name} (${voice.provider})`,
					value: voice.id,
				}));
			},
			async listStyles(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.styles.map((style) => ({ name: style.label, value: style.id }));
			},
			async listDurations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.durations.map((seconds) => ({
					name: `${seconds} seconds`,
					value: seconds,
				}));
			},
			async listAnimationModes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				if (data.animation_mode_options?.length) {
					return data.animation_mode_options.map((mode) => ({
						name: mode.label,
						value: mode.id,
						description: `${mode.description} Best for: ${mode.best_for}`,
					}));
				}
				return data.animation_modes.map((mode) => ({ name: humanize(mode), value: mode }));
			},
			async listVideoModes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return (data.video_modes ?? ['explainer', 'teaser']).map((mode) => ({
					name: humanize(mode),
					value: mode,
				}));
			},
			async listScenarios(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.scenarios.map((id) => ({ name: humanize(id), value: id }));
			},
			async listVideoTypeProfiles(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.video_type_profiles.map((profile) => ({
					name: `${profile.name} — ${profile.subtitle}`,
					value: profile.name,
				}));
			},
		},
	};
}
