import { describe, expect, it } from 'bun:test';
import { buildSideBySideDiff } from '../src/lib/utils/text-diff';

describe('buildSideBySideDiff', () => {
	it('aligns identical files as same rows', () => {
		const rows = buildSideBySideDiff('a\nb\n', 'a\nb\n');
		expect(rows.every((r) => r.leftType === 'same' && r.rightType === 'same')).toBe(true);
		expect(rows.map((r) => r.left)).toEqual(['a', 'b', '']);
	});

	it('marks removed and added lines', () => {
		const rows = buildSideBySideDiff('a\nb\nc\n', 'a\nx\nc\n');
		const removed = rows.filter((r) => r.leftType === 'removed');
		const added = rows.filter((r) => r.rightType === 'added');
		expect(removed.some((r) => r.left === 'b')).toBe(true);
		expect(added.some((r) => r.right === 'x')).toBe(true);
	});
});
