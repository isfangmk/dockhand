<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import FileSideDiff from './FileSideDiff.svelte';
	import type { ContainerInfo } from '$lib/types';
	import { appSettings, formatDateTime } from '$lib/stores/settings';
	import { canAccess } from '$lib/stores/auth';
	import { toast } from 'svelte-sonner';
	import {
		FolderOpen,
		RefreshCw,
		ChevronRight,
		ChevronDown,
		Folder,
		File as FileIcon,
		Download,
		Save,
		Trash2,
		Shield,
		Upload,
		Loader2,
		FilePlus,
		FolderPlus,
		X,
		RotateCcw
	} from 'lucide-svelte';

	interface Props {
		container: ContainerInfo;
		envId: number | null;
	}

	let { container, envId }: Props = $props();

	interface FileEntry {
		name: string;
		type: 'file' | 'directory' | 'symlink' | 'other';
		size: number;
		permissions: string;
		owner: string;
		group: string;
		modified: string;
	}

	interface ChangedFile {
		filePath: string;
		revisionCount: number;
		latestAt: string | null;
		latestSource: string | null;
		latestLabel: string | null;
		latestSize: number;
	}

	interface RevisionMeta {
		id: number;
		filePath: string;
		size: number;
		source: string;
		sourceLabel: string | null;
		createdAt: string | null;
	}

	interface EditorTab {
		path: string;
		name: string;
		content: string;
		savedContent: string;
		dirty: boolean;
	}

	let currentPath = $state('/');
	let entries = $state<FileEntry[]>([]);
	let loadingTree = $state(false);
	let selectedTreeFile = $state<string | null>(null);

	let tabs = $state<EditorTab[]>([]);
	let activePath = $state<string | null>(null);
	let saving = $state(false);
	let loadingFile = $state(false);

	let changedFiles = $state<ChangedFile[]>([]);
	let expandedHistory = $state<Set<string>>(new Set());
	let revisionsByPath = $state<Record<string, RevisionMeta[]>>({});
	let loadingHistory = $state(false);
	let archiveFile = $state<File | null>(null);
	let archiveInputEl = $state<HTMLInputElement | null>(null);
	let uploadingArchive = $state(false);

	/** 中间栏修订对比：左=历史修订，右=当前容器内文件 */
	let diffView = $state<{
		filePath: string;
		revisionId: number;
		leftLabel: string;
		rightLabel: string;
		left: string;
		right: string;
	} | null>(null);
	let loadingDiff = $state(false);

	let renameOpen = $state(false);
	let renameValue = $state('');
	let chmodOpen = $state(false);
	let chmodMode = $state('644');
	let createOpen = $state(false);
	let createKind = $state<'file' | 'directory'>('file');
	let createName = $state('');

	const canEdit = $derived($canAccess('containers', 'exec'));
	const activeTab = $derived(tabs.find((t) => t.path === activePath) ?? null);

	const uploadTarget = $derived(currentPath.endsWith('/') ? currentPath : `${currentPath}/`);

	// 路径面包屑：点击任一段跳到对应目录
	const pathSegments = $derived(currentPath.split('/').filter(Boolean));

	function navigateToSegment(index: number) {
		const path = index < 0 ? '/' : '/' + pathSegments.slice(0, index + 1).join('/');
		loadDirectory(path);
	}

	// 仅在容器 id 真正切换时重置；父级轮询更新其它字段时不得清空编辑内容
	let loadedForId: string | null = null;
	$effect(() => {
		const id = container.id;
		if (id === loadedForId) return;

		loadedForId = id;
		selectedTreeFile = null;
		tabs = [];
		activePath = null;
		diffView = null;
		expandedHistory = new Set();
		revisionsByPath = {};
		archiveFile = null;
		if (archiveInputEl) archiveInputEl.value = '';

		let cancelled = false;
		(async () => {
			const startPath = await resolveWorkingDir(id);
			if (cancelled || loadedForId !== id) return;
			currentPath = startPath;
			await Promise.all([loadDirectory(startPath), loadChangedFiles()]);
		})();

		return () => {
			cancelled = true;
		};
	});

	/** 从 inspect 读取 WorkingDir，空值视为根目录 */
	async function resolveWorkingDir(containerId: string): Promise<string> {
		try {
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${containerId}?${params}`);
			if (!res.ok) return '/';
			const inspect = await res.json();
			const wd = (inspect?.Config?.WorkingDir as string | undefined)?.trim();
			if (!wd || wd === '.') return '/';
			return wd.startsWith('/') ? wd.replace(/\/+/g, '/') : `/${wd.replace(/\/+/g, '/')}`;
		} catch {
			return '/';
		}
	}

	async function loadDirectory(path: string) {
		loadingTree = true;
		try {
			const params = new URLSearchParams({ path });
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files?${params}`);
			const data = await res.json();
			if (!res.ok) {
				// 工作目录不存在时退回根目录，避免选中容器后空白
				if (path !== '/') {
					await loadDirectory('/');
					return;
				}
				throw new Error(data.error || 'Failed to list directory');
			}
			currentPath = data.path || path;
			entries = (data.entries || []).filter((e: FileEntry) => e.name !== '.' && e.name !== '..');
		} catch (err: any) {
			toast.error(err.message || 'Failed to list directory');
			entries = [];
		} finally {
			loadingTree = false;
		}
	}

	function joinPath(dir: string, name: string): string {
		if (dir === '/') return `/${name}`;
		return `${dir.replace(/\/$/, '')}/${name}`;
	}

	function parentPath(path: string): string {
		if (path === '/') return '/';
		const parts = path.replace(/\/$/, '').split('/');
		parts.pop();
		return parts.length <= 1 ? '/' : parts.join('/');
	}

	function detectLanguage(name: string): string {
		const lower = name.toLowerCase();
		if (lower.endsWith('.json')) return 'json';
		if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
		if (lower.endsWith('.py')) return 'python';
		if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
		if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'javascript';
		if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
		if (lower.endsWith('.css')) return 'css';
		if (lower.endsWith('.md')) return 'markdown';
		if (lower.endsWith('.xml')) return 'xml';
		if (lower.endsWith('.sql')) return 'sql';
		if (lower.includes('dockerfile')) return 'dockerfile';
		if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'shell';
		if (lower.endsWith('.toml')) return 'toml';
		if (lower.endsWith('.env') || lower.includes('.env.')) return 'dotenv';
		return 'text';
	}

	async function openFile(path: string, name: string) {
		diffView = null;
		selectedTreeFile = path;
		// 文件树同步到该文件所在目录
		const dir = parentPath(path);
		if (currentPath !== dir) {
			await loadDirectory(dir);
		}
		const existing = tabs.find((t) => t.path === path);
		if (existing) {
			activePath = path;
			return;
		}
		loadingFile = true;
		try {
			const params = new URLSearchParams({ path });
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/content?${params}`);
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to read file');
			tabs = [
				...tabs,
				{
					path,
					name,
					content: data.content,
					savedContent: data.content,
					dirty: false
				}
			];
			activePath = path;
		} catch (err: any) {
			toast.error(err.message || 'Failed to open file');
		} finally {
			loadingFile = false;
		}
	}

	function onEditorChange(value: string) {
		if (!activePath) return;
		tabs = tabs.map((t) =>
			t.path === activePath
				? { ...t, content: value, dirty: value !== t.savedContent }
				: t
		);
	}

	async function saveActive() {
		if (!activeTab || !canEdit) return;
		const savedPath = activeTab.path;
		saving = true;
		try {
			const params = new URLSearchParams({ path: savedPath });
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/content?${params}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: activeTab.content })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to save');
			tabs = tabs.map((t) =>
				t.path === savedPath
					? { ...t, savedContent: t.content, dirty: false }
					: t
			);
			toast.success('Saved');
			// 保存会写入新修订：刷新列表与该文件的展开明细
			await loadChangedFiles();
			await loadRevisionsForPath(savedPath);
			expandedHistory = new Set([...expandedHistory, savedPath]);
		} catch (err: any) {
			toast.error(err.message || 'Failed to save');
		} finally {
			saving = false;
		}
	}

	function discardActive() {
		if (!activeTab) return;
		tabs = tabs.map((t) =>
			t.path === activeTab.path
				? { ...t, content: t.savedContent, dirty: false }
				: t
		);
	}

	function closeTab(path: string) {
		const tab = tabs.find((t) => t.path === path);
		if (tab?.dirty && !confirm(`${tab.name} has unsaved changes. Close anyway?`)) return;
		tabs = tabs.filter((t) => t.path !== path);
		if (activePath === path) {
			activePath = tabs[tabs.length - 1]?.path ?? null;
		}
	}

	function downloadActive() {
		if (!activeTab) return;
		const format = $appSettings.downloadFormat || 'tar';
		const params = new URLSearchParams({ path: activeTab.path, format });
		if (envId != null) params.set('env', String(envId));
		window.open(`/api/containers/${container.id}/files/download?${params}`, '_blank');
	}

	async function deleteActive() {
		if (!activeTab || !canEdit) return;
		try {
			const params = new URLSearchParams({ path: activeTab.path });
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/delete?${params}`, {
				method: 'DELETE'
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to delete');
			toast.success('Deleted');
			const deletedPath = activeTab.path;
			tabs = tabs.filter((t) => t.path !== deletedPath);
			if (activePath === deletedPath) {
				activePath = tabs[tabs.length - 1]?.path ?? null;
			}
			selectedTreeFile = null;
			await loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || 'Failed to delete');
		}
	}

	function openRename() {
		if (!activeTab) return;
		renameValue = activeTab.name;
		renameOpen = true;
	}

	async function submitRename() {
		if (!activeTab || !renameValue.trim()) return;
		const dir = parentPath(activeTab.path);
		const newPath = joinPath(dir, renameValue.trim());
		try {
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/rename?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ oldPath: activeTab.path, newPath })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to rename');
			const oldPath = activeTab.path;
			tabs = tabs.map((t) =>
				t.path === oldPath ? { ...t, path: newPath, name: renameValue.trim() } : t
			);
			activePath = newPath;
			selectedTreeFile = newPath;
			renameOpen = false;
			toast.success('Renamed');
			await loadDirectory(currentPath);
			await loadChangedFiles();
		} catch (err: any) {
			toast.error(err.message || 'Failed to rename');
		}
	}

	function openChmod() {
		chmodMode = '644';
		chmodOpen = true;
	}

	async function submitChmod() {
		if (!activeTab || !chmodMode.trim()) return;
		try {
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/chmod?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: activeTab.path, mode: chmodMode, recursive: false })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to chmod');
			chmodOpen = false;
			toast.success('Permissions updated');
		} catch (err: any) {
			toast.error(err.message || 'Failed to chmod');
		}
	}

	async function createEntry() {
		if (!createName.trim() || !canEdit) return;
		const name = createName.trim();
		const kind = createKind;
		try {
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const path = joinPath(currentPath, name);
			const res = await fetch(`/api/containers/${container.id}/files/create?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, type: kind })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to create');
			createOpen = false;
			createName = '';
			toast.success(kind === 'file' ? 'File created' : 'Folder created');
			await loadDirectory(currentPath);
			if (kind === 'file') {
				await openFile(path, name);
			}
		} catch (err: any) {
			toast.error(err.message || 'Failed to create');
		}
	}

	async function loadChangedFiles() {
		loadingHistory = true;
		try {
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/revisions?${params}`);
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to load history');
			changedFiles = data.files || [];
		} catch (err: any) {
			console.error(err);
			changedFiles = [];
		} finally {
			loadingHistory = false;
		}
	}

	/** 拉取单个文件的修订明细（保存/恢复/上传后需刷新） */
	async function loadRevisionsForPath(filePath: string): Promise<boolean> {
		try {
			const params = new URLSearchParams({ path: filePath });
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/revisions?${params}`);
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to load revisions');
			revisionsByPath = { ...revisionsByPath, [filePath]: data.revisions || [] };
			return true;
		} catch (err: any) {
			toast.error(err.message || 'Failed to load revisions');
			return false;
		}
	}

	async function toggleHistory(filePath: string) {
		const next = new Set(expandedHistory);
		if (next.has(filePath)) {
			next.delete(filePath);
			expandedHistory = next;
			return;
		}
		next.add(filePath);
		expandedHistory = next;
		await loadRevisionsForPath(filePath);
	}

	async function openRevisionDiff(rev: RevisionMeta) {
		loadingDiff = true;
		try {
			const revParams = new URLSearchParams({ id: String(rev.id) });
			if (envId != null) revParams.set('env', String(envId));
			const revRes = await fetch(
				`/api/containers/${container.id}/files/revisions/content?${revParams}`
			);
			const revData = await revRes.json();
			if (!revRes.ok) throw new Error(revData.error || 'Failed to load revision');

			// 始终与容器内最新文件对比，不用编辑器缓冲（避免未刷新/未保存造成「搞反」）
			const curParams = new URLSearchParams({ path: rev.filePath });
			if (envId != null) curParams.set('env', String(envId));
			const curRes = await fetch(
				`/api/containers/${container.id}/files/content?${curParams}`
			);
			const curData = await curRes.json();
			if (!curRes.ok) throw new Error(curData.error || 'Failed to read current file');
			const latest = curData.content as string;

			diffView = {
				filePath: rev.filePath,
				revisionId: rev.id,
				// 左：历史修订；右：容器内最新内容
				leftLabel: `#${rev.id} · ${rev.sourceLabel || rev.source} · ${formatTime(rev.createdAt)}`,
				rightLabel: 'Latest',
				left: revData.content,
				right: latest
			};
			activePath = null;
			// 同步编辑器 tab 为容器最新，避免之后打开仍是旧缓冲
			tabs = tabs.map((t) =>
				t.path === rev.filePath
					? { ...t, content: latest, savedContent: latest, dirty: false }
					: t
			);
			selectedTreeFile = rev.filePath;
			const dir = parentPath(rev.filePath);
			if (currentPath !== dir) {
				await loadDirectory(dir);
			}
		} catch (err: any) {
			toast.error(err.message || 'Failed to open diff');
		} finally {
			loadingDiff = false;
		}
	}

	function closeDiff() {
		diffView = null;
	}

	async function restoreRevision(rev: RevisionMeta) {
		if (!canEdit) return;
		if (!confirm(`Restore ${rev.filePath} to revision #${rev.id}?`)) return;
		try {
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(`/api/containers/${container.id}/files/revisions?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ revisionId: rev.id })
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to restore');
			toast.success('Restored');
			const name = rev.filePath.split('/').pop() || rev.filePath;
			tabs = tabs.filter((t) => t.path !== rev.filePath);
			diffView = null;
			await openFile(rev.filePath, name);
			await loadChangedFiles();
			await loadRevisionsForPath(rev.filePath);
			expandedHistory = new Set([...expandedHistory, rev.filePath]);
		} catch (err: any) {
			toast.error(err.message || 'Failed to restore');
		}
	}

	async function uploadArchive() {
		if (!archiveFile || !canEdit) return;
		uploadingArchive = true;
		try {
			const form = new FormData();
			form.set('file', archiveFile as Blob);
			form.set('path', uploadTarget);
			const params = new URLSearchParams();
			if (envId != null) params.set('env', String(envId));
			const res = await fetch(
				`/api/containers/${container.id}/files/archive-upload?${params}`,
				{ method: 'POST', body: form }
			);
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Upload failed');
			toast.success(`Uploaded ${archiveFile.name}`);
			archiveFile = null;
			if (archiveInputEl) archiveInputEl.value = '';
			// 覆盖后把已打开的相关文件从容器重新载入
			const written: string[] = Array.isArray(data.written) ? data.written : [];
			for (const path of written) {
				const tab = tabs.find((t) => t.path === path);
				if (!tab) continue;
				try {
					const p = new URLSearchParams({ path });
					if (envId != null) p.set('env', String(envId));
					const r = await fetch(`/api/containers/${container.id}/files/content?${p}`);
					const d = await r.json();
					if (r.ok) {
						tabs = tabs.map((t) =>
							t.path === path
								? { ...t, content: d.content, savedContent: d.content, dirty: false }
								: t
						);
					}
				} catch {
					/* ignore per-file refresh errors */
				}
			}
			if (diffView && written.includes(diffView.filePath)) {
				diffView = null;
			}
			await loadDirectory(currentPath);
			await loadChangedFiles();
			// 写入与已展开的文件都刷新修订明细
			for (const path of new Set([...written, ...expandedHistory])) {
				await loadRevisionsForPath(path);
			}
			if (written.length > 0) {
				expandedHistory = new Set([...expandedHistory, ...written]);
			}
		} catch (err: any) {
			toast.error(err.message || 'Upload failed');
		} finally {
			uploadingArchive = false;
		}
	}

	function onTreeClick(entry: FileEntry) {
		const path = joinPath(currentPath, entry.name);
		if (entry.type === 'directory') {
			loadDirectory(path);
			return;
		}
		openFile(path, entry.name);
	}

	function basename(path: string): string {
		return path.split('/').filter(Boolean).pop() || path;
	}

	/** 按设置中的默认时区与日期时间格式展示修订时间 */
	function formatTime(iso: string | null): string {
		if (!iso) return '';
		try {
			return formatDateTime(iso, true);
		} catch {
			return iso;
		}
	}
</script>

<div class="grid h-full min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[220px_minmax(0,1fr)_280px]">
	<!-- 文件树 -->
	<section class="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
		<div class="flex h-11 shrink-0 items-center gap-1 border-b px-2">
			<span class="px-1 text-sm font-semibold">Files</span>
			<div class="flex-1"></div>
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				disabled={currentPath === '/'}
				onclick={() => loadDirectory(parentPath(currentPath))}
				title="Up"
			>
				<ChevronRight class="h-3.5 w-3.5 rotate-180" />
			</Button>
			{#if canEdit}
				<Button
					variant="ghost"
					size="icon"
					class="h-7 w-7"
					onclick={() => {
						createKind = 'file';
						createName = '';
						createOpen = true;
					}}
					title="New file"
				>
					<FilePlus class="h-3.5 w-3.5" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					class="h-7 w-7"
					onclick={() => {
						createKind = 'directory';
						createName = '';
						createOpen = true;
					}}
					title="New folder"
				>
					<FolderPlus class="h-3.5 w-3.5" />
				</Button>
			{/if}
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => loadDirectory(currentPath)}
			>
				<RefreshCw class="h-3.5 w-3.5 {loadingTree ? 'animate-spin' : ''}" />
			</Button>
		</div>
		<div class="flex min-w-0 items-center gap-0 overflow-x-auto border-b bg-muted/40 px-2 py-1.5 font-mono text-[11px]">
			<button
				type="button"
				class="shrink-0 rounded px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground {currentPath === '/'
					? 'font-semibold text-foreground'
					: ''}"
				onclick={() => navigateToSegment(-1)}
				title="/"
			>/</button>
			{#each pathSegments as segment, i}
				{#if i > 0}
					<span class="shrink-0 text-muted-foreground/50">/</span>
				{/if}
				<button
					type="button"
					class="max-w-[8rem] shrink-0 truncate rounded px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground {i === pathSegments.length - 1
						? 'font-semibold text-foreground'
						: ''}"
					onclick={() => navigateToSegment(i)}
					title={'/' + pathSegments.slice(0, i + 1).join('/')}
				>{segment}</button>
			{/each}
		</div>
		<div class="min-h-0 flex-1 overflow-auto">
			{#if loadingTree}
				<div class="flex justify-center p-6"><Loader2 class="h-5 w-5 animate-spin text-muted-foreground" /></div>
			{:else}
				{#each entries as entry (entry.name)}
					<button
						type="button"
						class="flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs hover:bg-accent {selectedTreeFile ===
						joinPath(currentPath, entry.name)
							? 'bg-primary/10 text-primary font-semibold'
							: ''}"
						onclick={() => onTreeClick(entry)}
					>
						{#if entry.type === 'directory'}
							<Folder class="h-3.5 w-3.5 shrink-0 text-amber-500" />
						{:else}
							<FileIcon class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
						{/if}
						<span class="truncate">{entry.name}</span>
					</button>
				{:else}
					<p class="p-4 text-center text-xs text-muted-foreground">Empty directory</p>
				{/each}
			{/if}
		</div>
	</section>

	<!-- 编辑器 / 修订 diff -->
	<section class="flex min-h-0 flex-col border-b bg-muted/20 lg:border-b-0 lg:border-r">
		{#if diffView}
			<div class="flex h-9 shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2">
				<div class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
					<strong class="text-foreground">Diff</strong>
					<span> · {diffView.filePath}</span>
				</div>
				{#if canEdit}
					<Button
						variant="outline"
						size="sm"
						class="h-7 text-xs"
						onclick={() =>
							restoreRevision({
								id: diffView!.revisionId,
								filePath: diffView!.filePath,
								size: 0,
								source: 'restore',
								sourceLabel: null,
								createdAt: null
							})}
					>
						<RotateCcw class="mr-1 h-3 w-3" />Restore left
					</Button>
				{/if}
				<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={closeDiff}>
					<X class="mr-1 h-3 w-3" />Close
				</Button>
			</div>
			<div class="relative min-h-0 flex-1 bg-background">
				{#if loadingDiff}
					<div class="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
						<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				{/if}
				<FileSideDiff
					left={diffView.left}
					right={diffView.right}
					leftTitle={diffView.leftLabel}
					rightTitle={diffView.rightLabel}
				/>
			</div>
		{:else}
			{#if tabs.length}
				<div class="flex h-9 shrink-0 items-stretch overflow-x-auto border-b bg-muted/40">
					{#each tabs as tab (tab.path)}
						<button
							type="button"
							class="flex items-center gap-1.5 border-r px-3 text-xs whitespace-nowrap {activePath === tab.path
								? 'bg-background font-semibold shadow-[inset_0_-2px_0_hsl(var(--primary))]'
								: 'text-muted-foreground hover:bg-accent'}"
							onclick={() => {
								diffView = null;
								activePath = tab.path;
							}}
						>
							{#if tab.dirty}
								<span class="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
							{/if}
							{tab.name}
							<span
								role="button"
								tabindex="0"
								class="rounded px-0.5 hover:bg-muted"
								onclick={(e) => {
									e.stopPropagation();
									closeTab(tab.path);
								}}
								onkeydown={(e) => {
									if (e.key === 'Enter' || e.key === ' ') {
										e.preventDefault();
										e.stopPropagation();
										closeTab(tab.path);
									}
								}}
							>
								<X class="h-3 w-3" />
							</span>
						</button>
					{/each}
				</div>
			{/if}

			{#if activeTab && !activeTab.path.startsWith('revision:')}
				<div class="flex h-9 shrink-0 flex-wrap items-center gap-1 border-b bg-background px-2">
					<div class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
						<strong class="text-foreground">{container.name}</strong>
						<span> · {activeTab.path}</span>
					</div>
					{#if activeTab.dirty}
						<Badge variant="outline" class="text-[10px] text-amber-700">Unsaved</Badge>
					{/if}
					{#if canEdit}
						<Button variant="outline" size="sm" class="h-7 text-xs" onclick={downloadActive}>
							<Download class="mr-1 h-3 w-3" />Download
						</Button>
						<Button variant="outline" size="sm" class="h-7 text-xs" onclick={openRename}>Rename</Button>
						<Button variant="outline" size="sm" class="h-7 text-xs" onclick={openChmod}>
							<Shield class="mr-1 h-3 w-3" />Chmod
						</Button>
						<ConfirmPopover
							action="Delete"
							itemType="file"
							itemName={activeTab.name}
							confirmText="Delete"
							variant="destructive"
							onConfirm={deleteActive}
						>
							{#snippet children({ open })}
								<span class="inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs text-destructive hover:bg-accent {open ? 'bg-accent' : ''}">
									<Trash2 class="h-3 w-3" />Delete
								</span>
							{/snippet}
						</ConfirmPopover>
						<span class="mx-1 h-4 w-px bg-border"></span>
						<Button
							variant="ghost"
							size="sm"
							class="h-7 text-xs"
							disabled={!activeTab.dirty}
							onclick={discardActive}
						>
							Discard
						</Button>
						<Button
							size="sm"
							class="h-7 text-xs"
							disabled={!activeTab.dirty || saving}
							onclick={saveActive}
						>
							{#if saving}
								<Loader2 class="mr-1 h-3 w-3 animate-spin" />
							{:else}
								<Save class="mr-1 h-3 w-3" />
							{/if}
							Save
						</Button>
					{:else}
						<Button variant="outline" size="sm" class="h-7 text-xs" onclick={downloadActive}>
							<Download class="mr-1 h-3 w-3" />Download
						</Button>
					{/if}
				</div>
			{/if}

			<div class="relative min-h-0 flex-1 bg-background">
				{#if loadingFile || loadingDiff}
					<div class="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
						<Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
					</div>
				{/if}
				{#if activeTab}
					<CodeEditor
						value={activeTab.content}
						language={detectLanguage(activeTab.name)}
						theme="light"
						readonly={!canEdit || activeTab.path.startsWith('revision:')}
						onchange={onEditorChange}
						class="h-full min-h-[240px]"
					/>
				{:else}
					<div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
						<FolderOpen class="h-10 w-10 opacity-40" />
						<p class="text-sm font-medium text-foreground">Open a file to edit</p>
						<p class="max-w-xs text-xs">Click a file in the tree to start editing.</p>
					</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- 压缩包覆盖 + 变更历史 -->
	<section class="flex min-h-0 flex-col">
		<div class="flex h-11 shrink-0 items-center border-b px-3">
			<span class="text-sm font-semibold">Deploy &amp; History</span>
		</div>
		<div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
			<div class="overflow-hidden rounded-md border">
				<div class="border-b bg-muted/40 px-3 py-2 text-xs font-semibold">Upload archive</div>
				<div class="flex flex-col gap-2 p-3">
					<p class="text-[11px] text-muted-foreground">Extract into</p>
					<code class="rounded bg-muted px-2 py-1 font-mono text-[11px] break-all">{uploadTarget}</code>
					<input
						bind:this={archiveInputEl}
						type="file"
						accept=".zip,.tar,.tar.gz,.tgz"
						class="hidden"
						disabled={!canEdit}
						onchange={(e) => {
							const input = e.currentTarget as HTMLInputElement;
							archiveFile = input.files?.[0] ?? null;
						}}
					/>
					<div class="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							class="h-7 shrink-0 text-xs"
							disabled={!canEdit}
							onclick={() => archiveInputEl?.click()}
						>
							Choose file
						</Button>
						<span class="min-w-0 truncate text-[11px] text-muted-foreground">
							{archiveFile?.name || 'No file selected'}
						</span>
					</div>
					<Button
						size="sm"
						class="w-full"
						disabled={!archiveFile || !canEdit || uploadingArchive}
						onclick={uploadArchive}
					>
						{#if uploadingArchive}
							<Loader2 class="mr-1 h-3.5 w-3.5 animate-spin" />
						{:else}
							<Upload class="mr-1 h-3.5 w-3.5" />
						{/if}
						Upload &amp; overwrite
					</Button>
					<p class="text-[10px] text-muted-foreground">Supports .zip / .tar / .tar.gz</p>
				</div>
			</div>

			<div class="flex min-h-[200px] flex-1 flex-col overflow-hidden rounded-md border">
				<div class="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
					<span class="text-xs font-semibold">Changed files</span>
					<span class="text-[11px] text-muted-foreground">{changedFiles.length}</span>
				</div>
				<div class="min-h-0 flex-1 overflow-auto">
					{#if loadingHistory}
						<div class="flex justify-center p-4"><Loader2 class="h-4 w-4 animate-spin" /></div>
					{:else if changedFiles.length === 0}
						<p class="p-4 text-center text-xs text-muted-foreground">No saved revisions yet</p>
					{:else}
						{#each changedFiles as cf (cf.filePath)}
							{@const open = expandedHistory.has(cf.filePath)}
							<div class="border-b {open ? 'bg-primary/5' : ''}">
								<div class="flex items-start gap-0.5 px-1 py-1.5">
									<button
										type="button"
										class="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-accent"
										title="Expand history"
										onclick={() => toggleHistory(cf.filePath)}
									>
										{#if open}
											<ChevronDown class="h-3.5 w-3.5 text-muted-foreground" />
										{:else}
											<ChevronRight class="h-3.5 w-3.5 text-muted-foreground" />
										{/if}
									</button>
									<button
										type="button"
										class="min-w-0 flex-1 rounded px-1 text-left hover:bg-accent"
										onclick={() => openFile(cf.filePath, basename(cf.filePath))}
									>
										<div class="truncate font-mono text-xs font-semibold">{basename(cf.filePath)}</div>
										<div class="truncate text-[11px] text-muted-foreground">{cf.filePath}</div>
										<div class="mt-0.5 text-[11px] text-muted-foreground">
											{formatTime(cf.latestAt)} · {cf.latestSource || ''}
										</div>
									</button>
									<Badge variant="secondary" class="mt-1 shrink-0 text-[10px]">{cf.revisionCount} revs</Badge>
								</div>
								{#if open}
									<div class="space-y-1 border-t bg-background/50 px-2 py-1 pl-7">
										{#each revisionsByPath[cf.filePath] || [] as rev (rev.id)}
											<button
												type="button"
												class="flex w-full items-start gap-2 rounded border p-2 text-left hover:bg-accent {diffView?.revisionId === rev.id
													? 'border-primary bg-primary/5'
													: ''}"
												onclick={() => openRevisionDiff(rev)}
											>
												<div class="min-w-0 flex-1">
													<div class="text-xs font-semibold">
														{rev.sourceLabel || rev.source}
													</div>
													<div class="font-mono text-[11px] text-muted-foreground">
														{formatTime(rev.createdAt)} · {rev.size} B
													</div>
												</div>
												<Badge variant="secondary" class="text-[10px]">#{rev.id}</Badge>
												{#if canEdit}
													<span
														role="button"
														tabindex="0"
														class="inline-flex h-6 shrink-0 items-center gap-0.5 rounded border px-1.5 text-[11px] hover:bg-background"
														onclick={(e) => {
															e.stopPropagation();
															restoreRevision(rev);
														}}
														onkeydown={(e) => {
															if (e.key === 'Enter' || e.key === ' ') {
																e.preventDefault();
																e.stopPropagation();
																restoreRevision(rev);
															}
														}}
													>
														<RotateCcw class="h-3 w-3" />
													</span>
												{/if}
											</button>
										{:else}
											<p class="p-2 text-[11px] text-muted-foreground">No revisions</p>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					{/if}
				</div>
			</div>
		</div>
	</section>
</div>

<Dialog.Root bind:open={renameOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Rename</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label>New name</Label>
			<Input bind:value={renameValue} />
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (renameOpen = false)}>Cancel</Button>
			<Button onclick={submitRename}>Rename</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={chmodOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Change permissions</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label>Mode (octal)</Label>
			<Input bind:value={chmodMode} placeholder="644" />
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (chmodOpen = false)}>Cancel</Button>
			<Button onclick={submitChmod}>Apply</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{createKind === 'file' ? 'New file' : 'New folder'}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label>Name</Label>
			<Input bind:value={createName} placeholder={createKind === 'file' ? 'config.yaml' : 'conf.d'} />
			<p class="text-xs text-muted-foreground">Created in {currentPath}</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
			<Button onclick={createEntry}>Create</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
