export type DiffLineType = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';
export interface DiffLine {
	type: DiffLineType;
	text: string;
}

// Line-level diff between two snippets via LCS. Used for Edit/MultiEdit where we
// only have old_string/new_string. Falls back to a plain remove+add block for
// large inputs to avoid an O(n*m) table blowup.
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
	const a = oldStr.split('\n');
	const b = newStr.split('\n');
	if (a.length > 800 || b.length > 800) {
		return [
			...a.map((text): DiffLine => ({ type: 'del', text })),
			...b.map((text): DiffLine => ({ type: 'add', text }))
		];
	}
	const n = a.length;
	const m = b.length;
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ type: 'ctx', text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ type: 'del', text: a[i] });
			i++;
		} else {
			out.push({ type: 'add', text: b[j] });
			j++;
		}
	}
	while (i < n) out.push({ type: 'del', text: a[i++] });
	while (j < m) out.push({ type: 'add', text: b[j++] });
	return out;
}

// Whole content rendered as added lines (for Write).
export function addedLines(content: string): DiffLine[] {
	return content.split('\n').map((text): DiffLine => ({ type: 'add', text }));
}

// Heuristic: does this text look like unified diff output (e.g. from `git diff`)?
export function looksLikeDiff(text: string): boolean {
	if (/^diff --git /m.test(text)) return true;
	return /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text);
}

// Classify a single line of unified-diff text.
function unifiedLineType(line: string): DiffLineType {
	if (line.startsWith('@@')) return 'hunk';
	if (
		line.startsWith('+++') ||
		line.startsWith('---') ||
		line.startsWith('diff ') ||
		line.startsWith('index ') ||
		line.startsWith('new file') ||
		line.startsWith('deleted file') ||
		line.startsWith('rename ') ||
		line.startsWith('similarity ') ||
		line.startsWith('\\ No newline')
	) {
		return 'meta';
	}
	if (line.startsWith('+')) return 'add';
	if (line.startsWith('-')) return 'del';
	return 'ctx';
}

// Parse unified-diff text into typed lines, stripping the leading +/-/space marker
// (the Diff component renders its own gutter sign).
export function parseUnified(text: string): DiffLine[] {
	return text.split('\n').map((line): DiffLine => {
		const type = unifiedLineType(line);
		const text = type === 'add' || type === 'del' || type === 'ctx' ? line.slice(1) : line;
		return { type, text };
	});
}
