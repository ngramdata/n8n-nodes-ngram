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
// The same rule for the other ids that land in a path or body.
const LOCALIZATION_ID_PATTERN = /^loc_[A-Za-z0-9_-]+$/;
const ASSET_ID_PATTERN = /^ast_[A-Za-z0-9_-]+$/;
const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$/;
/** The most languages one localization request takes. */
export const MAX_LOCALIZATION_LANGUAGES = 20;

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

/** Keep repeated deliveries of one source event on the API's existing job. */
export async function normalizeIdempotencyKey(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const value = this.getNodeParameter('idempotency_key', '');
	if (value === undefined || value === null || value === '') return requestOptions;
	if (typeof value !== 'string' || value.trim().length > 128 || /[\r\n]/.test(value)) {
		throw new NodeOperationError(this.getNode(), 'Idempotency Key must be text of at most 128 characters without line breaks.');
	}
	const key = value.trim();
	if (key) requestOptions.headers = { ...requestOptions.headers, 'Idempotency-Key': key };
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

function requireId(
	ctx: IExecuteSingleFunctions,
	parameter: string,
	pattern: RegExp,
	label: string,
	example: string,
): string {
	const value = String(ctx.getNodeParameter(parameter) ?? '').trim();
	if (!pattern.test(value)) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Invalid ${label}: ${JSON.stringify(value)} — expected a value like "${example}".`,
		);
	}
	return value;
}

/** Comma- or newline-separated language codes, as the API takes them (e.g. "es, pt-br, ja"). */
export function parseLanguages(ctx: IExecuteSingleFunctions): string[] {
	const raw = ctx.getNodeParameter('languages');
	const listed = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[\n,]/))
		.map((code) => code.trim().toLowerCase().replace(/_/g, '-'))
		.filter(Boolean);
	const invalid = listed.filter((code) => !LANGUAGE_CODE_PATTERN.test(code));
	if (invalid.length > 0) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Invalid language code: ${invalid.join(', ')} — use codes such as "es", "fr" or "pt-br".`,
		);
	}
	const languages = [...new Set(listed)];
	if (languages.length === 0 || languages.length > MAX_LOCALIZATION_LANGUAGES) {
		throw new NodeOperationError(
			ctx.getNode(),
			`List between 1 and ${MAX_LOCALIZATION_LANGUAGES} languages.`,
		);
	}
	return languages;
}

/**
 * A localization spends credits, so ngram requires an Idempotency-Key: a retry with the same key returns the same
 * localization and never bills a language twice. A quote changes nothing and needs none.
 */
function withIdempotencyKey(
	ctx: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
	quote: boolean,
): IHttpRequestOptions {
	if (quote) return requestOptions;
	const key = String(ctx.getNodeParameter('idempotencyKey', '') ?? '').trim();
	if (!key || key.length > 128) {
		throw new NodeOperationError(
			ctx.getNode(),
			'Set an Idempotency Key (up to 128 characters). Reuse it to retry without being charged twice.',
		);
	}
	requestOptions.headers = { ...(requestOptions.headers ?? {}), 'Idempotency-Key': key };
	return requestOptions;
}

/** POST /api/v1/videos/{id}:localize — one translated copy per language, or a dub of the audio only. */
export async function buildLocalizeVideoRequest(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const videoId = requireId(this, 'videoId', VIDEO_ID_PATTERN, 'video ID', 'vid_...');
	const languages = parseLanguages(this);
	const quote = this.getNodeParameter('quoteOnly', false) === true;
	const audioOnly = this.getNodeParameter('localizeMode', 'translate') === 'dub';
	requestOptions.url = `/api/v1/videos/${encodeURIComponent(videoId)}:localize`;
	requestOptions.body = {
		languages,
		...(audioOnly ? { lip_sync: false } : {}),
		...(quote ? { quote: true } : {}),
	};
	return withIdempotencyKey(this, requestOptions, quote);
}

/** POST /api/v1/localizations — dub an uploaded video or a YouTube/TikTok link into each language. */
export async function buildLocalizeMediaRequest(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const fromLink = this.getNodeParameter('sourceType', 'asset') === 'link';
	const source = fromLink
		? { link: String(this.getNodeParameter('sourceLink') ?? '').trim() }
		: { asset_id: requireId(this, 'assetId', ASSET_ID_PATTERN, 'asset ID', 'ast_...') };
	if (fromLink && !/^https:\/\//i.test(source.link ?? '')) {
		throw new NodeOperationError(this.getNode(), 'Enter the video link, starting with https://.');
	}
	const languages = parseLanguages(this);
	const quote = this.getNodeParameter('quoteOnly', false) === true;
	const sourceLanguage = String(this.getNodeParameter('sourceLanguage', '') ?? '').trim().toLowerCase();
	requestOptions.url = '/api/v1/localizations';
	requestOptions.body = {
		source,
		languages,
		...(sourceLanguage ? { source_language: sourceLanguage } : {}),
		...(this.getNodeParameter('lipSync', false) === true ? { lip_sync: true } : {}),
		...(fromLink && this.getNodeParameter('confirmRights', false) === true ? { confirm_rights: true } : {}),
		...(quote ? { quote: true } : {}),
	};
	return withIdempotencyKey(this, requestOptions, quote);
}

