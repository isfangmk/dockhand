/**
 * SSH 隧道：每环境一条长连接，把本地 Unix socket 转发到远端 docker.sock，
 * 让 dockerFetch / 终端 / metrics 复用现有 type:'socket' 路径。
 */
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import { createHash } from 'node:crypto';
import { createServer, type Server, type Socket as NetSocket } from 'node:net';
import { mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getEnvironment, updateEnvironment, type Environment } from './db.js';
import { shellQuote } from './ssh-shell.js';

export { shellQuote } from './ssh-shell.js';

const DATA_DIR = process.env.DATA_DIR || './data';

export interface SshConnectParams {
	host: string;
	sshPort?: number | null;
	sshUsername: string;
	sshAuthType?: string | null;
	sshPassword?: string | null;
	sshPrivateKey?: string | null;
	sshPassphrase?: string | null;
	sshHostKeyFingerprint?: string | null;
	sshSkipHostKey?: boolean | null;
	/** 远端 Docker socket 路径 */
	socketPath?: string | null;
}

interface TunnelEntry {
	client: Client;
	server: Server;
	localSocketPath: string;
	remoteSocketPath: string;
	ready: Promise<string>;
	fingerprint?: string;
}

const tunnels = new Map<number, TunnelEntry>();
/** 防止同一 env 并发 ensure 时开多条 SSH */
const ensureLocks = new Map<number, Promise<string>>();

function fingerprintOf(key: Buffer): string {
	return `SHA256:${createHash('sha256').update(key).digest('base64')}`;
}

function localTunnelPath(envId: number): string {
	return join(DATA_DIR, 'tmp', `ssh-docker-${envId}.sock`);
}

function buildConnectConfig(
	params: SshConnectParams,
	onFingerprint: (fp: string, key: Buffer) => boolean | void
): ConnectConfig {
	const authType = params.sshAuthType === 'key' ? 'key' : 'password';
	const config: ConnectConfig = {
		host: params.host,
		port: params.sshPort || 22,
		username: params.sshUsername,
		readyTimeout: 20000,
		keepaliveInterval: 15000,
		keepaliveCountMax: 3,
		hostVerifier: (key: Buffer) => {
			const fp = fingerprintOf(key);
			const ok = onFingerprint(fp, key);
			return ok !== false;
		}
	};

	if (authType === 'key') {
		if (!params.sshPrivateKey) throw new Error('SSH private key is required');
		config.privateKey = params.sshPrivateKey;
		if (params.sshPassphrase) config.passphrase = params.sshPassphrase;
	} else {
		if (!params.sshPassword) throw new Error('SSH password is required');
		config.password = params.sshPassword;
	}

	return config;
}

function connectClient(params: SshConnectParams): Promise<{ client: Client; fingerprint: string }> {
	return new Promise((resolve, reject) => {
		let seenFingerprint = '';
		const skip = !!params.sshSkipHostKey;
		const expected = params.sshHostKeyFingerprint || '';

		const client = new Client();
		const config = buildConnectConfig(params, (fp) => {
			seenFingerprint = fp;
			if (skip) return true;
			if (!expected) return true; // TOFU：首次接受，连接成功后再落库
			if (expected !== fp) {
				reject(new Error(`SSH host key mismatch (expected ${expected}, got ${fp})`));
				return false;
			}
			return true;
		});

		client
			.on('ready', () => resolve({ client, fingerprint: seenFingerprint }))
			.on('error', (err) => reject(err))
			.connect(config);
	});
}

/**
 * 在已就绪的 SSH Client 上监听本地 Unix socket，并把每个连接转发到远端 docker.sock。
 */
function startLocalForward(client: Client, localPath: string, remoteSocketPath: string): Promise<Server> {
	return new Promise((resolve, reject) => {
		mkdirSync(dirname(localPath), { recursive: true });
		if (existsSync(localPath)) {
			try {
				unlinkSync(localPath);
			} catch {
				/* ignore */
			}
		}

		const server = createServer((localSocket: NetSocket) => {
			client.openssh_forwardOutStreamLocal(remoteSocketPath, (err, remoteStream) => {
				if (err || !remoteStream) {
					localSocket.destroy();
					console.warn(
						`[SSH] StreamLocal forward failed for ${remoteSocketPath}: ${err?.message || 'no stream'}. ` +
							`Remote OpenSSH must support unix socket forwarding.`
					);
					return;
				}
				localSocket.pipe(remoteStream);
				remoteStream.pipe(localSocket);
				localSocket.on('error', () => remoteStream.destroy());
				remoteStream.on('error', () => localSocket.destroy());
			});
		});

		server.once('error', reject);
		server.listen(localPath, () => resolve(server));
	});
}

function destroyTunnel(entry: TunnelEntry): void {
	try {
		entry.server.close();
	} catch {
		/* ignore */
	}
	try {
		entry.client.end();
	} catch {
		/* ignore */
	}
	try {
		if (existsSync(entry.localSocketPath)) unlinkSync(entry.localSocketPath);
	} catch {
		/* ignore */
	}
}

