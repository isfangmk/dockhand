<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import Terminal from '../terminal/Terminal.svelte';
	import {
		detectShells,
		getBestShell,
		hasAvailableShell,
		USER_OPTIONS,
		getSavedUser,
		saveUserForContainer,
		getCustomUsers,
		removeCustomUser,
		type ShellDetectionResult
	} from '$lib/utils/shell-detection';
	import {
		AlertCircle,
		Copy,
		Loader2,
		RefreshCw,
		Shell,
		Trash2,
		User
	} from 'lucide-svelte';

	interface Props {
		containerId: string;
		containerName: string;
		envId: number | null;
		/** 当前是否为可见 Tab；隐藏时不断开连接，重新显示时重新 fit */
		visible?: boolean;
	}

	let { containerId, containerName, envId, visible = true }: Props = $props();

	let terminalComponent: ReturnType<typeof Terminal> | undefined;
	let connected = $state(false);
	let shellDetection = $state<ShellDetectionResult | null>(null);
	let detectingShells = $state(false);
	let selectedShell = $state('/bin/bash');
	let selectedUser = $state('root');
	let committedUser = $state('root');
	let customUserInput = $state('');
	let customUsers = $state<string[]>([]);
	let terminalFontSize = $state(14);
	let prevShell = $state('/bin/bash');
	let prevUser = $state('root');

	const fontSizeOptions = [10, 12, 14, 16, 18];

	const selectedShellAvailable = $derived(
		!shellDetection || shellDetection.shells.includes(selectedShell)
	);
	const anyShellAvailable = $derived(!shellDetection || hasAvailableShell(shellDetection));

	let connectedPoll: ReturnType<typeof setInterval> | null = null;

	function commitUser(user: string) {
		committedUser = user;
		saveUserForContainer(containerId, user);
		customUsers = getCustomUsers();
	}

	function onUserSelectChange(value: string) {
		commitUser(value);
	}

	function onCustomUserKeydown(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter' && customUserInput.trim()) {
			const newUser = customUserInput.trim();
			selectedUser = newUser;
			commitUser(newUser);
			customUserInput = '';
		}
	}

	function changeFontSize(newSize: number) {
		terminalFontSize = newSize;
		terminalComponent?.setFontSize(newSize);
	}

	/** 检测可用 shell，并恢复该容器上次选用的用户 */
	async function initShell() {
		detectingShells = true;
		shellDetection = null;
		customUsers = getCustomUsers();
		try {
			shellDetection = await detectShells(containerId, envId);
			const best = getBestShell(shellDetection, selectedShell);
			if (best && best !== selectedShell) selectedShell = best;
			const saved = getSavedUser(containerId);
			selectedUser = saved ?? 'root';
			committedUser = selectedUser;
		} catch (err) {
			console.error('Failed to detect shells:', err);
		} finally {
			detectingShells = false;
		}
	}

	$effect(() => {
		containerId;
		envId;
		initShell();
	});

	$effect(() => {
		if (connected && terminalComponent) {
			if (selectedShell !== prevShell || committedUser !== prevUser) {
				terminalComponent.reconnect();
			}
		}
		prevShell = selectedShell;
		prevUser = committedUser;
	});

	// Tab 再次显示时校准 xterm 尺寸（隐藏期间容器宽高为 0）
	$effect(() => {
		if (visible && terminalComponent) {
			requestAnimationFrame(() => {
				terminalComponent?.fit();
				terminalComponent?.focus();
			});
		}
	});

	connectedPoll = setInterval(() => {
		if (terminalComponent) connected = terminalComponent.getConnected();
	}, 500);

	onDestroy(() => {
		if (connectedPoll) clearInterval(connectedPoll);
		terminalComponent?.dispose();
	});
</script>

