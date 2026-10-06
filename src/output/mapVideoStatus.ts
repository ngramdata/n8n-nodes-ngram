/**
 * Flatten the public-API video-status envelope (nested `result`, split
 * `error` / `error_code`) into the flat, Zapier-parity shape that users see
 * on the ngram action output and the trigger nodes:
 *
 *     { id, status, progress, video_url, duration_ms, error_code,
 *       error_message, created_at, completed_at, engine, app_url, warnings }
 *
 * `engine`, `app_url`, and newline-joined `warnings` come from the status
 * response; webhook bodies do not carry them, so they are null there.
 *
 * Backend shape is declared in
 * `backend/services/public-api/public-api-responses.ts::VideoStatusResponse`
 * (GET /videos/:id) and
 * `backend/services/webhook-subscriptions.ts::buildPayloadFor` (webhook body).
 *
 * Kept as a pure function so both the declarative action's `postReceive` hook
 * and the programmatic trigger's webhook handler produce identical downstream
 * field names — a user switching between "get status" and "on video ready"
 * can map the same fields in both branches.
 */

export interface FlatVideoOutput {
	id: string;
	status: 'processing' | 'completed' | 'failed';
	progress: number;
	video_url: string | null;
	duration_ms: number | null;
	error_code: string | null;
	error_message: string | null;
	created_at: string;
	completed_at: string | null;
	engine: 'v1' | 'v2' | null;
	app_url: string | null;
	warnings: string | null;
}

interface StatusResponseShape {
	id?: string;
	status?: 'processing' | 'completed' | 'failed';
	progress?: number;
	result?: { url?: string; duration_ms?: number } | null;
	error_code?: string | null;
	error?: string | null;
	created_at?: string;
	completed_at?: string | null;
	engine?: 'v1' | 'v2' | null;
	app_url?: string | null;
	warnings?: unknown;
}

interface CompletedWebhookShape {
	event: 'video.completed';
	video_id: string;
	result: { url: string; duration_ms: number };
	created_at: string;
	completed_at?: string | null;
}

interface FailedWebhookShape {
	event: 'video.failed';
	video_id: string;
	error_code?: string | null;
	error?: string | null;
	created_at: string;
	completed_at?: string | null;
}

export type WebhookPayloadShape = CompletedWebhookShape | FailedWebhookShape;

/**
 * Shape validators used before calling mapWebhookPayload so a malformed or
 * malicious POST (e.g. `event: "video.completed"` with no `result`) doesn't
 * crash the trigger. The mapper itself stays strict — callers decide what to
 * do with invalid bodies (the trigger's webhookReceive falls back to passing
 * the raw payload through unchanged).
 */
export function isCompletedWebhookPayload(payload: unknown): payload is CompletedWebhookShape {
	if (typeof payload !== 'object' || payload === null) return false;
	const obj = payload as Record<string, unknown>;
	if (obj.event !== 'video.completed') return false;
	if (typeof obj.video_id !== 'string') return false;
	if (typeof obj.created_at !== 'string') return false;
	const result = obj.result;
	if (typeof result !== 'object' || result === null) return false;
	const r = result as Record<string, unknown>;
	if (typeof r.url !== 'string') return false;
	if (typeof r.duration_ms !== 'number') return false;
	return true;
}

export function isFailedWebhookPayload(payload: unknown): payload is FailedWebhookShape {
	if (typeof payload !== 'object' || payload === null) return false;
	const obj = payload as Record<string, unknown>;
	if (obj.event !== 'video.failed') return false;
	if (typeof obj.video_id !== 'string') return false;
	if (typeof obj.created_at !== 'string') return false;
	return true;
}

export function mapStatusResponse(data: StatusResponseShape): FlatVideoOutput {
	return {
		id: data.id ?? '',
		status: data.status ?? 'processing',
		progress: typeof data.progress === 'number' ? data.progress : 0,
		video_url: data.result?.url ?? null,
		duration_ms: typeof data.result?.duration_ms === 'number' ? data.result.duration_ms : null,
		error_code: data.error_code ?? null,
		error_message: data.error ?? null,
		created_at: data.created_at ?? '',
		completed_at: data.completed_at ?? null,
		engine: data.engine === 'v1' || data.engine === 'v2' ? data.engine : null,
		app_url: typeof data.app_url === 'string' ? data.app_url : null,
		warnings: joinWarnings(data.warnings),
	};
}

function joinWarnings(warnings: unknown): string | null {
	if (!Array.isArray(warnings)) return null;
	const lines = warnings.filter(
		(warning): warning is string => typeof warning === 'string' && warning.trim().length > 0,
	);
	return lines.length > 0 ? lines.join('\n') : null;
}

const NO_ENGINE_METADATA = { engine: null, app_url: null, warnings: null } as const;

export function mapWebhookPayload(payload: WebhookPayloadShape): FlatVideoOutput {
	if (payload.event === 'video.completed') {
		return {
			id: payload.video_id,
			status: 'completed',
			progress: 100,
			video_url: payload.result.url,
			duration_ms: payload.result.duration_ms,
			error_code: null,
			error_message: null,
			created_at: payload.created_at,
			completed_at: payload.completed_at ?? null,
			...NO_ENGINE_METADATA,
		};
	}

	return {
		id: payload.video_id,
		status: 'failed',
		progress: 0,
		video_url: null,
		duration_ms: null,
		error_code: payload.error_code ?? 'unknown',
		error_message: payload.error ?? 'Video generation failed',
		created_at: payload.created_at,
		completed_at: payload.completed_at ?? null,
		...NO_ENGINE_METADATA,
	};
}
