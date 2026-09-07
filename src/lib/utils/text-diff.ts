/**
 * 按行 LCS 生成左右并排 diff 行，供 Files 页修订对比使用。
 */

export type DiffSide = 'same' | 'removed' | 'added' | 'empty';

export interface DiffRow {
	left: string | null;
	right: string | null;
	leftType: DiffSide;
	rightType: DiffSide;
	leftNo: number | null;
	rightNo: number | null;
}

/** Myers/LCS 风格的按行对齐；行数过大时退化为未对齐左右对照，避免 O(n·m) 爆内存 */
export function buildSideBySideDiff(leftText: string, rightText: string): DiffRow[] {
	const left = splitLines(leftText);
	const right = splitLines(rightText);
	const n = left.length;
	const m = right.length;

	if (n * m > 2_000_000 || n + m > 8000) {
		return buildUnalignedDiff(left, right);
	}

	// dp[i][j] = LCS length of left[i..] and right[j..]
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			if (left[i] === right[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
			else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const rows: DiffRow[] = [];
	let i = 0;
	let j = 0;
	let leftNo = 1;
	let rightNo = 1;

	while (i < n || j < m) {
		if (i < n && j < m && left[i] === right[j]) {
			rows.push({
				left: left[i],
				right: right[j],
				leftType: 'same',
				rightType: 'same',
				leftNo: leftNo++,
				rightNo: rightNo++
			});
			i++;
			j++;
		} else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
			rows.push({
				left: null,
				right: right[j],
				leftType: 'empty',
				rightType: 'added',
				leftNo: null,
				rightNo: rightNo++
			});
			j++;
		} else if (i < n) {
			rows.push({
				left: left[i],
				right: null,
				leftType: 'removed',
				rightType: 'empty',
				leftNo: leftNo++,
				rightNo: null
			});
			i++;
		}
	}

	return rows;
}

function buildUnalignedDiff(left: string[], right: string[]): DiffRow[] {
	const rows: DiffRow[] = [];
	const len = Math.max(left.length, right.length);
	for (let i = 0; i < len; i++) {
		const l = i < left.length ? left[i] : null;
		const r = i < right.length ? right[i] : null;
		const same = l !== null && r !== null && l === r;
		rows.push({
			left: l,
			right: r,
			leftType: l === null ? 'empty' : same ? 'same' : 'removed',
			rightType: r === null ? 'empty' : same ? 'same' : 'added',
			leftNo: l === null ? null : i + 1,
			rightNo: r === null ? null : i + 1
		});
	}
	return rows;
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const lines = text.split('\n');
	// 保留末尾空行语义：split 后若原文不以 \n 结尾，最后一段仍是内容行
	return lines;
}
