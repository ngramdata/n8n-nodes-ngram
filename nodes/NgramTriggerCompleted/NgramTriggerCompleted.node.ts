import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookResponseData,
} from 'n8n-workflow';
import { buildWebhookMethods, webhookReceive } from '../../src/trigger/subscriptionLifecycle';

export class NgramTriggerCompleted implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ngram: On Video Ready',
		name: 'ngramTriggerCompleted',
		icon: 'file:../../icons/ngram.svg',
		group: ['trigger'],
		version: 1,
		usableAsTool: true,
		subtitle: 'video.completed',
		description: 'Starts a workflow when an ngram video finishes rendering.',
		defaults: {
			name: 'ngram: On Video Ready',
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
				path: 'ngram-video-ready',
			},
		],
		properties: [],
	};

	webhookMethods = buildWebhookMethods('video.completed');

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		return webhookReceive.call(this);
	}
}
