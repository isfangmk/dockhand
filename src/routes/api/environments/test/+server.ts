import { json } from '@sveltejs/kit';
import { unixSocketRequest, httpsAgentRequest } from '$lib/server/docker';
import type { DockerClientConfig } from '$lib/server/docker';
import { getEnvironment } from '$lib/server/db';
import { authorize } from '$lib/server/authorize';
import { isSafeNotificationUrl } from '$lib/server/url-safety';
import { probeSshDocker } from '$lib/server/ssh-tunnel';
import type { RequestHandler } from './$types';

interface TestConnectionRequest {
	connectionType: 'socket' | 'direct' | 'hawser-standard' | 'hawser-edge' | 'ssh';
	socketPath?: string;
	host?: string;
	port?: number;
	protocol?: string;
	tlsCa?: string;
	tlsCert?: string;
	tlsKey?: string;
	tlsSkipVerify?: boolean;
	hawserToken?: string;
	sshPort?: number;
	sshUsername?: string;
	sshAuthType?: 'password' | 'key';
	sshPassword?: string;
	sshPrivateKey?: string;
	sshPassphrase?: string;
	sshHostKeyFingerprint?: string;
	sshSkipHostKey?: boolean;
	/**
	 * When editing an existing environment, secrets are never sent back to the client,
	 * so an unchanged secret comes through empty. Passing the env id lets the server
	 * fall back to the STORED secret for any blank secret field (#1483).
	 */
	environmentId?: number;
}

function cleanPem(pem: string): string {
	return pem
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.join('\n');
}

function buildDockerClientConfig(config: TestConnectionRequest): DockerClientConfig | null {
	const protocol = config.protocol || 'http';
	if (protocol !== 'https') return null;

	return {
		type: 'https',
		host: config.host || 'localhost',
		port: config.port || 2376,
		ca: config.tlsCa ? cleanPem(config.tlsCa) || undefined : undefined,
		cert: config.tlsCert ? cleanPem(config.tlsCert) || undefined : undefined,
		key: config.tlsKey ? cleanPem(config.tlsKey) || undefined : undefined,
		skipVerify: config.tlsSkipVerify || false
	};
}

