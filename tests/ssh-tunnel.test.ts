import { describe, it, expect } from 'bun:test';
import { shellQuote } from '../src/lib/server/ssh-shell';

describe('shellQuote', () => {
	it('wraps plain values in single quotes', () => {
		expect(shellQuote('hello')).toBe(`'hello'`);
	});

	it('escapes embedded single quotes', () => {
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});

	it('handles empty string', () => {
		expect(shellQuote('')).toBe(`''`);
	});
});
