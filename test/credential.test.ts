import { describe, expect, it } from 'vitest';
import { NgramApi } from '../credentials/NgramApi.credentials';

describe('NgramApi credential', () => {
	const credential = new NgramApi();

	it('is identified as ngramApi', () => {
		expect(credential.name).toBe('ngramApi');
		expect(credential.displayName).toBe('Ngram API');
	});

	it('exposes apiKey and baseUrl properties with the expected shape', () => {
		const apiKey = credential.properties.find((p) => p.name === 'apiKey');
		expect(apiKey).toBeDefined();
		expect(apiKey?.type).toBe('string');
		expect(apiKey?.required).toBe(true);
		expect(apiKey?.typeOptions).toMatchObject({ password: true });

		const baseUrl = credential.properties.find((p) => p.name === 'baseUrl');
		expect(baseUrl).toBeDefined();
		expect(baseUrl?.default).toBe('https://www.ngram.com');
	});

	it('sends the API key as a Bearer token via generic authentication', () => {
		expect(credential.authenticate).toMatchObject({
			type: 'generic',
			properties: {
				headers: {
					Authorization: '=Bearer {{$credentials.apiKey}}',
				},
			},
		});
	});

	it('tests against /api/v1/account using the credential baseUrl', () => {
		expect(credential.test).toMatchObject({
			request: {
				baseURL: '={{$credentials.baseUrl}}',
				url: '/api/v1/account',
				method: 'GET',
			},
		});
	});
});
