<script lang="ts">
	import { buildSideBySideDiff, type DiffRow } from '$lib/utils/text-diff';

	interface Props {
		left: string;
		right: string;
		leftTitle?: string;
		rightTitle?: string;
	}

	let { left, right, leftTitle = 'Revision', rightTitle = 'Latest' }: Props = $props();

	const rows = $derived(buildSideBySideDiff(left, right));

	function cellClass(type: DiffRow['leftType']): string {
		switch (type) {
			case 'removed':
				return 'bg-red-500/10 text-red-800 dark:text-red-300';
			case 'added':
				return 'bg-green-500/10 text-green-800 dark:text-green-300';
			case 'empty':
				return 'bg-muted/40 text-transparent';
			default:
				return '';
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden text-xs">
	<div class="grid shrink-0 grid-cols-2 border-b bg-muted/40">
		<div class="truncate border-r px-3 py-1.5 font-medium">{leftTitle}</div>
		<div class="truncate px-3 py-1.5 font-medium">{rightTitle}</div>
	</div>
	<div class="min-h-0 flex-1 overflow-auto font-mono leading-5">
		{#each rows as row, idx (idx)}
			<div class="grid grid-cols-2">
				<div class="flex border-r {cellClass(row.leftType)}">
					<span class="w-10 shrink-0 select-none border-r border-black/5 px-1 text-right text-[10px] text-muted-foreground tabular-nums">
						{row.leftNo ?? ''}
					</span>
					<pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre px-2 py-0.5">{row.left ?? ' '}</pre>
				</div>
				<div class="flex {cellClass(row.rightType)}">
					<span class="w-10 shrink-0 select-none border-r border-black/5 px-1 text-right text-[10px] text-muted-foreground tabular-nums">
						{row.rightNo ?? ''}
					</span>
					<pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre px-2 py-0.5">{row.right ?? ' '}</pre>
				</div>
			</div>
		{:else}
			<p class="p-4 text-center text-muted-foreground">No content</p>
		{/each}
	</div>
</div>
