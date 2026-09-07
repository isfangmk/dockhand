import { describe, expect, it } from 'bun:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { decodeZipEntryName } from '../src/lib/server/zip-filenames';

/** 构造未设置 UTF-8 标志、文件名为 GBK 的最小 zip */
function buildGbkZip(gbkName: Buffer, content: Buffer): Uint8Array {
	const crc = crc32(content) >>> 0;
	const comp = deflateRawSync(content);
	const u16 = (n: number) => {
		const b = Buffer.alloc(2);
		b.writeUInt16LE(n);
		return b;
	};
	const u32 = (n: number) => {
		const b = Buffer.alloc(4);
		b.writeUInt32LE(n);
		return b;
	};
	const lfh = Buffer.concat([
		u32(0x04034b50),
		u16(20),
		u16(0),
		u16(8),
		u16(0),
		u16(0),
		u32(crc),
		u32(comp.length),
		u32(content.length),
		u16(gbkName.length),
		u16(0),
		gbkName,
		comp
	]);
	const cdh = Buffer.concat([
		u32(0x02014b50),
		u16(20),
		u16(20),
		u16(0),
		u16(8),
		u16(0),
		u16(0),
		u32(crc),
		u32(comp.length),
		u32(content.length),
		u16(gbkName.length),
		u16(0),
		u16(0),
		u16(0),
		u16(0),
		u32(0),
		u32(0),
		gbkName
	]);
	const eocd = Buffer.concat([
		u32(0x06054b50),
		u16(0),
		u16(0),
		u16(1),
		u16(1),
		u32(cdh.length),
		u32(lfh.length),
		u16(0)
	]);
	return new Uint8Array(Buffer.concat([lfh, cdh, eocd]));
}

describe('decodeZipEntryName', () => {
	it('decodes GBK zip entry names that fflate returns as Latin-1', () => {
		// 「中文测试.txt」的 GBK 字节（bun Buffer 不支持 gbk 编码名）
		const gbkName = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x2e, 0x74, 0x78, 0x74]);
		const zip = buildGbkZip(gbkName, Buffer.from('hello\n'));
		const files = unzipSync(zip);
		const raw = Object.keys(files)[0];
		expect(raw).not.toBe('中文测试.txt');
		expect(decodeZipEntryName(raw)).toBe('中文测试.txt');
	});

	it('keeps already-decoded Unicode names', () => {
		expect(decodeZipEntryName('中文测试-utf8.txt')).toBe('中文测试-utf8.txt');
	});

	it('keeps ASCII names', () => {
		expect(decodeZipEntryName('readme.txt')).toBe('readme.txt');
	});
});
