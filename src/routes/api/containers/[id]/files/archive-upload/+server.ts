import { gunzipSync } from 'node:zlib';
import { json } from '@sveltejs/kit';
import { unzipSync } from 'fflate';
import { unpackTar } from 'modern-tar';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { buildTar } from '$lib/server/backups/tar';
import { inspectContainer, putContainerArchive } from '$lib/server/docker';
import { normalizeFilePath } from '$lib/server/file-revisions';
import { decodeZipEntryName } from '$lib/server/zip-filenames';
import type { RequestHandler } from './$types';

function joinTargetPath(targetDir: string, entryName: string): string {
	const base = normalizeFilePath(targetDir).replace(/\/$/, '') || '';
	const rel = entryName.replace(/^\/+/, '');
	return normalizeFilePath(`${base}/${rel}`);
}

/** 将 zip 转为 Docker put-archive 可用的 tar（跳过目录项，保留相对路径） */
async function zipToTar(zipBytes: Uint8Array): Promise<Uint8Array> {
	const files = unzipSync(zipBytes);
	const entries: { path: string; content: Uint8Array }[] = [];
	for (const [rawName, data] of Object.entries(files)) {
		const path = decodeZipEntryName(rawName).replace(/\\/g, '/');
		// 跳过目录占位与 macOS 元数据
		if (!path || path.endsWith('/') || path.includes('__MACOSX/')) continue;
		entries.push({ path: path.replace(/^\/+/, ''), content: data });
	}
	if (entries.length === 0) {
		throw new Error('Zip archive contains no files');
	}
	return buildTar(entries);
}

/**
 * POST /api/containers/{id}/files/archive-upload
 * multipart: file(.tar|.tar.gz|.zip), path(目标目录)
 * 解压后覆盖写入目标目录；不记录压缩包覆盖前修订（大包串行快照代价过高）。
 */
export const POST: RequestHandler = async ({ params, url, cookies, request }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;

	if (auth.authEnabled && !(await auth.can('containers', 'exec', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const form = await request.formData();
		const file = form.get('file');
		const targetPath = String(form.get('path') || url.searchParams.get('path') || '');

		if (!(file instanceof File)) {
			return json({ error: 'file is required' }, { status: 400 });
		}
		if (!targetPath) {
			return json({ error: 'path is required' }, { status: 400 });
		}

		const name = file.name.toLowerCase();
		const raw = new Uint8Array(await file.arrayBuffer());
		let tarBytes: Uint8Array;

		if (name.endsWith('.zip')) {
			tarBytes = await zipToTar(raw);
		} else if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
			tarBytes = new Uint8Array(gunzipSync(Buffer.from(raw)));
		} else if (name.endsWith('.tar')) {
			tarBytes = raw;
		} else {
			return json({ error: 'Only .zip, .tar and .tar.gz archives are supported' }, { status: 400 });
		}

		await inspectContainer(params.id, envIdNum);
		const dir = normalizeFilePath(targetPath);

		// 收集包内文件绝对路径，供前端刷新已打开的编辑器 tab
		const written: string[] = [];
		{
			const entries = await unpackTar(tarBytes);
			for (const entry of entries) {
				if (entry.header.type && entry.header.type !== 'file') continue;
				written.push(joinTargetPath(dir, entry.header.name));
			}
		}

		await putContainerArchive(params.id, dir, tarBytes, envIdNum);

		return json({
			success: true,
			path: dir,
			archive: file.name,
			written
		});
	} catch (error: any) {
		console.error('Error uploading archive:', error?.message || error);
		return json({ error: error.message || 'Failed to upload archive' }, { status: 500 });
	}
};
