/**
 * redactEnvironment: strip TLS / Hawser / SSH secrets from an environment before
 * it leaves the server, replacing them with has* booleans.
 */
import { describe, it, expect } from 'bun:test';
import { redactEnvironment } from '../src/lib/server/environment-redact';

describe('redactEnvironment', () => {
	it('removes tlsKey, hawserToken and SSH secrets from the output', () => {
		const out = redactEnvironment({
			id: 1,
			name: 'prod',
			tlsKey: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
			hawserToken: 'super-secret-token',
			sshPassword: 'ssh-pass',
			sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nKEY\n-----END OPENSSH PRIVATE KEY-----',
			sshPassphrase: 'phrase',
			tlsCa: 'CA',
			tlsCert: 'CERT'
		} as any);
		expect('tlsKey' in out).toBe(false);
		expect('hawserToken' in out).toBe(false);
		expect('sshPassword' in out).toBe(false);
		expect('sshPrivateKey' in out).toBe(false);
		expect('sshPassphrase' in out).toBe(false);
		expect(JSON.stringify(out)).not.toContain('SECRET');
		expect(JSON.stringify(out)).not.toContain('super-secret-token');
		expect(JSON.stringify(out)).not.toContain('ssh-pass');
		expect(JSON.stringify(out)).not.toContain('phrase');
	});

	it('sets has* flags true when secrets are present', () => {
		const out = redactEnvironment({
			id: 1,
			name: 'p',
			tlsKey: 'k',
			hawserToken: 't',
			sshPassword: 'p',
			sshPrivateKey: 'k2'
		} as any);
		expect(out.hasTlsKey).toBe(true);
		expect(out.hasHawserToken).toBe(true);
		expect(out.hasSshPassword).toBe(true);
		expect(out.hasSshPrivateKey).toBe(true);
	});

	it('sets the flags false when the secret is null / empty', () => {
		const out = redactEnvironment({
			id: 1,
			name: 'p',
			tlsKey: null,
			hawserToken: '',
			sshPassword: null,
			sshPrivateKey: ''
		} as any);
		expect(out.hasTlsKey).toBe(false);
		expect(out.hasHawserToken).toBe(false);
		expect(out.hasSshPassword).toBe(false);
		expect(out.hasSshPrivateKey).toBe(false);
	});

	it('keeps the public tlsCa / tlsCert and all other fields', () => {
		const out = redactEnvironment({
			id: 7,
			name: 'p',
			tlsCa: 'CA-PUBLIC',
			tlsCert: 'CERT-PUBLIC',
			connectionType: 'direct',
			tlsKey: 'k',
			hawserToken: 't'
		} as any) as any;
		expect(out.tlsCa).toBe('CA-PUBLIC');
		expect(out.tlsCert).toBe('CERT-PUBLIC');
		expect(out.connectionType).toBe('direct');
		expect(out.id).toBe(7);
	});
});