<div class="flex h-full min-h-0 flex-col gap-2 p-2">
	<div class="flex shrink-0 flex-wrap items-center gap-3">
		<div class="flex items-center gap-2">
			<Label class="text-xs text-muted-foreground">Shell</Label>
			{#if detectingShells}
				<div class="flex h-8 w-36 items-center justify-center rounded-md border bg-muted/50">
					<Loader2 class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
				</div>
			{:else}
				<Select.Root type="single" bind:value={selectedShell}>
					<Select.Trigger class="h-8 w-40 text-xs" disabled={!anyShellAvailable}>
						<Shell class="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
						<span class={!selectedShellAvailable ? 'text-muted-foreground line-through' : ''}>
							{shellDetection?.allShells.find((o) => o.path === selectedShell)?.label ||
								selectedShell}
						</span>
					</Select.Trigger>
					<Select.Content>
						{#if shellDetection}
							{#each shellDetection.allShells as option}
								<Select.Item value={option.path} label={option.label} disabled={!option.available}>
									<span class={option.available ? '' : 'text-muted-foreground/60'}>
										{option.label}
										{#if !option.available}
											<span class="ml-1 text-xs">(unavailable)</span>
										{/if}
									</span>
								</Select.Item>
							{/each}
						{:else}
							<Select.Item value="/bin/bash" label="Bash">Bash</Select.Item>
							<Select.Item value="/bin/sh" label="Shell (sh)">Shell (sh)</Select.Item>
						{/if}
					</Select.Content>
				</Select.Root>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			<Label class="text-xs text-muted-foreground">User</Label>
			<Select.Root type="single" bind:value={selectedUser} onValueChange={onUserSelectChange}>
				<Select.Trigger class="h-8 w-44 text-xs">
					<User class="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
					<span>{USER_OPTIONS.find((o) => o.value === selectedUser)?.label || selectedUser}</span>
				</Select.Trigger>
				<Select.Content>
					{#each USER_OPTIONS as option}
						<Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
					{/each}
					{#if customUsers.length > 0}
						<div class="my-1 h-px bg-border"></div>
						{#each customUsers as cu}
							<div class="group flex items-center">
								<Select.Item value={cu} label={cu} class="flex-1">{cu}</Select.Item>
								<button
									type="button"
									class="mr-1 p-1 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
									onclick={(e) => {
										e.stopPropagation();
										e.preventDefault();
										removeCustomUser(cu);
										customUsers = getCustomUsers();
										if (selectedUser === cu) {
											selectedUser = 'root';
											commitUser('root');
										}
									}}
									title="Remove user"
								>
									<Trash2 class="h-3 w-3" />
								</button>
							</div>
						{/each}
					{/if}
					<div class="my-1 h-px bg-border"></div>
					<div class="px-2 py-1">
						<Input
							class="h-7 text-xs"
							placeholder="Add user… (Enter)"
							bind:value={customUserInput}
							onkeydown={onCustomUserKeydown}
							onclick={(e) => e.stopPropagation()}
						/>
					</div>
				</Select.Content>
			</Select.Root>
		</div>
	</div>

	<div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border bg-zinc-950">
		{#if detectingShells}
			<div class="flex h-full items-center justify-center text-muted-foreground">
				<div class="text-center">
					<Loader2 class="mx-auto mb-3 h-10 w-10 animate-spin opacity-50" />
					<p class="text-sm">Detecting available shells…</p>
				</div>
			</div>
		{:else if !anyShellAvailable}
			<div class="flex h-full items-center justify-center text-muted-foreground">
				<div class="text-center">
					<AlertCircle class="mx-auto mb-3 h-10 w-10 text-amber-500 opacity-50" />
					<p class="font-medium text-amber-500">No shell available in this container</p>
					<p class="mt-2 text-xs">Distroless or scratch images often omit a shell.</p>
				</div>
			</div>
		{:else}
			<div class="flex shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-900/50 px-3 py-1.5">
				{#if connected}
					<span class="inline-flex items-center gap-1 text-xs text-green-500">
						<span class="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"></span>
						Connected
					</span>
				{:else}
					<span class="text-xs text-zinc-500">Disconnected</span>
				{/if}
				<div class="flex items-center gap-2">
					<Select.Root
						type="single"
						value={String(terminalFontSize)}
						onValueChange={(v) => changeFontSize(Number(v))}
					>
						<Select.Trigger class="!h-5 w-14 border-zinc-700 bg-zinc-800 px-1.5 text-xs text-zinc-300 !py-0 [&_svg]:size-3">
							<span>{terminalFontSize}px</span>
						</Select.Trigger>
						<Select.Content>
							{#each fontSizeOptions as size}
								<Select.Item value={String(size)} label="{size}px" class="pe-2 [&>span:first-child]:hidden"
									>{size}px</Select.Item
								>
							{/each}
						</Select.Content>
					</Select.Root>
					<button
						type="button"
						class="rounded p-1 hover:bg-zinc-800"
						title="Copy output"
						onclick={() => terminalComponent?.copyOutput()}
					>
						<Copy class="h-3 w-3 text-zinc-500 hover:text-zinc-300" />
					</button>
					<button
						type="button"
						class="rounded p-1 hover:bg-zinc-800"
						title="Clear"
						onclick={() => terminalComponent?.clear()}
					>
						<Trash2 class="h-3 w-3 text-zinc-500 hover:text-zinc-300" />
					</button>
					<button
						type="button"
						class="rounded p-1 hover:bg-zinc-800"
						title="Reconnect"
						onclick={() => terminalComponent?.reconnect()}
					>
						<RefreshCw class="h-3 w-3 text-zinc-500 hover:text-zinc-300" />
					</button>
				</div>
			</div>
			<div class="min-h-0 w-full flex-1">
				{#key `${containerId}-${selectedShell}-${committedUser}`}
					<Terminal
						bind:this={terminalComponent}
						{containerId}
						{containerName}
						shell={selectedShell}
						user={committedUser}
						{envId}
						fontSize={terminalFontSize}
					/>
				{/key}
			</div>
		{/if}
	</div>
</div>

<style>
	:global(.xterm) {
		height: 100%;
		padding: 8px;
	}
	:global(.xterm-viewport) {
		overflow-y: auto !important;
	}
</style>
