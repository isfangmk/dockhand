/**
 * POSIX shell 单引号转义，供 SSH exec / compose 参数拼接使用。
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