function envToParams(env: Environment): SshConnectParams {
	if (!env.host) throw new Error('SSH host is required');
	if (!env.sshUsername) throw new Error('SSH username is required');
	return {
		host: env.host,
		sshPort: env.sshPort,
		sshUsername: env.sshUsername,
		sshAuthType: env.sshAuthType,
		sshPassword: env.sshPassword,
		sshPrivateKey: env.sshPrivateKey,
		sshPassphrase: env.sshPassphrase,
		sshHostKeyFingerprint: env.sshHostKeyFingerprint,
		sshSkipHostKey: env.sshSkipHostKey,
		socketPath: env.socketPath
	};
}

async function openTunnelForEnv(envId: number): Promise<string> {
	const env = await getEnvironment(envId);
	if (!env) throw new Error(`Environment ${envId} not found`);
	if (env.connectionType !== 'ssh') throw new Error(`Environment ${envId} is not an SSH connection`);

	const params = envToParams(env);
	const remoteSocketPath = params.socketPath || '/var/run/docker.sock';
	const localSocketPath = localTunnelPath(envId);

	const { client, fingerprint } = await connectClient(params);

	// TOFU：首次成功连接写入指纹（未勾选 skip 时）
	if (fingerprint && !env.sshHostKeyFingerprint && !env.sshSkipHostKey) {
		try {
			await updateEnvironment(envId, { sshHostKeyFingerprint: fingerprint });
		} catch (err) {
			console.warn(`[SSH] Failed to persist host key fingerprint for env ${envId}:`, err);
		}
	}

	const server = await startLocalForward(client, localSocketPath, remoteSocketPath);

	const entry: TunnelEntry = {
		client,
		server,
		localSocketPath,
		remoteSocketPath,
		ready: Promise.resolve(localSocketPath),
		fingerprint
	};

	const cleanup = () => {
		const current = tunnels.get(envId);
		if (current === entry) {
			tunnels.delete(envId);
			destroyTunnel(entry);
		}
	};
	client.on('close', cleanup);
	client.on('end', cleanup);
	client.on('error', (err) => {
		console.warn(`[SSH] Tunnel error for env ${envId}: ${err.message}`);
		cleanup();
	});

	tunnels.set(envId, entry);
	console.log(`[SSH] Tunnel ready for env ${envId}: ${localSocketPath} -> ${params.host}:${params.sshPort || 22}${remoteSocketPath}`);
	return localSocketPath;
}

/**
 * 确保指定环境的 SSH→docker.sock 本地隧道可用，返回本地 socket 路径。
 */
export async function ensureSshDockerTunnel(envId: number): Promise<string> {
	const existing = tunnels.get(envId);
	if (existing) {
		try {
			return await existing.ready;
		} catch {
			tunnels.delete(envId);
			destroyTunnel(existing);
		}
	}

	const inflight = ensureLocks.get(envId);
	if (inflight) return inflight;

	const promise = openTunnelForEnv(envId).finally(() => {
		ensureLocks.delete(envId);
	});
	ensureLocks.set(envId, promise);
	return promise;
}

/**
 * 取得已建立隧道的 ssh2 Client（供 SFTP / compose exec 共用）。
 */
export async function getSshClient(envId: number): Promise<Client> {
	await ensureSshDockerTunnel(envId);
	const entry = tunnels.get(envId);
	if (!entry) throw new Error(`SSH tunnel not available for environment ${envId}`);
	return entry.client;
}

export async function getSshSftp(envId: number): Promise<SFTPWrapper> {
	const client = await getSshClient(envId);
	return new Promise((resolve, reject) => {
		client.sftp((err, sftp) => {
			if (err || !sftp) reject(err || new Error('Failed to open SFTP session'));
			else resolve(sftp);
		});
	});
}

/**
 * 在远端执行命令，收集 stdout/stderr；超时后销毁 channel。
 */
