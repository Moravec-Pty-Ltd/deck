import { describe, expect, it } from 'vitest';
import {
	accountDir,
	accountEnv,
	accountNameProblem,
	linkAction,
	loginCommand,
	notReadyReason,
	parseAccount,
	sessionEnv,
	settingsCredentials
} from './accounts-core';
import type { ClaudeAccount } from '$lib/types';

const login: ClaudeAccount = { name: 'acme', kind: 'login' };
const api: ClaudeAccount = { name: 'acme-api', kind: 'api' };

describe('accountNameProblem', () => {
	it('accepts a plain name', () => {
		expect(accountNameProblem('acme-work_2')).toBeNull();
	});

	it('refuses path tricks, blanks and the built-in name', () => {
		for (const bad of ['', '../x', 'a/b', '.hidden', 'default', 'Default', 42]) {
			expect(accountNameProblem(bad)).not.toBeNull();
		}
	});
});

describe('accountEnv', () => {
	// What deck's own environment might hold.
	const inherited = [
		'PATH',
		'HOME',
		'ANTHROPIC_API_KEY',
		'ANTHROPIC_FOUNDRY_BASE_URL',
		'CLAUDE_CODE_OAUTH_TOKEN',
		'CLAUDE_CODE_USE_BEDROCK',
		'AWS_DEFAULT_PROFILE',
		'AWS_CONTAINER_CREDENTIALS_FULL_URI',
		'GOOGLE_CLOUD_PROJECT',
		'CLOUD_ML_REGION'
	];

	it('points a login account at its own config and drops every inherited credential', () => {
		const env = accountEnv(login, '/data/claude-accounts/acme', undefined, inherited);
		expect(env).toEqual({
			CLAUDE_CONFIG_DIR: '/data/claude-accounts/acme',
			...Object.fromEntries(inherited.slice(2).map((k) => [k, undefined]))
		});
	});

	it('gives an API account its key and settings, and its own config', () => {
		const env = accountEnv({ ...api, env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'acme' } }, '/d', 'k', inherited);
		expect(env).toMatchObject({
			CLAUDE_CONFIG_DIR: '/d',
			ANTHROPIC_API_KEY: 'k',
			CLAUDE_CODE_USE_BEDROCK: '1',
			AWS_PROFILE: 'acme',
			AWS_DEFAULT_PROFILE: undefined
		});
	});

	it('keeps its own config directory over anything in the account env', () => {
		const env = accountEnv({ ...api, env: { CLAUDE_CONFIG_DIR: '/home/me/.claude' } }, '/d', 'k', []);
		expect(env.CLAUDE_CONFIG_DIR).toBe('/d');
	});

	it('prefers the stored key over one in the account env', () => {
		expect(accountEnv({ ...api, env: { ANTHROPIC_API_KEY: 'env' } }, '/d', 'stored', []).ANTHROPIC_API_KEY).toBe(
			'stored'
		);
	});

	it('passes other account settings through', () => {
		expect(accountEnv({ ...api, env: { HTTPS_PROXY: 'http://proxy.example' } }, '/d', 'k', []).HTTPS_PROXY).toBe(
			'http://proxy.example'
		);
	});

	it('never hands a login account a stored key or its env', () => {
		const env = accountEnv({ ...login, env: { ANTHROPIC_API_KEY: 'stale' } }, '/d', 'k', []);
		expect(env).toEqual({ CLAUDE_CONFIG_DIR: '/d' });
	});
});

