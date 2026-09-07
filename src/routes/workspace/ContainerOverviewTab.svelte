<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { appendEnvParam } from '$lib/stores/environment';
	import { canAccess } from '$lib/stores/auth';
	import { formatBytes, formatBytesCompact } from '$lib/utils/format';
	import { formatPorts } from '$lib/utils/port-format';
	import type { ContainerInfo, ContainerStats } from '$lib/types';
	import EditContainerModal from '../containers/EditContainerModal.svelte';
	import {
		Activity,
		Cpu,
		HardDrive,
		Loader2,
		MemoryStick,
		Network,
		Pencil,
		RefreshCw
	} from 'lucide-svelte';

	interface Props {
		container: ContainerInfo & { restartCount?: number };
		envId: number | null;
	}

	let { container, envId }: Props = $props();

	let stats = $state<ContainerStats | null>(null);
	let loadingStats = $state(false);
	let statsInterval: ReturnType<typeof setInterval> | null = null;

	let envVars = $state<{ key: string; value: string }[]>([]);
	let loadingEnv = $state(false);
	let envError = $state('');
	let editOpen = $state(false);

	const canEdit = $derived($canAccess('containers', 'edit'));
	const mappedPorts = $derived(formatPorts(container.ports));
	const primaryIp = $derived(getContainerIp(container.networks));
	const networkEntries = $derived(container.networks ? Object.entries(container.networks) : []);
	const uptime = $derived(formatUptime(container.status));
	const restartCount = $derived(container.restartCount ?? 0);

	function getContainerIp(networks: ContainerInfo['networks']): string {
		if (!networks) return '-';
		const entries = Object.entries(networks);
		if (entries.length === 0) return '-';
		return entries[0][1]?.ipAddress || '-';
	}

	/** 从 Docker Status 文案提取可读运行时长 */
	function formatUptime(status: string): string {
		if (!status) return '-';
		const upMatch = status.match(/Up\s+(.+?)(?:\s+\(|$)/i);
		if (upMatch) return upMatch[1].trim();
		const exitMatch = status.match(/Exited.+?(\d+\s+\w+)\s+ago/i);
		if (exitMatch) return `${exitMatch[1]} ago`;
		return '-';
	}

	async function fetchStats() {
		if (container.state !== 'running') {
			stats = null;
			return;
		}
		loadingStats = true;
		try {
			const res = await fetch(appendEnvParam(`/api/containers/${container.id}/stats`, envId));
			if (!res.ok) {
				stats = null;
				return;
			}
			const data = await res.json();
			if (data.error) {
				stats = null;
				return;
			}
			stats = data as ContainerStats;
		} catch {
			stats = null;
		} finally {
			loadingStats = false;
		}
	}

	/** 从 inspect 读取 Config.Env 并按 key 排序 */
	async function loadEnv() {
		loadingEnv = true;
		envError = '';
		try {
			const res = await fetch(appendEnvParam(`/api/containers/${container.id}`, envId));
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || 'Failed to load container');
			const raw: string[] = data.Config?.Env || [];
			envVars = raw
				.map((line) => {
					const eq = line.indexOf('=');
					if (eq < 0) return { key: line, value: '' };
					return { key: line.slice(0, eq), value: line.slice(eq + 1) };
				})
				.sort((a, b) => a.key.localeCompare(b.key));
		} catch (err: any) {
			envError = err.message || 'Failed to load environment variables';
			envVars = [];
		} finally {
			loadingEnv = false;
		}
	}

	function startPolling() {
		stopPolling();
		fetchStats();
		if (container.state === 'running') {
			statsInterval = setInterval(fetchStats, 2000);
		}
	}

	function stopPolling() {
		if (statsInterval) {
			clearInterval(statsInterval);
			statsInterval = null;
		}
	}

	$effect(() => {
		container.id;
		container.state;
		envId;
		startPolling();
		loadEnv();
		return () => stopPolling();
	});

	onDestroy(stopPolling);
