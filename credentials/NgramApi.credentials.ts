import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class NgramApi implements ICredentialType {
	name = 'ngramApi';

	displayName = 'Ngram API';

	icon: Icon = 'file:../icons/ngram.svg';

	documentationUrl = 'https://www.ngram.com/docs/n8n';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Generate a key at https://www.ngram.com/app/settings/api-keys. Starts with "ngs_".',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://www.ngram.com',
			description:
				'Override to point at staging or a preview deployment. Leave as the default for production.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/account',
			method: 'GET',
		},
	};
}