describe('sessionEnv', () => {
	const account = { CLAUDE_CONFIG_DIR: '/d', ANTHROPIC_API_KEY: 'client', AWS_PROFILE: undefined };

	it('leaves Default sessions as they were', () => {
		expect(sessionEnv(undefined, undefined)).toBeUndefined();
		expect(sessionEnv(undefined, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000' })).toEqual({
			ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000'
		});
		expect(sessionEnv(account, undefined)).toEqual(account);
	});

	it("keeps an account's key away from a model profile's backend", () => {
		const env = sessionEnv(account, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000' });
		expect(env).toEqual({
			CLAUDE_CONFIG_DIR: '/d',
			ANTHROPIC_API_KEY: undefined,
			ANTHROPIC_AUTH_TOKEN: undefined,
			AWS_PROFILE: undefined,
			ANTHROPIC_BASE_URL: 'http://127.0.0.1:3000'
		});
		expect(sessionEnv(account, { ANTHROPIC_AUTH_TOKEN: 'local' })?.ANTHROPIC_AUTH_TOKEN).toBe('local');
	});
});

describe('notReadyReason', () => {
	it('names a missing account', () => {
		expect(notReadyReason('gone', undefined, {})).toBe('Account gone does not exist');
	});

	it('runs a login account only on its own login', () => {
		expect(notReadyReason('acme', login, { authMethod: 'none' })).toBe('Account acme is not logged in');
		expect(notReadyReason('acme', login, {})).toBe('Account acme is not logged in');
		expect(notReadyReason('acme', login, { authMethod: 'claude.ai' })).toBeNull();
		expect(notReadyReason('acme', login, { authMethod: 'console' })).toBeNull();
		// Credentials from anywhere but its own login, such as a helper in shared settings.
		for (const authMethod of ['api_key_helper', 'oauth_token', 'api_key', 'third_party']) {
			expect(notReadyReason('acme', login, { authMethod })).toBe('Account acme is not logged in');
		}
	});

	it('needs a stored key or a credential of its own for an API account', () => {
		const withEnv = (env: Record<string, string>) => notReadyReason('acme-api', { ...api, env }, {});
		expect(notReadyReason('acme-api', api, {})).toBe('Account acme-api has no API key');
		expect(withEnv({ ANTHROPIC_MODEL: 'x' })).toBe('Account acme-api has no API key');
		// A provider switch alone would run on the machine's own cloud identity.
		expect(withEnv({ CLAUDE_CODE_USE_VERTEX: '1' })).toMatch(/sets none of GOOGLE_APPLICATION_CREDENTIALS/);
		expect(withEnv({ AWS_PROFILE: ' ' })).toBe('Account acme-api has no API key');
		expect(notReadyReason('acme-api', api, { apiKey: true })).toBeNull();
		expect(withEnv({ CLAUDE_CODE_USE_VERTEX: '1', GOOGLE_APPLICATION_CREDENTIALS: '/p/key.json' })).toBeNull();
		expect(withEnv({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'acme' })).toBeNull();
		expect(withEnv({ ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 't' })).toBeNull();
		// A switched-on provider needs its own credential; an Anthropic key does not stand in.
		expect(notReadyReason('acme-api', { ...api, env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, { apiKey: true })).toMatch(
			/^Account acme-api turns on CLAUDE_CODE_USE_BEDROCK but sets none of AWS_PROFILE/
		);
		expect(withEnv({ CLAUDE_CODE_USE_VERTEX: 'true', ANTHROPIC_AUTH_TOKEN: 't' })).toBe(
			'Account acme-api turns on CLAUDE_CODE_USE_VERTEX but sets none of GOOGLE_APPLICATION_CREDENTIALS'
		);
		expect(withEnv({ CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_API_KEY: 'k' })).toBeNull();
		expect(withEnv({ CLAUDE_CODE_USE_SOMETHING: '1', ANTHROPIC_API_KEY: 'k' })).toBe(
			'Account acme-api turns on CLAUDE_CODE_USE_SOMETHING, which deck cannot check'
		);
		expect(withEnv({ CLAUDE_CODE_USE_BEDROCK: '0', ANTHROPIC_API_KEY: 'k' })).toBeNull();
		expect(notReadyReason('acme-api', { ...api, env: { ANTHROPIC_API_KEY: 1 as unknown as string } }, {})).toBe(
			'Account acme-api has no API key'
		);
	});

	it('refuses a shared settings.json that carries credentials, for either kind', () => {
		const sharedCredentials = ['apiKeyHelper'];
		expect(notReadyReason('acme', login, { authMethod: 'claude.ai', sharedCredentials })).toMatch(/apiKeyHelper/);
		expect(notReadyReason('acme-api', api, { apiKey: true, sharedCredentials })).toMatch(/stop sharing/);
		expect(notReadyReason('acme', login, { authMethod: 'claude.ai', sharedCredentials: [] })).toBeNull();
	});
});

describe('settingsCredentials', () => {
	it('names credential helpers and credential env vars, nothing else', () => {
		expect(
			settingsCredentials({
				apiKeyHelper: 'x',
				model: 'opus',
				env: { ANTHROPIC_API_KEY: 'x', AWS_BEARER_TOKEN_BEDROCK: 'x', CLAUDE_CODE_USE_BEDROCK: '1', DEBUG: '1' }
			})
		).toEqual(['apiKeyHelper', 'env.ANTHROPIC_API_KEY', 'env.AWS_BEARER_TOKEN_BEDROCK', 'env.CLAUDE_CODE_USE_BEDROCK']);
		expect(settingsCredentials({ gcpAuthRefresh: 'x', env: { AWS_PROFILE: 'me' } })).toEqual([
			'gcpAuthRefresh',
			'env.AWS_PROFILE'
		]);
		expect(settingsCredentials({ hooks: {}, env: { DEBUG: '1' } })).toEqual([]);
		expect(settingsCredentials({ env: ['ANTHROPIC_API_KEY'] })).toEqual([]);
		expect(settingsCredentials(null)).toEqual([]);
	});
});

describe('linkAction', () => {
	it('links a shared part that exists in the default config', () => {
		expect(linkAction(true, 'missing', true)).toBe('link');
		expect(linkAction(true, 'missing', false)).toBeNull();
		expect(linkAction(true, 'ours', true)).toBeNull();
	});

	it('removes only its own link when a part stops being shared', () => {
		expect(linkAction(false, 'ours', true)).toBe('unlink');
		expect(linkAction(false, 'other', true)).toBeNull();
		expect(linkAction(true, 'other', true)).toBeNull();
	});
});

describe('paths and commands', () => {
	it('keeps each account under the data directory', () => {
		expect(accountDir('/home/me/.deck', 'acme')).toBe('/home/me/.deck/claude-accounts/acme');
	});

	it('quotes the config directory in the login command', () => {
		expect(loginCommand("/p/it's")).toBe(`CLAUDE_CONFIG_DIR='/p/it'\\''s' claude auth login`);
	});
});

describe('parseAccount', () => {
	it('adds an account with a kind and keeps only known shared parts, once each', () => {
		expect(parseAccount({ name: 'acme', kind: 'login', share: ['skills', 'skills'] }, [])).toEqual({
			account: { name: 'acme', kind: 'login', share: ['skills'] },
			existing: undefined,
			apiKey: undefined
		});
	});

	it('updates over the stored account, keeping what the body leaves out', () => {
		const stored: ClaudeAccount = { ...api, share: ['hooks'], env: { AWS_REGION: 'us-east-1' } };
		expect(parseAccount({ name: 'acme-api', apiKey: ' k ' }, [stored])).toEqual({
			account: stored,
			existing: stored,
			apiKey: 'k'
		});
		expect(parseAccount({ name: 'acme-api', share: [] }, [stored]).account.share).toBeUndefined();
		expect(parseAccount({ name: 'acme-api', apiKey: '' }, [stored]).apiKey).toBe('');
		expect(parseAccount({ name: 'acme-api', apiKey: '  ' }, [stored]).apiKey).toBeUndefined();
	});

	it('refuses a bad name, kind, share or key', () => {
		expect(() => parseAccount({ name: 'acme' }, [])).toThrow('kind');
		expect(() => parseAccount({ name: '../x', kind: 'login' }, [])).toThrow('account name');
		expect(() => parseAccount({ name: 'acme', kind: 'login', share: ['.ssh'] }, [])).toThrow('share');
		expect(() => parseAccount({ name: 'acme', kind: 'api', apiKey: 1 }, [])).toThrow('apiKey');
		expect(() => parseAccount({ name: 'acme', kind: 'login', apiKey: 'k' }, [])).toThrow('no API key');
	});

	it('refuses a new name that differs from an existing one only in case', () => {
		expect(() => parseAccount({ name: 'Acme', kind: 'login' }, [login])).toThrow('already exists');
		expect(parseAccount({ name: 'acme', share: ['hooks'] }, [login]).existing).toBe(login);
	});
});
