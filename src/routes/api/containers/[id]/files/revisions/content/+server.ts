import { json } from '@sveltejs/kit';
import { authorize } from '$lib/server/authorize';
import { validateDockerIdParam } from '$lib/server/docker-validation';
import { inspectContainer } from '$lib/server/docker';
import { getFileRevision } from '$lib/server/file-revisions';
import type { RequestHandler } from './$types';

/**
 * GET /api/containers/{id}/files/revisions/content?id=
 * 读取某条修订的完整内容（用于预览）
 */
export const GET: RequestHandler = async ({ params, url, cookies }) => {
	const invalid = validateDockerIdParam(params.id, 'container');
	if (invalid) return invalid;

	const auth = await authorize(cookies);
	const envId = url.searchParams.get('env');
	const envIdNum = envId ? parseInt(envId) : undefined;
	const revisionId = Number(url.searchParams.get('id'));

	if (auth.authEnabled && !(await auth.can('containers', 'exec', envIdNum))) {
		return json({ error: 'Permission denied' }, { status: 403 });
	}
	if (!Number.isFinite(revisionId)) {
		return json({ error: 'id is required' }, { status: 400 });
	}

	try {
		const revision = await getFileRevision(revisionId);
		if (!revision) {
			return json({ error: 'Revision not found' }, { status: 404 });
		}

		const inspect = await inspectContainer(params.id, envIdNum);
		const containerName = inspect.Name.replace(/^\//, '');
		if (revision.containerName !== containerName) {
			return json({ error: 'Revision does not belong to this container' }, { status: 400 });
		}
		if ((revision.environmentId ?? null) !== (envIdNum ?? null)) {
			return json({ error: 'Revision environment mismatch' }, { status: 400 });
		}

		return json({
			id: revision.id,
			path: revision.filePath,
			content: revision.content,
			source: revision.source,
			sourceLabel: revision.sourceLabel,
			createdAt: revision.createdAt
		});
	} catch (error: any) {
		return json({ error: error.message || 'Failed to load revision' }, { status: 500 });
	}
};
