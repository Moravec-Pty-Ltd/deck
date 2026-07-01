// Minimal ANSI SGR parser for `tmux capture-pane -e` output. Produces styled
// text segments; rendering (and theme handling) is the component's job.

export interface AnsiSegment {
	text: string;
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	inverse?: boolean;
}

// Standard xterm-ish 16-color palette. Mid-toned so it reads on both light and
// dark backgrounds; the default (uncolored) text inherits the theme color.
const BASIC = [
	'#000000', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf'
];
const BRIGHT = [
	'#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'
];

function color256(n: number): string {
	if (n < 16) return n < 8 ? BASIC[n] : BRIGHT[n - 8];
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `rgb(${v},${v},${v})`;
	}
	const i = n - 16;
	const r = Math.floor(i / 36);
	const g = Math.floor((i % 36) / 6);
	const b = i % 6;
	const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
	return `rgb(${c(r)},${c(g)},${c(b)})`;
}

interface State {
	fg?: string;
	bg?: string;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	inverse: boolean;
}

function fresh(): State {
	return { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, inverse: false };
}

function applySgr(state: State, codes: number[]) {
	for (let i = 0; i < codes.length; i++) {
		const c = codes[i];
		if (c === 0) Object.assign(state, fresh());
		else if (c === 1) state.bold = true;
		else if (c === 2) state.dim = true;
		else if (c === 3) state.italic = true;
		else if (c === 4) state.underline = true;
		else if (c === 7) state.inverse = true;
		else if (c === 22) state.bold = state.dim = false;
		else if (c === 23) state.italic = false;
		else if (c === 24) state.underline = false;
		else if (c === 27) state.inverse = false;
		else if (c >= 30 && c <= 37) state.fg = BASIC[c - 30];
		else if (c === 39) state.fg = undefined;
		else if (c >= 40 && c <= 47) state.bg = BASIC[c - 40];
		else if (c === 49) state.bg = undefined;
		else if (c >= 90 && c <= 97) state.fg = BRIGHT[c - 90];
		else if (c >= 100 && c <= 107) state.bg = BRIGHT[c - 100];
		else if (c === 38 || c === 48) {
			const target = c === 38 ? 'fg' : 'bg';
			if (codes[i + 1] === 5) {
				state[target] = color256(codes[i + 2] ?? 0);
				i += 2;
			} else if (codes[i + 1] === 2) {
				const r = codes[i + 2] ?? 0;
				const g = codes[i + 3] ?? 0;
				const b = codes[i + 4] ?? 0;
				state[target] = `rgb(${r},${g},${b})`;
				i += 4;
			}
		}
	}
}

// One pass handles everything. The alternatives, in order:
//  1. SGR colour code (group 1 = params) — interpreted into segment styling.
//  2. OSC string (hyperlinks/titles), BEL- or ST-terminated — dropped.
//  3. Any other CSI (cursor moves, private modes, bracketed paste): params,
//     intermediates, then a final byte in the full 0x40-0x7E range so `~`-style
//     terminators (e.g. ESC[200~) don't leak. The final byte stays optional so a
//     capture truncated mid-escape is still stripped rather than half-rendered.
//  4. Charset designators / stray ESC]/( / ) leftovers — dropped.
// Every escape is consumed here, so the text between matches is already clean and
// needs no per-segment scrubbing.
// eslint-disable-next-line no-control-regex
const ANSI =
	/\x1b\[([0-9;]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]?|\x1b[\]()][0-9;?]*[A-Za-z]?/g;

export function parseAnsi(input: string): AnsiSegment[] {
	const segments: AnsiSegment[] = [];
	const state = fresh();
	let last = 0;
	let m: RegExpExecArray | null;
	ANSI.lastIndex = 0;

	const push = (text: string) => {
		if (!text) return;
		segments.push({
			text,
			fg: state.fg,
			bg: state.bg,
			bold: state.bold,
			dim: state.dim,
			italic: state.italic,
			underline: state.underline,
			inverse: state.inverse
		});
	};

	while ((m = ANSI.exec(input)) !== null) {
		push(input.slice(last, m.index));
		if (m[1] !== undefined) {
			const codes = m[1] === '' ? [0] : m[1].split(';').map((n) => parseInt(n, 10) || 0);
			applySgr(state, codes);
		}
		last = m.index + m[0].length;
	}
	push(input.slice(last));
	return segments;
}
