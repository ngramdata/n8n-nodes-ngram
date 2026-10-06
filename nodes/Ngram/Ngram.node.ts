import {
	NodeApiError,
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
	type JsonObject,
} from 'n8n-workflow';
import { mapStatusResponse } from '../../src/output/mapVideoStatus';
import { ngramRequest } from '../../src/transport/ngramRequest';

export const ngramPackageNodeLoaders = [
	() => import('../NgramTriggerCompleted/NgramTriggerCompleted.node'),
	() => import('../NgramTriggerFailed/NgramTriggerFailed.node'),
] as const;

// vid_ ids are base64url-encoded (alphanumerics plus `_` / `-`) per
// backend/services/public-api-jobs.ts. Rejecting anything outside that
// alphabet prevents a user-supplied id from rewriting the URL path (e.g.
// passing "foo/../account" would otherwise hit /api/v1/account with the
// connected API key attached).
const VIDEO_ID_PATTERN = /^vid_[A-Za-z0-9_-]+$/;

interface NgramOption {
	id: string;
	label: string;
	description?: string;
}

/** A model (director) the API offers, priced per second of finished video. */
interface NgramDirector {
	id: string;
	label: string;
	credits_per_second: number;
}

/** The V2 create-video catalog on GET /api/v1/config (deprecated V1 catalogs are not read). */
interface NgramConfigResponse {
	data: {
		/** The models API callers can choose; null when the backend's video settings are not configured. */
		v2_creation?: { directors: NgramDirector[] } | null;
		voices: Array<{ id: string; name: string; provider: string }>;
		styles: NgramOption[];
		default_voice_id: string | null;
		aspect_ratios: string[];
		durations: number[];
		energy_levels?: NgramOption[];
		moods?: NgramOption[];
		voice_languages?: Array<{ code: string; label: string }>;
	};
}

const SHOW_ON_CREATE = {
	show: {
		resource: ['video'],
		operation: ['create', 'createFromText', 'createFromUrl'],
	},
};

function toOption(option: NgramOption): INodePropertyOptions {
	return {
		name: option.label,
		value: option.id,
		...(option.description ? { description: option.description } : {}),
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
			if (key === 'image_urls' && typeof value === 'string') {
				const urls = value
					.split(/[\n,]/)
					.map((url) => url.trim())
					.filter(Boolean);
				if (urls.length > 0) cleaned[key] = urls;
				continue;
			}
			cleaned[key] = value;
		}
		requestOptions.body = cleaned;
	}
	return requestOptions;
}

interface NgramApiErrorBody {
	error?: {
		message?: string;
		/** A rejected request body lists each invalid field as `{ path, message }`. */
		details?: { issues?: Array<{ path?: unknown; message?: unknown }> };
	};
}

/**
 * The create operations ask n8n not to throw on HTTP errors so this hook can
 * report the API's own message (e.g. a paid plan is required, the model is
 * unavailable) as the error itself. n8n's default would headline a 403 as
 * "Forbidden - perhaps check your credentials?", which misdirects a Free
 * account whose key is valid.
 */
export async function throwApiErrorPostReceive(
	this: IExecuteSingleFunctions,
	items: INodeExecutionData[],
	response: IN8nHttpFullResponse,
): Promise<INodeExecutionData[]> {
	if (response.statusCode < 400) return items;
	const body = (
		response.body && typeof response.body === 'object' ? response.body : {}
	) as NgramApiErrorBody;
	const issues = (body.error?.details?.issues ?? []).flatMap((issue) =>
		typeof issue?.message === 'string'
			? [typeof issue.path === 'string' && issue.path ? `${issue.path}: ${issue.message}` : issue.message]
			: [],
	);
	const apiMessage = body.error?.message ?? `The ngram API returned HTTP ${response.statusCode}`;
	throw new NodeApiError(this.getNode(), body as unknown as JsonObject, {
		message: issues.length > 0 ? `${apiMessage}: ${issues.join('; ')}` : apiMessage,
		httpCode: String(response.statusCode),
	});
}

/**
 * Flatten the Get Status response to the Zapier-parity shape before returning
 * items downstream. Runs as a declarative postReceive hook so the raw
 * {success, data: {...}} envelope is unwrapped and the nested `result` is
 * hoisted to top-level `video_url` / `duration_ms`.
 */