</script>

<div class="flex h-full min-h-0 flex-col overflow-auto p-4">
	<div class="mb-3 flex items-center gap-2">
		<span class="text-sm font-semibold">Overview</span>
		{#if container.state === 'running'}
			<span class="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
				{#if loadingStats && !stats}
					<RefreshCw class="h-3 w-3 animate-spin" />
					Loading stats…
				{:else}
					<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"></span>
					Live
				{/if}
			</span>
		{/if}
	</div>

	<!-- 与 Containers 列表同列信息：健康 / 资源 / 网络 -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
		<div class="rounded-lg border p-3">
			<div class="mb-2 text-[11px] font-medium text-muted-foreground">Health</div>
			{#if container.health}
				<div class="flex items-center gap-2">
					{#if container.health === 'healthy'}
						<span class="h-2.5 w-2.5 animate-pulse rounded-full bg-green-500"></span>
					{:else if container.health === 'unhealthy'}
						<span class="h-2.5 w-2.5 rounded-full bg-red-500"></span>
					{:else}
						<span class="h-2.5 w-2.5 animate-pulse rounded-full bg-yellow-500"></span>
					{/if}
					<span class="text-sm font-medium capitalize">{container.health}</span>
				</div>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 text-[11px] font-medium text-muted-foreground">Uptime</div>
			<div class="text-sm font-medium">{uptime}</div>
			<div class="mt-1 truncate text-[11px] text-muted-foreground" title={container.status}>{container.status}</div>
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 text-[11px] font-medium text-muted-foreground">Restarts</div>
			{#if restartCount > 0}
				<span class="text-sm font-medium text-red-500">{restartCount}</span>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
				<Cpu class="h-3.5 w-3.5 text-blue-500" />
				CPU
			</div>
			{#if stats}
				<span
					class="font-mono text-sm font-semibold {stats.cpuPercent > 80
						? 'text-red-500'
						: stats.cpuPercent > 50
							? 'text-yellow-500'
							: ''}"
				>
					{stats.cpuPercent.toFixed(1)}%
				</span>
			{:else if container.state === 'running'}
				<span class="text-sm text-muted-foreground/50">…</span>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
				<MemoryStick class="h-3.5 w-3.5 text-green-500" />
				Memory
			</div>
			{#if stats}
				{@const tip =
					stats.memoryCache > 0
						? `${formatBytes(stats.memoryUsage)} / ${formatBytes(stats.memoryLimit)} (Total: ${formatBytes(stats.memoryRaw)} | Cache: ${formatBytes(stats.memoryCache)})`
						: `${formatBytes(stats.memoryUsage)} / ${formatBytes(stats.memoryLimit)}`}
				<span
					class="font-mono text-sm font-semibold {stats.memoryPercent > 80
						? 'text-red-500'
						: stats.memoryPercent > 50
							? 'text-yellow-500'
							: ''}"
					title={tip}
				>
					{formatBytesCompact(stats.memoryUsage)}<span class="text-muted-foreground/50"
						>/{formatBytesCompact(stats.memoryLimit, 0)}</span
					>
				</span>
				<div class="mt-1 text-[11px] text-muted-foreground">{stats.memoryPercent.toFixed(1)}%</div>
			{:else if container.state === 'running'}
				<span class="text-sm text-muted-foreground/50">…</span>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
				<Network class="h-3.5 w-3.5 text-purple-500" />
				Net I/O
			</div>
			{#if stats}
				<span
					class="font-mono text-sm"
					title="↓{formatBytes(stats.networkRx)} received / ↑{formatBytes(stats.networkTx)} sent"
				>
					<span class="text-blue-400">↓</span>{formatBytesCompact(stats.networkRx, 0)}
					<span class="text-orange-400">↑</span>{formatBytesCompact(stats.networkTx, 0)}
				</span>
			{:else if container.state === 'running'}
				<span class="text-sm text-muted-foreground/50">…</span>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
				<HardDrive class="h-3.5 w-3.5 text-orange-500" />
				Disk I/O
			</div>
			{#if stats}
				<span
					class="font-mono text-sm"
					title="r{formatBytes(stats.blockRead)} read / w{formatBytes(stats.blockWrite)} written"
				>
					<span class="text-green-400">r</span>{formatBytesCompact(stats.blockRead, 0)}
					<span class="text-yellow-400">w</span>{formatBytesCompact(stats.blockWrite, 0)}
				</span>
			{:else if container.state === 'running'}
				<span class="text-sm text-muted-foreground/50">…</span>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>

		<div class="rounded-lg border p-3">
			<div class="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
				<Activity class="h-3.5 w-3.5" />
				IP
			</div>
			{#if networkEntries.length > 1 && primaryIp !== '-'}
				<code class="text-sm">{primaryIp}</code>
				<div class="mt-1 space-y-0.5">
					{#each networkEntries as [name, net]}
						<div class="font-mono text-[11px] text-muted-foreground">
							{name}: {net.ipAddress || 'no IP'}
						</div>
					{/each}
				</div>
			{:else}
				<code class="text-sm">{primaryIp}</code>
			{/if}
		</div>

		<div class="rounded-lg border p-3 sm:col-span-2 lg:col-span-2">
			<div class="mb-2 text-[11px] font-medium text-muted-foreground">Ports</div>
			{#if mappedPorts.length > 0}
				<div class="flex flex-wrap gap-1">
					{#each mappedPorts as p}
						<Badge variant="secondary" class="font-mono text-[11px]">{p.display}</Badge>
					{/each}
				</div>
			{:else}
				<span class="text-sm text-muted-foreground">-</span>
			{/if}
		</div>
	</div>

	<div class="mt-4 rounded-lg border p-3">
		<div class="mb-2 text-[11px] font-medium text-muted-foreground">Image</div>
		<code class="break-all text-xs">{container.image}</code>
	</div>

	<!-- 环境变量：只读列表，Edit 打开现有编辑弹窗 -->
	<div class="mt-4 flex min-h-0 flex-col rounded-lg border">
		<div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
			<span class="text-xs font-semibold">Environment variables</span>
			<span class="text-[11px] text-muted-foreground">{envVars.length}</span>
			<div class="flex-1"></div>
			<Button variant="ghost" size="icon" class="h-7 w-7" onclick={loadEnv} title="Refresh">
				<RefreshCw class="h-3.5 w-3.5 {loadingEnv ? 'animate-spin' : ''}" />
			</Button>
			{#if canEdit}
				<Button variant="outline" size="sm" class="h-7 gap-1.5 text-xs" onclick={() => (editOpen = true)}>
					<Pencil class="h-3.5 w-3.5" />
					Edit
				</Button>
			{/if}
		</div>
		<div class="max-h-80 overflow-auto p-3">
			{#if loadingEnv && envVars.length === 0}
				<div class="flex justify-center p-6">
					<Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
				</div>
			{:else if envError}
				<p class="p-2 text-center text-sm text-destructive">{envError}</p>
			{:else if envVars.length === 0}
				<p class="p-2 text-center text-sm text-muted-foreground">No environment variables</p>
			{:else}
				<div class="space-y-1">
					{#each envVars as row (row.key)}
						<div class="rounded bg-muted px-2 py-1.5 text-xs">
							<code class="font-medium text-muted-foreground">{row.key}</code>
							<code class="text-muted-foreground">=</code>
							<code class="break-all">{row.value}</code>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

{#if editOpen}
	<EditContainerModal
		bind:open={editOpen}
		containerId={container.id}
		onClose={() => (editOpen = false)}
		onSuccess={() => {
			editOpen = false;
			loadEnv();
		}}
	/>
{/if}
