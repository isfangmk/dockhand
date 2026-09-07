/**
 * 容器内文件修订历史：每次变更只存一条「变更前」快照，与容器最新内容对比。
 */
import {
	db,
	eq,
	and,
	desc,
	isNull,
	containerFileRevisions,
	type ContainerFileRevision,
	type NewContainerFileRevision
} from './db/drizzle';

/** 单文件最多保留的修订条数，超出后删掉最旧记录 */
const MAX_REVISIONS_PER_FILE = 50;

/** 可入库的文本内容上限（与编辑器 1MB 一致） */
export const MAX_REVISION_CONTENT_BYTES = 1024 * 1024;

export type RevisionSource = 'editor' | 'archive' | 'restore' | 'initial';

export interface SaveRevisionInput {
	environmentId: number | null | undefined;
	containerName: string;
	filePath: string;
	content: string;
	source: RevisionSource;
	sourceLabel?: string | null;
	createdBy?: number | null;
}

/** 规范化为容器内绝对路径，避免相对路径导致读写失败；根目录外去掉尾部 / */
export function normalizeFilePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) return '/';
	let p = trimmed.startsWith('/') ? trimmed.replace(/\/+/g, '/') : `/${trimmed.replace(/\/+/g, '/')}`;
	if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
	return p;
}

/** 写入一条修订，并裁剪同文件超限的旧记录 */
export async function saveFileRevision(input: SaveRevisionInput): Promise<ContainerFileRevision> {
	const filePath = normalizeFilePath(input.filePath);
	const size = new TextEncoder().encode(input.content).length;
	const envId = input.environmentId ?? null;

	const row: NewContainerFileRevision = {
		environmentId: envId,
		containerName: input.containerName,
		filePath,
		content: input.content,
		size,
		source: input.source,
		sourceLabel: input.sourceLabel ?? null,
		createdBy: input.createdBy ?? null
	};

	const inserted = await db.insert(containerFileRevisions).values(row).returning();
	const saved = inserted[0];

	// 仅保留最近 N 条，避免修订表无限膨胀
	const envFilter =
		envId == null
			? isNull(containerFileRevisions.environmentId)
			: eq(containerFileRevisions.environmentId, envId);

	const ids = await db
		.select({ id: containerFileRevisions.id })
		.from(containerFileRevisions)
		.where(
			and(
				envFilter,
				eq(containerFileRevisions.containerName, input.containerName),
				eq(containerFileRevisions.filePath, filePath)
			)
		)
		.orderBy(desc(containerFileRevisions.id));

	if (ids.length > MAX_REVISIONS_PER_FILE) {
		const dropIds = ids.slice(MAX_REVISIONS_PER_FILE).map((r: { id: number }) => r.id);
		for (const id of dropIds) {
			await db.delete(containerFileRevisions).where(eq(containerFileRevisions.id, id));
		}
	}

	return saved;
}

export interface ChangedFileSummary {
	filePath: string;
	revisionCount: number;
	latestAt: string | null;
	latestSource: string | null;
	latestLabel: string | null;
	latestSize: number;
}

/** 列出某容器下有修订记录的文件（按最近变更倒序） */
export async function listChangedFiles(
	environmentId: number | null | undefined,
	containerName: string
): Promise<ChangedFileSummary[]> {
	const envId = environmentId ?? null;
	const envFilter =
		envId == null
			? isNull(containerFileRevisions.environmentId)
			: eq(containerFileRevisions.environmentId, envId);
	const rows = await db
		.select()
		.from(containerFileRevisions)
		.where(and(envFilter, eq(containerFileRevisions.containerName, containerName)))
		.orderBy(desc(containerFileRevisions.id));

	const byPath = new Map<string, ChangedFileSummary>();
	for (const row of rows) {
		const existing = byPath.get(row.filePath);
		if (!existing) {
			byPath.set(row.filePath, {
				filePath: row.filePath,
				revisionCount: 1,
				latestAt: row.createdAt ?? null,
				latestSource: row.source,
				latestLabel: row.sourceLabel ?? null,
				latestSize: row.size
			});
		} else {
			existing.revisionCount += 1;
		}
	}

	return [...byPath.values()].sort((a, b) => {
		const ta = a.latestAt ? Date.parse(a.latestAt) : 0;
		const tb = b.latestAt ? Date.parse(b.latestAt) : 0;
		return tb - ta;
	});
}

/** 列出单文件修订（不含大 content，详情接口再取） */
export async function listFileRevisions(
	environmentId: number | null | undefined,
	containerName: string,
	filePath: string
): Promise<Omit<ContainerFileRevision, 'content'>[]> {
	const path = normalizeFilePath(filePath);
	const envId = environmentId ?? null;
	const envFilter =
		envId == null
			? isNull(containerFileRevisions.environmentId)
			: eq(containerFileRevisions.environmentId, envId);
	const rows = await db
		.select({
			id: containerFileRevisions.id,
			environmentId: containerFileRevisions.environmentId,
			containerName: containerFileRevisions.containerName,
			filePath: containerFileRevisions.filePath,
			size: containerFileRevisions.size,
			source: containerFileRevisions.source,
			sourceLabel: containerFileRevisions.sourceLabel,
			createdBy: containerFileRevisions.createdBy,
			createdAt: containerFileRevisions.createdAt
		})
		.from(containerFileRevisions)
		.where(
			and(
				envFilter,
				eq(containerFileRevisions.containerName, containerName),
				eq(containerFileRevisions.filePath, path)
			)
		)
		.orderBy(desc(containerFileRevisions.id));

	return rows;
}

export async function getFileRevision(id: number): Promise<ContainerFileRevision | null> {
	const rows = await db.select().from(containerFileRevisions).where(eq(containerFileRevisions.id, id)).limit(1);
	return rows[0] ?? null;
}