async function flattenStatusPostReceive(
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
		displayName: 'ngram',
		name: 'ngram',
		icon: 'file:../../icons/ngram.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{ $parameter["operation"] }}: {{ $parameter["resource"] }}',
		description: 'Generate AI videos from prompts, text, and URLs, then check render status.',
		defaults: {
			name: 'ngram',
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
						name: 'Create From Text',
						value: 'createFromText',
						action: 'Create a video from text',
						description:
							'Submit a new video job from a text prompt. Returns immediately; chain the "On Video Ready" trigger or Get Status for the final URL.',
						routing: {
							request: {
								method: 'POST',
								url: '/api/v1/videos:fromText',
								ignoreHttpStatusErrors: true,
							},
							send: {
								preSend: [stripEmptyBodyFields],
							},
							output: {
								postReceive: [
									throwApiErrorPostReceive,
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
								ignoreHttpStatusErrors: true,
							},
							send: {
								preSend: [stripEmptyBodyFields],
							},
							output: {
								postReceive: [
									throwApiErrorPostReceive,
									{
										type: 'rootProperty',
										properties: { property: 'data' },
									},
								],
							},
						},
					},
					{
						name: 'Create Video',
						value: 'create',
						action: 'Create a video',
						description:
							'Submit a video brief with optional brand context. Returns immediately; chain the "On Video Ready" trigger or Get Status for the final URL.',
						routing: {
							request: {
								method: 'POST',
								url: '/api/v1/videos',
								ignoreHttpStatusErrors: true,
							},
							send: {
								preSend: [stripEmptyBodyFields],
							},
							output: {
								postReceive: [
									throwApiErrorPostReceive,
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
				description:
					'Describe the video you want ngram to create. Image URLs in this text are not treated as uploaded image assets.',
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
				description: 'Optional direction for how ngram should use the URL',
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
				description: 'Optional website ngram can use for brand, product, or company context',
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
				description: 'Page, article, product page, or doc ngram should research and turn into a video',
				displayOptions: {
					show: { resource: ['video'], operation: ['createFromUrl'] },
				},
				routing: { send: { type: 'body', property: 'website_url' } },
			},
			{
				displayName: 'Model Name or ID',
				name: 'director_model',
				type: 'options',
				description:
					'The AI model that makes the video. Leave empty to use your account\'s default model. The price depends on the model chosen (credits per second shown in the Model list). Creating videos through the API needs a paid ngram plan. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listModels' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'director_model' } },
			},
			{
				displayName: 'Voice Name or ID',
				name: 'voice_id',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'listVoices' },
				default: '',
				description:
					'The narrator. Leave empty to let ngram choose, or pick No voiceover for a silent video. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'voice_id' } },
			},
			{
				displayName: 'Style Name or ID',
				name: 'style_id',
				type: 'options',
				description:
					'The look of the video. Auto (the default) lets ngram choose. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listStyles' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
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
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'aspect_ratio' } },
			},
			{
				displayName: 'Duration Name or ID',
				name: 'duration',
				type: 'options',
				description:
					'Length in seconds. Pick a suggested length, or use an expression for any length of at least 1 second; leave empty to let ngram choose (Auto). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listDurations' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'duration' } },
			},
			{
				displayName: 'Energy Name or ID',
				name: 'energy_level',
				type: 'options',
				description:
					'The pace of the video. Defaults to Balanced. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listEnergyLevels' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'energy_level' } },
			},
			{
				displayName: 'Mood Name or ID',
				name: 'mood',
				type: 'options',
				description:
					'The emotional tone. Auto (the default) lets ngram choose. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listMoods' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'mood' } },
			},
			{
				displayName: 'Narration Language Name or ID',
				name: 'voice_language',
				type: 'options',
				description:
					'The language the narration is spoken in. Leave empty to match the prompt. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listVoiceLanguages' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'voice_language' } },
			},
			{
				displayName: 'Brand Kit Name or ID',
				name: 'brand_kit',
				type: 'options',
				description:
					'Apply one of your Brand Kits (colors, fonts, and logo). Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
				typeOptions: { loadOptionsMethod: 'listBrandKits' },
				default: '',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'brand_kit' } },
			},
			{
				displayName: 'Video Format',
				name: 'video_format',
				type: 'options',
				options: [
					{ name: 'Short Video', value: 'short' },
					{ name: 'Use API Default', value: '' },
					{ name: 'Video', value: 'video' },
				],
				default: '',
				description: 'Defaults to Video. Short Video makes a video without narration.',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'video_format' } },
			},
			{
				displayName: 'Image URLs',
				name: 'image_urls',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description:
					'Public image URLs, one per line. These are ingested as video sources rather than prompt text.',
				displayOptions: SHOW_ON_CREATE,
				routing: { send: { type: 'body', property: 'image_urls' } },
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
			// The models API callers can choose, labelled with their live rate.
			async listModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return (data.v2_creation?.directors ?? []).map((director) => ({
					name: `${director.label} — ${director.credits_per_second} credits/sec`,
					value: director.id,
				}));
			},
			async listVoices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.voices.map((voice) => ({
					name: `${voice.name} (${voice.provider})`,
					value: voice.id,
				}));
			},
			async listStyles(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.styles.map((style) => ({
					name: style.label,
					value: style.id,
					...(style.description ? { description: style.description } : {}),
				}));
			},
			async listDurations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return data.durations.map((seconds) => ({
					name: `${seconds} seconds`,
					value: seconds,
				}));
			},
			async listEnergyLevels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return (data.energy_levels ?? []).map(toOption);
			},
			async listMoods(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return (data.moods ?? []).map(toOption);
			},
			async listVoiceLanguages(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const data = await loadConfig.call(this);
				return (data.voice_languages ?? []).map((language) => ({
					name: language.label,
					value: language.code,
				}));
			},
			async listBrandKits(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = (await ngramRequest.call(this, {
					method: 'GET',
					url: '/api/v1/brand-kits',
				})) as { data: { brand_kits?: Array<{ id: string; name: string; is_default: boolean }> } };
				return (response.data.brand_kits ?? []).map((kit) => ({
					name: kit.is_default ? `${kit.name} (default)` : kit.name,
					value: kit.id,
				}));
			},
		},
	};
}
