import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { inspectContainer, readContainerFile, writeContainerFile } from '$lib/server/docker';
import {
	deleteFileRevision,
	deleteFileRevisionsForPath,
	getFileRevision,
	listChangedFiles,
	listFileRevisions,
	normalizeFilePath,
	saveFileRevision
} from '$lib/server/file-revisions';
import type { RequestHandler } from './$types';

function containerDisplayName(inspect: { Name: string }): string {
	return inspect.Name.replace(/^\//, '');
}

/**
 * GET /api/containers/{id}/files/revisions
 * - 无 path：返回该容器有历史的文件列表
 * - 有 path：返回该文件修订列表（不含 content）
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const path = url.searchParams.get('path');

	if (auth.authEnabled && !(await auth.can('containers', 'exec', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	try {
		const inspect = await inspectContainer(params.id, envIdNum);
		const containerName = containerDisplayName(inspect);

		if (path) {
			const revisions = await listFileRevisions(envIdNum ?? null, containerName, path);
			return json({ containerName, path: normalizeFilePath(path), revisions });
		}

		const files = await listChangedFiles(envIdNum ?? null, containerName);
		return json({ containerName, files });
	} catch (error: any) {
		console.error('Error listing file revisions:', error?.message || error);
		return json({ error: error.message || 'Failed to list revisions' }, { status: 500 });
	}
};

/**
 * POST /api/containers/{id}/files/revisions
 * body: { revisionId } — 将指定修订写回容器；回退前只记一条变更前快照
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
		const body = await request.json();
		const revisionId = Number(body.revisionId);
		if (!Number.isFinite(revisionId)) {
			return json({ error: 'revisionId is required' }, { status: 400 });
		}

		const revision = await getFileRevision(revisionId);
		if (!revision) {
			return json({ error: 'Revision not found' }, { status: 404 });
		}

		const inspect = await inspectContainer(params.id, envIdNum);
		const containerName = containerDisplayName(inspect);
		if (revision.containerName !== containerName) {
			return json({ error: 'Revision does not belong to this container' }, { status: 400 });
		}
		if ((revision.environmentId ?? null) !== (envIdNum ?? null)) {
			return json({ error: 'Revision environment mismatch' }, { status: 400 });
		}

		// 回退前只快照当前内容（一条变更前记录）；写回后不再记 HEAD
		try {
			const current = await readContainerFile(params.id, revision.filePath, envIdNum);
			if (current !== revision.content) {
				await saveFileRevision({
					environmentId: envIdNum ?? null,
					containerName,
					filePath: revision.filePath,
					content: current,
					source: 'restore',
					sourceLabel: `restore #${revision.id}`,
					createdBy: auth.user?.id ?? null
				});
			}
		} catch {
			// 当前文件不存在时跳过预快照
		}

		await writeContainerFile(params.id, revision.filePath, revision.content, envIdNum);

		return json({ success: true, path: revision.filePath, restoredFrom: revision.id });
	} catch (error: any) {
		console.error('Error restoring file revision:', error?.message || error);
		return json({ error: error.message || 'Failed to restore revision' }, { status: 500 });
	}
};

/**
 * DELETE /api/containers/{id}/files/revisions
 * - revisionId：删除单条修订
 * - path：删除该文件全部修订
 * 仅删除数据库记录，不修改容器内文件
 */
export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const path = url.searchParams.get('path');
	const revisionIdRaw = url.searchParams.get('revisionId');

	if (auth.authEnabled && !(await auth.can('containers', 'exec', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}

	if (!path && !revisionIdRaw) {
		return json({ error: 'path or revisionId is required' }, { status: 400 });
	}

	try {
		const inspect = await inspectContainer(params.id, envIdNum);
		const containerName = containerDisplayName(inspect);

		if (revisionIdRaw) {
			const revisionId = Number(revisionIdRaw);
			if (!Number.isFinite(revisionId)) {
				return json({ error: 'revisionId is invalid' }, { status: 400 });
			}

			const revision = await getFileRevision(revisionId);
			if (!revision) {
				return json({ error: 'Revision not found' }, { status: 404 });
			}
			if (revision.containerName !== containerName) {
				return json({ error: 'Revision does not belong to this container' }, { status: 400 });
			}
			if ((revision.environmentId ?? null) !== (envIdNum ?? null)) {
				return json({ error: 'Revision environment mismatch' }, { status: 400 });
			}

			const ok = await deleteFileRevision(revisionId);
			if (!ok) {
				return json({ error: 'Revision not found' }, { status: 404 });
			}
			return json({ success: true, deleted: 1, path: revision.filePath, revisionId });
		}

		const deleted = await deleteFileRevisionsForPath(envIdNum ?? null, containerName, path!);
		return json({
			success: true,
			deleted,
			path: normalizeFilePath(path!)
		});
	} catch (error: any) {
		console.error('Error deleting file revision:', error?.message || error);
		return json({ error: error.message || 'Failed to delete revision' }, { status: 500 });
	}
};
