import type {
	IHookFunctions,
	INodeExecutionData,
	IWebhookFunctions,
	IWebhookResponseData,
	IDataObject,
} from 'n8n-workflow';
import {
	isCompletedWebhookPayload,
	isFailedWebhookPayload,
	mapWebhookPayload,
} from '../output/mapVideoStatus';
import { ngramRequest } from '../transport/ngramRequest';

export type EventType = 'video.completed' | 'video.failed';

interface ListItem {
	id: string;
	event_type: string;
	target_url: string;
	created_at: string;
}

interface ListResponse {
	data: ListItem[];
}

interface CreateResponse {
	data: {
		id: string;
		event_type: string;
		target_url: string;
		secret: string;
		created_at: string;
	};
}

/**
 * Shared webhook lifecycle for the two Ngram triggers (On Video Ready /
 * On Video Failed). The backend subscription API is event-type scoped, so each
 * trigger instance only ever needs to worry about its own event_type.
 *
 * Reconciliation strategy (deterministic, orphan-free):
 * - checkExists: GET the user's subscriptions, match (event_type, target_url).
 * - create: POST only when no match already exists.
 * - delete: DELETE the stored id if any, then sweep any residual rows that
 *   match (event_type, target_url) to clean up stale duplicates left behind
 *   by prior n8n installs or manual admin actions.
 *
 * See docs/api/public-api-v1.md for the endpoint contracts.
 */
export function buildWebhookMethods(eventType: EventType) {
	return {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const staticData = this.getWorkflowStaticData('node');

				// Intentionally let transient errors bubble out of checkExists: n8n's
				// activation flow treats a throw here as a fail-activation signal,
				// which is the correct outcome when we can't confirm whether a
				// matching subscription already exists — otherwise we'd risk
				// duplicate subscriptions firing twice.
				const response = (await ngramRequest.call(this, {
					method: 'GET',
					url: '/api/v1/webhooks/subscriptions',
				})) as ListResponse;

				const match = response.data.find(
					(row) => row.event_type === eventType && row.target_url === webhookUrl,
				);

				if (match) {
					staticData.subscriptionId = match.id;
					// The list endpoint does not return `secret`, so any secret we
					// might have cached previously may belong to a different
					// subscription row (e.g. orphan cleanup, manual admin action).
					// Drop it rather than carry stale data forward — a future HMAC
					// verification feature will need to re-derive the secret or
					// require users to re-create the trigger.
					delete staticData.subscriptionSecret;
					return true;
				}

				delete staticData.subscriptionId;
				delete staticData.subscriptionSecret;
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const staticData = this.getWorkflowStaticData('node');

				const response = (await ngramRequest.call(this, {
					method: 'POST',
					url: '/api/v1/webhooks/subscriptions',
					body: {
						event_type: eventType,
						target_url: webhookUrl,
					},
				})) as CreateResponse;

				staticData.subscriptionId = response.data.id;
				staticData.subscriptionSecret = response.data.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const staticData = this.getWorkflowStaticData('node');
				const storedId = staticData.subscriptionId as string | undefined;

				// The `delete` hook cannot throw — a throw here would leave n8n
				// unable to deactivate the workflow. We log and continue so server
				// logs retain enough context to debug orphaned subscriptions (e.g.
				// after an API key rotation that silently 401s every cleanup call).
				if (storedId) {
					try {
						await ngramRequest.call(this, {
							method: 'DELETE',
							url: `/api/v1/webhooks/subscriptions/${storedId}`,
						});
					} catch (error) {
						this.logger.warn(
							'Ngram trigger: failed to delete stored subscription during cleanup',
							{ error: String(error), eventType, webhookUrl, subscriptionId: storedId },
						);
					}
				}

				// Sweep residual rows matching (event_type, target_url). Covers the
				// case where workflowStaticData was cleared while live subscriptions
				// still exist server-side, or where a previous install left an orphan.
				try {
					const list = (await ngramRequest.call(this, {
						method: 'GET',
						url: '/api/v1/webhooks/subscriptions',
					})) as ListResponse;

					const orphans = list.data.filter(
						(row) => row.event_type === eventType && row.target_url === webhookUrl,
					);
					for (const row of orphans) {
						try {
							await ngramRequest.call(this, {
								method: 'DELETE',
								url: `/api/v1/webhooks/subscriptions/${row.id}`,
							});
						} catch (error) {
							this.logger.warn(
								'Ngram trigger: failed to delete orphan subscription during sweep',
								{
									error: String(error),
									eventType,
									webhookUrl,
									subscriptionId: row.id,
								},
							);
						}
					}
				} catch (error) {
					this.logger.warn('Ngram trigger: orphan-sweep list call failed', {
						error: String(error),
						eventType,
						webhookUrl,
					});
				}

				delete staticData.subscriptionId;
				delete staticData.subscriptionSecret;
				return true;
			},
		},
	};
}

/**
 * Handler invoked when our backend POSTs a video.completed or video.failed
 * payload to the n8n-managed URL. Flattens the raw event body into the same
 * shape the Get Status action emits — so downstream nodes that reference
 * `video_url` / `duration_ms` / `error_message` work identically whether the
 * upstream is a trigger or an action.
 *
 * We preserve the raw payload under `_raw` for users who need access to the
 * unflattened event body (HMAC verification, future event-type additions).
 *
 * A malformed or malicious POST (e.g. `event: "video.completed"` with no
 * `result`) is NOT flattened — the raw body passes through unchanged so the
 * trigger stays up and a downstream node can inspect what arrived.
 */
export async function webhookReceive(this: IWebhookFunctions): Promise<IWebhookResponseData> {
	const rawBody = this.getBodyData() as IDataObject;

	const json =
		isCompletedWebhookPayload(rawBody) || isFailedWebhookPayload(rawBody)
			? ({ ...mapWebhookPayload(rawBody), _raw: rawBody } as IDataObject)
			: rawBody;

	const items: INodeExecutionData[] = [{ json }];
	return { workflowData: [items] };
}