/**
 * Test Docker connection with provided configuration (without saving to database)
 *
 * @openapi
 * summary: Test a Docker/Hawser/SSH connection configuration WITHOUT saving it as an environment
 * description: Pass environmentId to fall back to that saved environment's stored secrets for any secret field left blank in the body.
 * body: {connectionType:string!, socketPath:string, host:string, port:integer, protocol:string, tlsCa:string, tlsCert:string, tlsKey:string, tlsSkipVerify:boolean, hawserToken:string, sshPort:integer, sshUsername:string, sshAuthType:string, sshPassword:string, sshPrivateKey:string, sshPassphrase:string, sshSkipHostKey:boolean, environmentId:integer}
 * body-example: {"connectionType":"socket","socketPath":"/var/run/docker.sock"}
 * resp-200: {success:boolean!, info:{serverVersion:string, containers:integer, images:integer, name:string}, hawser:{}, fingerprint:string}
 * resp-400: Host is required for direct/hawser-standard/ssh connection types
 * resp-403: The caller cannot access the environment named by environmentId
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	try {
		const config: TestConnectionRequest = await request.json();

		if (config.environmentId) {
			const auth = await authorize(cookies);
			if (!(await auth.canAccessEnvironment(config.environmentId))) {
				return json({ success: false, error: 'Access denied' }, { status: 403 });
			}
			const stored = await getEnvironment(config.environmentId);
			if (stored) {
				if (!config.hawserToken) config.hawserToken = stored.hawserToken || undefined;
				if (!config.tlsKey) config.tlsKey = stored.tlsKey || undefined;
				if (!config.sshPassword) config.sshPassword = stored.sshPassword || undefined;
				if (!config.sshPrivateKey) config.sshPrivateKey = stored.sshPrivateKey || undefined;
				if (!config.sshPassphrase) config.sshPassphrase = stored.sshPassphrase || undefined;
				if (!config.sshHostKeyFingerprint) {
					config.sshHostKeyFingerprint = stored.sshHostKeyFingerprint || undefined;
				}
			}
		}

		let response: Response;
		let sshFingerprint: string | undefined;

		if (config.connectionType === 'ssh') {
			const host = config.host;
			if (!host) {
				return json({ success: false, error: 'Host is required' }, { status: 400 });
			}
			if (!config.sshUsername) {
				return json({ success: false, error: 'SSH username is required' }, { status: 400 });
			}

			const hostSafety = isSafeNotificationUrl(`http://${host}:${config.sshPort || 22}`);
			if (!hostSafety.ok) {
				return json({ success: false, error: `Host not allowed: ${hostSafety.reason}` }, { status: 200 });
			}

			const { info, fingerprint } = await probeSshDocker({
				host,
				sshPort: config.sshPort || 22,
				sshUsername: config.sshUsername,
				sshAuthType: config.sshAuthType || 'password',
				sshPassword: config.sshPassword,
				sshPrivateKey: config.sshPrivateKey,
				sshPassphrase: config.sshPassphrase,
				sshHostKeyFingerprint: config.sshHostKeyFingerprint,
				sshSkipHostKey: config.sshSkipHostKey,
				socketPath: config.socketPath || '/var/run/docker.sock'
			});
			sshFingerprint = fingerprint;

			return json({
				success: true,
				info: {
					serverVersion: info.ServerVersion,
					containers: info.Containers,
					images: info.Images,
					name: info.Name
				},
				fingerprint: sshFingerprint
			});
		} else if (config.connectionType === 'socket') {
			const socketPath = config.socketPath || '/var/run/docker.sock';
			response = await unixSocketRequest(socketPath, '/info');
		} else if (config.connectionType === 'hawser-edge') {
			return json({
				success: true,
				info: {
					message: 'Edge mode environments are tested when the agent connects'
				},
				isEdgeMode: true
			});
		} else {
			const protocol = config.protocol || 'http';
			const host = config.host;
			const port = config.port || 2375;

			if (!host) {
				return json({ success: false, error: 'Host is required' }, { status: 400 });
			}

			const hostSafety = isSafeNotificationUrl(`${protocol}://${host}:${port}`);
			if (!hostSafety.ok) {
				return json({ success: false, error: `Host not allowed: ${hostSafety.reason}` }, { status: 200 });
			}

			const headers: Record<string, string> = {
				'Content-Type': 'application/json'
			};

			if (config.connectionType === 'hawser-standard' && config.hawserToken) {
				headers['X-Hawser-Token'] = config.hawserToken;
			}

			const tlsConfig = buildDockerClientConfig(config);
			if (tlsConfig) {
				response = await httpsAgentRequest(tlsConfig, '/info', {}, false, headers);
			} else {
				const url = `http://${host}:${port}/info`;
				response = await fetch(url, {
					headers,
					signal: AbortSignal.timeout(10000),
					keepalive: false
				});
			}
		}

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Docker API error: ${response.status} - ${error}`);
		}

		const info = await response.json();

		let hawserInfo = null;
		if (config.connectionType === 'hawser-standard' && config.host) {
			try {
				const hawserHeaders: Record<string, string> = {};
				if (config.hawserToken) {
					hawserHeaders['X-Hawser-Token'] = config.hawserToken;
				}

				let hawserResp: Response;
				const tlsConfig = buildDockerClientConfig(config);
				if (tlsConfig) {
					hawserResp = await httpsAgentRequest(tlsConfig, '/_hawser/info', {}, false, hawserHeaders);
				} else {
					const hawserUrl = `http://${config.host}:${config.port || 2375}/_hawser/info`;
					hawserResp = await fetch(hawserUrl, {
						headers: hawserHeaders,
						signal: AbortSignal.timeout(5000),
						keepalive: false
					});
				}
				if (hawserResp.ok) {
					hawserInfo = await hawserResp.json();
				}
			} catch {
				// Hawser info fetch failed, continue without it
			}
		}

		return json({
			success: true,
			info: {
				serverVersion: info.ServerVersion,
				containers: info.Containers,
				images: info.Images,
				name: info.Name
			},
			hawser: hawserInfo
		});
	} catch (error) {
		const rawMessage = error instanceof Error ? error.message : 'Connection failed';
		console.error('Failed to test connection:', rawMessage);

		let message = rawMessage;
		if (rawMessage.includes('401') || rawMessage.toLowerCase().includes('unauthorized')) {
			message = 'Invalid token - check that the Hawser token matches';
		} else if (rawMessage.includes('403') || rawMessage.toLowerCase().includes('forbidden')) {
			message = 'Access forbidden - check token permissions';
		} else if (rawMessage.includes('ECONNREFUSED') || rawMessage.includes('Connection refused')) {
			message = 'Connection refused - is Docker/Hawser/SSH running?';
		} else if (rawMessage.includes('ETIMEDOUT') || rawMessage.includes('timeout') || rawMessage.includes('Timeout')) {
			message = 'Connection timed out - check host and port';
		} else if (rawMessage.includes('ENOTFOUND') || rawMessage.includes('getaddrinfo')) {
			message = 'Host not found - check the hostname';
		} else if (rawMessage.includes('EHOSTUNREACH')) {
			message = 'Host unreachable - check network connectivity';
		} else if (rawMessage.includes('ENOENT') || rawMessage.includes('no such file')) {
			message = 'Socket not found - check the socket path';
		} else if (rawMessage.includes('EACCES') || rawMessage.includes('permission denied')) {
			message = 'Permission denied - check socket/SSH permissions';
		} else if (rawMessage.includes('host key mismatch')) {
			message = rawMessage;
		} else if (rawMessage.includes('All configured authentication methods failed') || rawMessage.includes('Authentication')) {
			message = 'SSH authentication failed - check username, password, or private key';
		} else if (rawMessage.includes('typo in the url') || rawMessage.includes('Was there a typo')) {
			message = 'Connection failed - check host and port';
		} else if (rawMessage.includes('self signed certificate') || rawMessage.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
			message = 'TLS certificate error - provide CA certificate for self-signed certs';
		} else if (rawMessage.includes('CERT_ALTNAME_INVALID') || rawMessage.includes('ERR_TLS_CERT_ALTNAME_INVALID')) {
			message = 'Certificate hostname mismatch - your certificate\'s Subject Alternative Name (SAN) doesn\'t match the host. Regenerate with: -addext "subjectAltName=DNS:hostname,IP:x.x.x.x"';
		} else if (rawMessage.includes('certificate') || rawMessage.includes('SSL') || rawMessage.includes('TLS')) {
			message = 'TLS/SSL error - check certificate configuration';
		}

		return json({ success: false, error: message }, { status: 200 });
	}
};