export async function sshExec(
	envId: number,
	command: string,
	options: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const client = await getSshClient(envId);
	const timeoutMs = options.timeoutMs ?? 30000;

	// 将密钥注入远端进程环境，避免写入 .env
	let fullCommand = command;
	if (options.env && Object.keys(options.env).length > 0) {
		const exports = Object.entries(options.env)
			.map(([k, v]) => `export ${shellQuote(k)}=${shellQuote(v)}`)
			.join('; ');
		fullCommand = `${exports}; ${command}`;
	}

	return new Promise((resolve, reject) => {
		let stdout = '';
		let stderr = '';
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`SSH exec timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		client.exec(fullCommand, (err, stream) => {
			if (err) {
				clearTimeout(timer);
				reject(err);
				return;
			}
			stream
				.on('close', (code: number | null) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve({ code, stdout, stderr });
				})
				.on('data', (data: Buffer) => {
					stdout += data.toString();
				});
			stream.stderr.on('data', (data: Buffer) => {
				stderr += data.toString();
			});
		});
	});
}

/** POSIX 单引号转义，用于 export 与 compose 参数 — 见 ssh-shell.ts */

export function closeSshTunnel(envId: number): void {
	const entry = tunnels.get(envId);
	if (!entry) return;
	tunnels.delete(envId);
	destroyTunnel(entry);
	console.log(`[SSH] Closed tunnel for env ${envId}`);
}

export function closeAllSshTunnels(): void {
	for (const envId of [...tunnels.keys()]) {
		closeSshTunnel(envId);
	}
}

/**
 * 未落库前的一次性连通性探测：SSH 登录后对远端 docker.sock 发 GET /info。
 */
export async function probeSshDocker(params: SshConnectParams): Promise<{
	info: any;
	fingerprint: string;
}> {
	const remoteSocketPath = params.socketPath || '/var/run/docker.sock';
	const { client, fingerprint } = await connectClient(params);

	try {
		const info = await new Promise<any>((resolve, reject) => {
			client.openssh_forwardOutStreamLocal(remoteSocketPath, (err, stream) => {
				if (err || !stream) {
					reject(
						err ||
							new Error(
								`Cannot forward to ${remoteSocketPath}. Ensure OpenSSH streamlocal forwarding is enabled and the Docker socket is reachable.`
							)
					);
					return;
				}

				let buf = '';
				const timer = setTimeout(() => {
					stream.destroy();
					reject(new Error('Timed out waiting for Docker API over SSH'));
				}, 15000);

				stream.on('data', (chunk: Buffer) => {
					buf += chunk.toString();
					const headerEnd = buf.indexOf('\r\n\r\n');
					if (headerEnd === -1) return;
					const headers = buf.slice(0, headerEnd);
					let body = buf.slice(headerEnd + 4);
					const contentLengthMatch = headers.match(/content-length:\s*(\d+)/i);
					const contentLength = contentLengthMatch ? parseInt(contentLengthMatch[1], 10) : null;
					const isChunked = /transfer-encoding:\s*chunked/i.test(headers);

					if (contentLength !== null && body.length < contentLength) return;
					// chunked：等到结束块 0\r\n\r\n；或连接已关闭由下方 error/end 处理
					if (contentLength === null && isChunked && !/\r\n0\r\n\r\n/.test(body) && !buf.endsWith('\r\n0\r\n\r\n')) {
						return;
					}

					clearTimeout(timer);
					stream.destroy();

					const statusMatch = headers.match(/^HTTP\/\d\.\d\s+(\d+)/);
					const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
					if (status < 200 || status >= 300) {
						reject(new Error(`Docker API error: ${status} - ${body.slice(0, 200)}`));
						return;
					}

					if (isChunked) {
						body = decodeChunkedBody(body);
					} else if (contentLength !== null) {
						body = body.slice(0, contentLength);
					}

					try {
						resolve(JSON.parse(body));
					} catch {
						reject(new Error('Invalid JSON from Docker /info'));
					}
				});
				stream.on('error', (e) => {
					clearTimeout(timer);
					reject(e);
				});
				// HTTP/1.0 通常不用 chunked，更易解析；仍兼容 chunked 解码
				stream.write('GET /info HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n');
			});
		});

		return { info, fingerprint };
	} finally {
		try {
			client.end();
		} catch {
			/* ignore */
		}
	}
}

/** 解码 Transfer-Encoding: chunked 的响应体 */
function decodeChunkedBody(raw: string): string {
	let remaining = raw;
	let out = '';
	while (remaining.length > 0) {
		const lineEnd = remaining.indexOf('\r\n');
		if (lineEnd === -1) break;
		const sizeLine = remaining.slice(0, lineEnd).split(';')[0].trim();
		const size = parseInt(sizeLine, 16);
		if (!Number.isFinite(size)) break;
		if (size === 0) break;
		const start = lineEnd + 2;
		out += remaining.slice(start, start + size);
		remaining = remaining.slice(start + size + 2); // skip chunk + CRLF
	}
	return out;
}

/**
 * 通过 SFTP 递归确保远端目录存在。
 */
export async function sshMkdirp(sftp: SFTPWrapper, remotePath: string): Promise<void> {
	const parts = remotePath.split('/').filter(Boolean);
	let current = remotePath.startsWith('/') ? '/' : '';
	for (const part of parts) {
		current = current === '/' ? `/${part}` : `${current}/${part}`;
		await new Promise<void>((resolve, reject) => {
			sftp.stat(current, (statErr) => {
				if (!statErr) {
					resolve();
					return;
				}
				sftp.mkdir(current, (mkdirErr) => {
					if (mkdirErr && (mkdirErr as NodeJS.ErrnoException).code !== 4) {
						// code 4 = SSH_FX_FAILURE often means exists; re-stat
						sftp.stat(current, (e2) => (e2 ? reject(mkdirErr) : resolve()));
					} else {
						resolve();
					}
				});
			});
		});
	}
}

/**
 * 写入远端文件（覆盖）。
 */
export async function sshWriteFile(sftp: SFTPWrapper, remotePath: string, content: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const stream = sftp.createWriteStream(remotePath);
		stream.on('error', reject);
		stream.on('close', () => resolve());
		stream.end(content, 'utf8');
	});
}