/** GET /api/v1/localizations/{id} */
export async function buildGetLocalizationUrl(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const id = requireId(this, 'localizationId', LOCALIZATION_ID_PATTERN, 'localization ID', 'loc_...');
	requestOptions.url = `/api/v1/localizations/${encodeURIComponent(id)}`;
	return requestOptions;
}

/**
 * POST /api/v1/videos/{id}/exports — free. The same video, resolution and captions return the same export, so running
 * it again reports the export's status and, once ready, its url.
 */
export async function buildExportVideoRequest(
	this: IExecuteSingleFunctions,
	requestOptions: IHttpRequestOptions,
): Promise<IHttpRequestOptions> {
	const videoId = requireId(this, 'videoId', VIDEO_ID_PATTERN, 'video ID', 'vid_...');
	const captions = String(this.getNodeParameter('captions', '') ?? '');
	requestOptions.url = `/api/v1/videos/${encodeURIComponent(videoId)}/exports`;
	requestOptions.body = {
		resolution: String(this.getNodeParameter('resolution', '1080p')),
		...(captions ? { captions } : {}),
	};
	return requestOptions;
}

const API_ERRORS_THEN_DATA = [
	throwApiErrorPostReceive,
	{ type: 'rootProperty' as const, properties: { property: 'data' } },
];

const SHOW_ON_LOCALIZE = {
	show: { resource: ['video'], operation: ['localizeVideo', 'localizeMedia'] },
};

