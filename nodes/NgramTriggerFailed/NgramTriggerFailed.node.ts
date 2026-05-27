import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { buildWebhookMethods, webhookReceive } from '../../src/trigger/subscriptionLifecycle';

export class NgramTriggerFailed implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Ngram: On Video Failed',
		name: 'ngramTriggerFailed',
		icon: 'file:../../icons/ngram.svg',
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: 'video.failed',
		description: 'Starts a workflow when an Ngram video fails.',
		defaults: {
			name: 'Ngram: On Video Failed',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'ngramApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'ngram-video-failed',
			},
		],
		properties: [],
	};

	webhookMethods = buildWebhookMethods('video.failed');

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return webhookReceive.call(this);
	}
}
