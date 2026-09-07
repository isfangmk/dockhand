/**
 * Zip 条目文件名解码：处理未标 UTF-8 标志的中文 Windows（GBK）压缩包。
 */

/**
 * fflate 对未标 UTF-8 标志的文件名按 Latin-1 还原原始字节；
 * 国内 Windows 资源管理器打的 zip 多为 GBK/GB18030。
 * 已是 Unicode 的名称（带 UTF-8 标志）原样返回。
 */
export function decodeZipEntryName(name: string): string {
	if ([...name].some((ch) => (ch.codePointAt(0) ?? 0) > 255)) {
		return name;
	}
	const bytes = Uint8Array.from(name, (ch) => ch.charCodeAt(0) & 0xff);
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		// 非 UTF-8 字节序列，继续尝试中文编码
	}
	try {
		return new TextDecoder('gb18030').decode(bytes);
	} catch {
		return name;
	}
}