export class Ngram implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ngram',
		name: 'ngram',
		icon: 'file:../../icons/ngram.svg',
		group: ['transform'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{ $parameter["operation"] }}: {{ $parameter["resource"] }}',
		description:
			'Generate AI videos from prompts, text, and URLs, check render status, export MP4s and localize videos into other languages.',
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
								preSend: [stripEmptyBodyFields, normalizeIdempotencyKey],
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
								preSend: [stripEmptyBodyFields, normalizeIdempotencyKey],
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
								preSend: [stripEmptyBodyFields, normalizeIdempotencyKey],
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
						name: 'Export Video',
						value: 'exportVideo',
						action: 'Export a video as an MP4',
						description:
							'Export the newest version of a video as an MP4 at the resolution you choose (free). Run it again with the same settings to see whether the export is ready and get its URL.',
						routing: {
							request: { method: 'POST', url: '/api/v1/videos', ignoreHttpStatusErrors: true },
							send: { preSend: [buildExportVideoRequest] },
							output: { postReceive: API_ERRORS_THEN_DATA },
						},
					},
					{
						name: 'Get Localization',
						value: 'getLocalization',
						action: 'Get localization status',
						description:
							'Look up each language of a localization: its status and, once done, its translated video or dubbed file',
						routing: {
							request: { method: 'GET', url: '/api/v1/localizations', ignoreHttpStatusErrors: true },
							send: { preSend: [buildGetLocalizationUrl] },
							output: { postReceive: API_ERRORS_THEN_DATA },
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
					{
						name: 'Localize Media',
						value: 'localizeMedia',
						action: 'Dub an uploaded video or link',
						description:
							'Dub one of your uploaded videos, or a YouTube or TikTok video you have the rights to, into up to 20 languages in the speakers\' own voices. Spends credits at Video Dubbing prices; follow it with Get Localization.',
						routing: {
							request: { method: 'POST', url: '/api/v1/localizations', ignoreHttpStatusErrors: true },
							send: { preSend: [buildLocalizeMediaRequest] },
							output: { postReceive: API_ERRORS_THEN_DATA },
						},
					},
					{
						name: 'Localize Video',
						value: 'localizeVideo',
						action: 'Localize a video into other languages',
						description:
							'Make a version of an ngram video in up to 20 languages: a new translated video per language, or a dub of the audio only. Spends credits per language; follow it with Get Localization.',
						routing: {
							request: { method: 'POST', url: '/api/v1/videos', ignoreHttpStatusErrors: true },
							send: { preSend: [buildLocalizeVideoRequest] },
							output: { postReceive: API_ERRORS_THEN_DATA },
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

			{
				displayName: 'Idempotency Key',
				name: 'idempotency_key',
				type: 'string',
				default: '',
				description: 'A stable key for one source event, up to 128 characters. Reusing the key returns the original job. Use a new key for a new video; leave blank for independent runs.',
				displayOptions: SHOW_ON_CREATE,
			},

			// ---------- Get Status, Export Video and Localize Video fields ----------
			{
				displayName: 'Video ID',
				name: 'videoId',
				type: 'string',
				required: true,
				default: '',
				description: 'The vid_... ID returned by Create Video.',
				displayOptions: {
					show: { resource: ['video'], operation: ['getStatus', 'exportVideo', 'localizeVideo'] },
				},
			},

			// ---------- Export Video fields ----------
			{
				displayName: 'Resolution',
				name: 'resolution',
				type: 'options',
				options: [
					{ name: '1080p', value: '1080p' },
					{ name: '2K', value: '2k' },
					{ name: '4K', value: '4k' },
					{ name: '720p', value: '720p' },
				],
				default: '1080p',
				description:
					'The MP4\'s resolution. Your ngram plan sets which ones you can export; another is refused with the allowed list.',
				displayOptions: { show: { resource: ['video'], operation: ['exportVideo'] } },
			},
			{
				displayName: 'Captions',
				name: 'captions',
				type: 'options',
				options: [
					{ name: 'Burned In', value: 'burned' },
					{ name: 'None', value: 'none' },
					{ name: 'Use the Video\'s Setting', value: '' },
				],
				default: '',
				displayOptions: { show: { resource: ['video'], operation: ['exportVideo'] } },
			},

			// ---------- Localize fields ----------
			{
				displayName: 'Mode',
				name: 'localizeMode',
				type: 'options',
				options: [
					{
						name: 'Dub the Audio Only',
						value: 'dub',
						description:
							'Keep the finished video\'s visuals and replace only its narration, one dubbed MP4 per language, at Video Dubbing prices',
					},
					{
						name: 'New Video per Language',
						value: 'translate',
						description:
							'A translated copy of the video per language, keeping its scenes and presenter (lip-synced)',
					},
				],
				default: 'translate',
				displayOptions: { show: { resource: ['video'], operation: ['localizeVideo'] } },
			},
			{
				displayName: 'Source',
				name: 'sourceType',
				type: 'options',
				options: [
					{ name: 'Uploaded Video', value: 'asset' },
					{ name: 'YouTube or TikTok Link', value: 'link' },
				],
				default: 'asset',
				displayOptions: { show: { resource: ['video'], operation: ['localizeMedia'] } },
			},
			{
				displayName: 'Asset ID',
				name: 'assetId',
				type: 'string',
				required: true,
				default: '',
				description: 'The ast_... ID of a video you uploaded to ngram.',
				displayOptions: {
					show: { resource: ['video'], operation: ['localizeMedia'], sourceType: ['asset'] },
				},
			},
			{
				displayName: 'Video Link',
				name: 'sourceLink',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://www.youtube.com/watch?v=...',
				displayOptions: {
					show: { resource: ['video'], operation: ['localizeMedia'], sourceType: ['link'] },
				},
			},
			{
				displayName: 'I Have the Right to Dub This Video',
				name: 'confirmRights',
				type: 'boolean',
				default: false,
				description: 'Whether you confirm you may dub the linked video. ngram refuses a link without it.',
				displayOptions: {
					show: { resource: ['video'], operation: ['localizeMedia'], sourceType: ['link'] },
				},
			},
			{
				displayName: 'Languages',
				name: 'languages',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'es, fr, pt-br',
				description: 'Up to 20 language codes, separated by commas or new lines',
				displayOptions: SHOW_ON_LOCALIZE,
			},
			{
				displayName: 'Spoken Language',
				name: 'sourceLanguage',
				type: 'string',
				default: '',
				placeholder: 'en',
				description: 'The language spoken in the video. Leave empty to detect it.',
				displayOptions: { show: { resource: ['video'], operation: ['localizeMedia'] } },
			},
			{
				displayName: 'Lip Sync',
				name: 'lipSync',
				type: 'boolean',
				default: false,
				description:
					'Whether to re-animate the speakers\' lips to each language (videos up to 30 minutes, at Lip Sync prices on top)',
				displayOptions: { show: { resource: ['video'], operation: ['localizeMedia'] } },
			},
			{
				displayName: 'Quote Only',
				name: 'quoteOnly',
				type: 'boolean',
				default: false,
				description:
					'Whether to return the expected credits for each language and make nothing',
				displayOptions: SHOW_ON_LOCALIZE,
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '={{ $execution.id + "-" + $itemIndex }}',
				description:
					'A retry with the same key returns the same localization and never charges a language twice. The default is unique to this run and item.',
				displayOptions: SHOW_ON_LOCALIZE,
			},

			// ---------- Get Localization fields ----------
			{
				displayName: 'Localization ID',
				name: 'localizationId',
				type: 'string',
				required: true,
				default: '',
				description: 'The loc_... ID returned by Localize Video or Localize Media.',
				displayOptions: { show: { resource: ['video'], operation: ['getLocalization'] } },
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
