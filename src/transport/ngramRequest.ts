import type {
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IWebhookFunctions,
} from 'n8n-workflow';

type NgramCapableContext =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IPollFunctions
	| IWebhookFunctions;

interface NgramRequestOptions {
	method: IHttpRequestMethods;
	url: string;
	body?: unknown;
}

/**
 * Thin wrapper around httpRequestWithAuthentication for the Ngram public API.
 *
 * All auth, base-URL interpolation, and bearer-token handling is delegated to
 * the 'ngramApi' credential declared in credentials/NgramApi.credentials.ts.
 * Callers only pass the API path (e.g. '/api/v1/videos') and any body.
 *
 * This helper is used by the trigger nodes (programmatic) and by loadOptions.
 * The main Ngram action node uses declarative `routing` blocks and does not go
 * through this helper.
 */
export async function ngramRequest<T = unknown>(
	this: NgramCapableContext,
	options: NgramRequestOptions,
): Promise<T> {
	const credentials = await this.getCredentials('ngramApi');
	const baseUrl = ((credentials.baseUrl as string | undefined) ?? 'https://www.ngram.com').replace(
		/\/+$/,
		'',
	);

	const requestOptions: IHttpRequestOptions = {
		method: options.method,
		url: `${baseUrl}${options.url}`,
		json: true,
	};

	if (options.body !== undefined) {
		requestOptions.body = options.body;
	}

	return (await this.helpers.httpRequestWithAuthentication.call(
		this,
		'ngramApi',
		requestOptions,
	)) as T;
}
