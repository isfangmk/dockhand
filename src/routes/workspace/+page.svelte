<svelte:head>
	<title>Workspace - Dockhand</title>
</svelte:head>

<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Badge } from '$lib/components/ui/badge';
	import * as Tabs from '$lib/components/ui/tabs';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ContainerIcon from '$lib/components/ContainerIcon.svelte';
	import ContainerFilesTab from './ContainerFilesTab.svelte';
	import ContainerShellTab from './ContainerShellTab.svelte';
	import ContainerOverviewTab from './ContainerOverviewTab.svelte';
	import LogsPanel from '../logs/LogsPanel.svelte';
	import { NoEnvironment } from '$lib/components/ui/empty-state';
	import type { ContainerInfo } from '$lib/types';
	import { currentEnvironment, appendEnvParam } from '$lib/stores/environment';
	import { canAccess } from '$lib/stores/auth';
	import { toast } from 'svelte-sonner';
	import {
		LayoutPanelLeft,
		Search,
		RefreshCw,
		FolderOpen,
		Terminal,
		ScrollText,
		Activity,
		Play,
		Square,
		RotateCw,
		Loader2
	} from 'lucide-svelte';

	type WorkspaceTab = 'overview' | 'files' | 'terminal' | 'logs';

	let containers = $state<(ContainerInfo & { restartCount?: number })[]>([]);
	let selectedContainer = $state<(ContainerInfo & { restartCount?: number }) | null>(null);
	let envId = $state<number | null>(null);
	let containerSearch = $state('');
	let stateFilter = $state<'running' | 'all'>('running');
	let loadingContainers = $state(false);
	let lifecycleBusy = $state<'start' | 'stop' | 'restart' | null>(null);
	/** 首次打开 Terminal 后保持挂载，切换 Tab 不断开 WebSocket */
	let shellKeepAlive = $state(false);

	const filteredContainers = $derived(() => {
		let list = containers;
		if (stateFilter === 'running') {
			// 启停/重启中间态仍留在 running 筛选项，避免从列表消失
			list = list.filter((c) =>
				['running', 'starting', 'restarting', 'stopping'].includes(c.state.toLowerCase())
			);
		}
		const q = containerSearch.trim().toLowerCase();
		if (!q) return list;
		return list.filter(
			(c) => c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q)
		);
	});

	/** 从 URL 同步 Tab；旧 env 深链并入 overview */
	const activeTab = $derived.by((): WorkspaceTab => {
		const t = $page.url.searchParams.get('tab');
		if (t === 'env') return 'overview';
		if (t === 'overview' || t === 'terminal' || t === 'logs' || t === 'files') return t;
		return 'files';
	});

	// 深链直接进 terminal 时也要挂载并保活
	$effect(() => {
		if (activeTab === 'terminal') shellKeepAlive = true;
	});

	const isRunning = $derived(
		!!selectedContainer &&
			['running', 'restarting', 'stopping'].includes(selectedContainer.state.toLowerCase())
	);
	const isStopped = $derived(
		!!selectedContainer &&
			['exited', 'created', 'dead', 'starting'].includes(selectedContainer.state.toLowerCase())
	);

	/** 列表 / Header 状态徽章样式 */
	function stateBadgeClass(state: string): string {
		const s = state.toLowerCase();
		if (s === 'running') {
			return 'border-green-200 bg-green-50 text-green-700 dark:border-green-900 dark:bg-green-950 dark:text-green-400';
		}
		if (s === 'starting' || s === 'restarting' || s === 'stopping') {
			return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-400';
		}
		if (s === 'exited' || s === 'dead' || s === 'created') {
			return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-400';
		}
		return '';
	}

	const unsubscribeEnv = currentEnvironment.subscribe((env) => {
		envId = env?.id ?? null;
		if (env) {
			fetchContainers();
		} else {
			containers = [];
			selectedContainer = null;
		}
	});

	let containerInterval: ReturnType<typeof setInterval> | null = setInterval(() => {
		// 生命周期操作中勿用轮询覆盖 starting/stopping/restarting
		if (lifecycleBusy) return;
		if (envId != null || $currentEnvironment) fetchContainers({ silent: true });
	}, 15000);

	onDestroy(() => {
		unsubscribeEnv();
		if (containerInterval) clearInterval(containerInterval);
	});

	// URL ?container= 深链：列表加载后自动选中
	$effect(() => {
		const id = $page.url.searchParams.get('container');
		if (id && containers.length && !selectedContainer) {
			const found = containers.find((c) => c.id === id || c.id.startsWith(id));
			if (found) selectContainer(found);
		}
	});

	function apiUrl(path: string): string {
		return appendEnvParam(path, envId);
	}

	async function fetchContainers(opts?: { silent?: boolean }) {
		const silent = opts?.silent === true;
		if (!silent) loadingContainers = true;
		try {
			const res = await fetch(apiUrl('/api/containers?all=true'));
			if (!res.ok) throw new Error('Failed to load containers');
			containers = await res.json();
			if (selectedContainer && !containers.find((c) => c.id === selectedContainer?.id)) {
				selectedContainer = null;
			} else if (selectedContainer) {
				const fresh = containers.find((c) => c.id === selectedContainer?.id);
				if (fresh) {
					// 原地更新展示字段，避免替换对象引用导致 Files 工作区重置编辑内容
					selectedContainer.state = fresh.state;
					selectedContainer.status = fresh.status;
					selectedContainer.health = fresh.health;
					selectedContainer.restartCount = fresh.restartCount;
					selectedContainer.image = fresh.image;
					selectedContainer.ports = fresh.ports;
					selectedContainer.networks = fresh.networks;
					selectedContainer.name = fresh.name;
				}
			}
		} catch (err) {
			console.error(err);
		} finally {
			if (!silent) loadingContainers = false;
		}
	}

	/** 选中容器并写入 URL，便于分享与刷新恢复 */
	function selectContainer(c: ContainerInfo & { restartCount?: number }) {
		if (selectedContainer?.id === c.id) return;
		selectedContainer = c;
		shellKeepAlive = activeTab === 'terminal';
		syncUrl(c.id, activeTab);
	}

	function handleTabChange(tab: string) {
		const next: WorkspaceTab =
			tab === 'overview' || tab === 'terminal' || tab === 'logs' || tab === 'files' ? tab : 'files';
		if (next === 'terminal') shellKeepAlive = true;
		syncUrl(selectedContainer?.id ?? null, next);
	}

	function syncUrl(containerId: string | null, tab: WorkspaceTab) {
		const params = new URLSearchParams();
		if (containerId) params.set('container', containerId);
		if (tab !== 'files') params.set('tab', tab);
		if (envId != null) params.set('env', String(envId));
		const qs = params.toString();
		goto(`/workspace${qs ? `?${qs}` : ''}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	/** 将选中容器与列表中的同 id 项同步到同一状态文案 */
	function patchContainerState(id: string, state: string) {
		if (selectedContainer?.id === id) {
			selectedContainer.state = state;
		}
		containers = containers.map((c) => (c.id === id ? { ...c, state } : c));
	}

	/** 启停/重启对应的本地中间态，完成后由列表接口校正 */
	const LIFECYCLE_PENDING_STATE: Record<'start' | 'stop' | 'restart', string> = {
		start: 'starting',
		stop: 'stopping',
		restart: 'restarting'
	};

	/** 启停/重启：先乐观更新 Badge，完成后再拉列表校正 */
	async function runLifecycle(action: 'start' | 'stop' | 'restart') {
		if (!selectedContainer || lifecycleBusy) return;
		const id = selectedContainer.id;
		const name = selectedContainer.name;
		lifecycleBusy = action;
		patchContainerState(id, LIFECYCLE_PENDING_STATE[action]);
		try {
			const res = await fetch(apiUrl(`/api/containers/${id}/${action}`), { method: 'POST' });
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `Failed to ${action}`);
			toast.success(
				action === 'start' ? `Started ${name}` : action === 'stop' ? `Stopped ${name}` : `Restarted ${name}`
			);
			await fetchContainers();
		} catch (err: any) {
			toast.error(err.message || `Failed to ${action}`);
			await fetchContainers();
		} finally {
			lifecycleBusy = null;
		}
	}
</script>

{#if !$currentEnvironment}
	<NoEnvironment />
{:else}
	<div class="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col gap-2 p-3 md:p-4">
		<div class="flex shrink-0 items-center gap-3">
			<PageHeader icon={LayoutPanelLeft as any} title="Workspace" count={filteredContainers().length} />
		</div>

		<div class="grid min-h-0 flex-1 grid-cols-1 overflow-hidden rounded-lg border bg-card lg:grid-cols-[220px_minmax(0,1fr)]">
			<!-- 容器列表 -->
			<section class="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
				<div class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
					<span class="text-sm font-semibold">Containers</span>
					<span class="text-xs text-muted-foreground">{filteredContainers().length}</span>
					<div class="flex-1"></div>
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={() => fetchContainers()}>
						<RefreshCw class="h-3.5 w-3.5 {loadingContainers ? 'animate-spin' : ''}" />
					</Button>
				</div>
				<div class="flex shrink-0 gap-1.5 border-b bg-muted/40 p-2">
					<div class="relative min-w-0 flex-1">
						<Search class="pointer-events-none absolute top-1.5 left-2 h-3.5 w-3.5 text-muted-foreground" />
						<Input class="h-7 pl-7 text-xs" placeholder="Search…" bind:value={containerSearch} />
					</div>
					<select class="h-7 rounded-md border bg-background px-1.5 text-xs" bind:value={stateFilter}>
						<option value="running">running</option>
						<option value="all">all</option>
					</select>
				</div>
				<div class="min-h-0 flex-1 overflow-auto">
					{#each filteredContainers() as c (c.id)}
						<button
							type="button"
							class="flex w-full items-start gap-2 border-b px-3 py-2 text-left hover:bg-accent {selectedContainer?.id === c.id
								? 'bg-primary/10 shadow-[inset_2px_0_0_hsl(var(--primary))]'
								: ''}"
							onclick={() => selectContainer(c)}
						>
							<ContainerIcon
								name={c.name}
								image={c.image}
								envId={envId}
								showFallbackWhenOff={true}
								class="mt-0.5 h-7 w-7 shrink-0"
							/>
							<span class="min-w-0 flex-1">
								<span class="block truncate text-sm font-semibold">{c.name}</span>
								<span class="mt-0.5 block truncate text-[11px] text-muted-foreground">{c.image}</span>
							</span>
							<Badge variant="outline" class="mt-0.5 shrink-0 text-[10px] {stateBadgeClass(c.state)}">
								{c.state}
							</Badge>
						</button>
					{:else}
						<p class="p-4 text-center text-xs text-muted-foreground">No containers</p>
					{/each}
				</div>
			</section>

			<!-- 右侧：选中容器后显示 Header + Tab 工作区 -->
			{#if selectedContainer}
				<section class="flex min-h-0 flex-1 flex-col overflow-hidden">
					<div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
						<ContainerIcon
							name={selectedContainer.name}
							image={selectedContainer.image}
							envId={envId}
							showFallbackWhenOff={true}
							class="h-8 w-8 shrink-0"
						/>
						<span class="min-w-0 truncate text-base font-semibold">{selectedContainer.name}</span>
						<Badge
							variant="outline"
							class="shrink-0 text-[10px] {stateBadgeClass(selectedContainer.state)}"
						>
							{selectedContainer.state}
						</Badge>
						<!-- 状态旁快捷生命周期操作 -->
						{#if isRunning}
							{#if $canAccess('containers', 'restart')}
								<Button
									variant="outline"
									size="sm"
									class="h-7 gap-1.5 text-xs"
									disabled={lifecycleBusy !== null}
									onclick={() => runLifecycle('restart')}
								>
									{#if lifecycleBusy === 'restart'}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<RotateCw class="h-3.5 w-3.5" />
									{/if}
									Restart
								</Button>
							{/if}
							{#if $canAccess('containers', 'stop')}
								<Button
									variant="outline"
									size="sm"
									class="h-7 gap-1.5 text-xs"
									disabled={lifecycleBusy !== null}
									onclick={() => runLifecycle('stop')}
								>
									{#if lifecycleBusy === 'stop'}
										<Loader2 class="h-3.5 w-3.5 animate-spin" />
									{:else}
										<Square class="h-3.5 w-3.5" />
									{/if}
									Stop
								</Button>
							{/if}
						{:else if isStopped && $canAccess('containers', 'start')}
							<Button
								variant="outline"
								size="sm"
								class="h-7 gap-1.5 text-xs"
								disabled={lifecycleBusy !== null}
								onclick={() => runLifecycle('start')}
							>
								{#if lifecycleBusy === 'start'}
									<Loader2 class="h-3.5 w-3.5 animate-spin" />
								{:else}
									<Play class="h-3.5 w-3.5" />
								{/if}
								Start
							</Button>
						{/if}
					</div>

					<Tabs.Root
						value={activeTab}
						onValueChange={handleTabChange}
						class="flex min-h-0 flex-1 flex-col"
					>
						<Tabs.List class="h-auto w-full shrink-0 justify-start gap-0 rounded-none border-b bg-transparent p-0">
							<Tabs.Trigger
								value="overview"
								class="relative rounded-none border-b-2 border-transparent px-4 py-2.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								<Activity class="mr-1.5 h-3.5 w-3.5" />
								Overview
							</Tabs.Trigger>
							<Tabs.Trigger
								value="files"
								class="relative rounded-none border-b-2 border-transparent px-4 py-2.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								<FolderOpen class="mr-1.5 h-3.5 w-3.5" />
								Files
							</Tabs.Trigger>
							<Tabs.Trigger
								value="terminal"
								class="relative rounded-none border-b-2 border-transparent px-4 py-2.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								<Terminal class="mr-1.5 h-3.5 w-3.5" />
								Terminal
							</Tabs.Trigger>
							<Tabs.Trigger
								value="logs"
								class="relative rounded-none border-b-2 border-transparent px-4 py-2.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
							>
								<ScrollText class="mr-1.5 h-3.5 w-3.5" />
								Logs
							</Tabs.Trigger>
						</Tabs.List>

						<Tabs.Content value="overview" class="flex min-h-0 flex-1 flex-col overflow-hidden pt-0 data-[state=inactive]:hidden">
							{#if activeTab === 'overview'}
								{#key selectedContainer.id}
									<ContainerOverviewTab container={selectedContainer} {envId} />
								{/key}
							{/if}
						</Tabs.Content>
						<Tabs.Content value="files" class="flex min-h-0 flex-1 flex-col overflow-hidden pt-0 data-[state=inactive]:hidden">
							{#if activeTab === 'files'}
								<ContainerFilesTab container={selectedContainer} {envId} />
							{/if}
						</Tabs.Content>
						<!-- 首次打开后保持挂载，切换 Tab 仅 CSS 隐藏以维持终端长连接 -->
						<Tabs.Content
							value="terminal"
							class="flex min-h-0 flex-1 flex-col overflow-hidden pt-0 data-[state=inactive]:hidden"
						>
							{#if shellKeepAlive}
								{#key selectedContainer.id}
									<ContainerShellTab
										containerId={selectedContainer.id}
										containerName={selectedContainer.name}
										{envId}
										visible={activeTab === 'terminal'}
									/>
								{/key}
							{/if}
						</Tabs.Content>
						<!-- 仅激活时挂载，避免后台占用日志 SSE -->
						<Tabs.Content value="logs" class="flex min-h-0 flex-1 flex-col overflow-hidden pt-0 data-[state=inactive]:hidden">
							{#if activeTab === 'logs'}
								{#key selectedContainer.id}
									<LogsPanel
										containerId={selectedContainer.id}
										containerName={selectedContainer.name}
										visible={true}
										{envId}
										fillHeight={true}
										showCloseButton={false}
										onClose={() => {}}
									/>
								{/key}
							{/if}
						</Tabs.Content>
					</Tabs.Root>
				</section>
			{:else}
				<div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
					<LayoutPanelLeft class="h-10 w-10 opacity-40" />
					<p class="text-sm font-medium text-foreground">Select a container</p>
					<p class="max-w-xs text-xs">
						Choose a container to open overview, files, terminal, and logs.
					</p>
				</div>
			{/if}
		</div>
	</div>
{/if}
