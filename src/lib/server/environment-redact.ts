/**
 * Strip an environment's decrypted secrets before it leaves the server.
 *
 * `getEnvironment(s)` decrypt TLS / Hawser / SSH secrets for internal use, but none of
 * these must reach an API response. In their place we expose `has*` booleans so the UI
 * can show "configured" without holding the value.
 */

/** Secret fields removed from every environment API response. */
export type EnvironmentSecretField =
	| 'tlsKey'
	| 'hawserToken'
	| 'sshPassword'
	| 'sshPrivateKey'
	| 'sshPassphrase';

type EnvSecrets = {
	tlsKey?: string | null;
	hawserToken?: string | null;
	sshPassword?: string | null;
	sshPrivateKey?: string | null;
	sshPassphrase?: string | null;
};

export function redactEnvironment<T extends EnvSecrets>(
	env: T
): Omit<T, EnvironmentSecretField> & {
	hasTlsKey: boolean;
	hasHawserToken: boolean;
	hasSshPassword: boolean;
	hasSshPrivateKey: boolean;
} {
	const { tlsKey, hawserToken, sshPassword, sshPrivateKey, sshPassphrase, ...rest } = env;
	return {
		...rest,
		hasTlsKey: !!(tlsKey && tlsKey.length > 0),
		hasHawserToken: !!(hawserToken && hawserToken.length > 0),
		hasSshPassword: !!(sshPassword && sshPassword.length > 0),
		hasSshPrivateKey: !!(sshPrivateKey && sshPrivateKey.length > 0)
	};
}
