/**
 * Build a safe `Content-Disposition: attachment` header value (RFC 6266).
 *
 * The filename is often derived from a user-influenced path, so it must never
 * be interpolated raw — a `"` would break out of the quoted string and CR/LF
 * could attempt header injection. HTTP headers also must be Latin-1/ASCII-safe
 * in Node/Bun, so non-ASCII (e.g. Chinese names) cannot appear in `filename=`.
 * We emit both:
 *  - an ASCII-only `filename="..."` fallback
 *  - a percent-encoded `filename*=UTF-8''...` for the real (possibly non-ASCII) name
 */
export function attachmentContentDisposition(filename: string): string {
	const raw = filename || 'download';
	// filename= 仅保留可打印 ASCII：控制字符去掉，其余非 ASCII 用 _ 占位
	const fallback =
		raw
			.replace(/[\x00-\x1f\x7f]/g, '')
			.replace(/[^\x20-\x7e]/g, '_')
			.replace(/["\\]/g, '')
			.trim() || 'download';

	const encoded = encodeURIComponent(raw);

	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
