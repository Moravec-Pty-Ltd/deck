// Five-field cron, parsed and walked in the deck machine's local time (issue
// #235). Shared by the server, which stores each schedule's due time, and the
// web form, which previews the next few runs so an expression explains itself
// without anyone having to trust a hand-written English description of it.
//
// No dependency: the syntax below is the whole of what deck accepts, and a
// parser for it is smaller than the arguments about which package to take.

// `minute hour day-of-month month day-of-week`, each field a comma-separated
// list of `*`, `n`, `a-b`, or any of those with a `/step`.
export interface CronSpec {
	minute: Set<number>;
	hour: Set<number>;
	dom: Set<number>;
	month: Set<number>;
	dow: Set<number>;
	// Whether the day fields were narrowed at all, which is what decides between
	// cron's and/or day rule (see dayMatches).
	domRestricted: boolean;
	dowRestricted: boolean;
}

// Names are accepted for the two fields that have them, so `0 9 * * mon-fri`
// works. Sunday is 0; cron also allows 7, normalised below.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldRange {
	min: number;
	max: number;
	names?: string[];
}

const FIELDS: { key: 'minute' | 'hour' | 'dom' | 'month' | 'dow'; label: string; range: FieldRange }[] = [
	{ key: 'minute', label: 'minute', range: { min: 0, max: 59 } },
	{ key: 'hour', label: 'hour', range: { min: 0, max: 23 } },
	{ key: 'dom', label: 'day of month', range: { min: 1, max: 31 } },
	{ key: 'month', label: 'month', range: { min: 1, max: 12, names: MONTHS } },
	{ key: 'dow', label: 'day of week', range: { min: 0, max: 7, names: DAYS } }
];

export class CronError extends Error {}

function fail(field: string, part: string): never {
	throw new CronError(`${field}: cannot read "${part}"`);
}

// One endpoint: a number, or a three-letter name where the field has them.
function value(part: string, field: string, range: FieldRange): number {
	const named = range.names?.indexOf(part.toLowerCase().slice(0, 3)) ?? -1;
	const n = named >= 0 && /^[a-z]+$/i.test(part) ? named + range.min : Number(part);
	if (!Number.isInteger(n) || n < range.min || n > range.max) fail(field, part);
	return n;
}

// The `/step` half of a term. Absent means every value in the span.
function stepOf(text: string | undefined, field: string, part: string): number {
	if (text === undefined) return 1;
	const step = Number(text);
	if (!Number.isInteger(step) || step < 1) fail(field, part);
	return step;
}

// The values a term's span covers, before its step thins them out. `*` is the
// whole field, `a-b` is that range, and a bare `a` is just itself — unless a
// step follows, which crontab(5) reads as a to the end of the field, so `5/15`
// in the minute field is 5, 20, 35 and 50.
function spanOf(
	text: string,
	stepped: boolean,
	field: string,
	range: FieldRange,
	part: string
): { from: number; to: number } {
	if (text === '*') return { from: range.min, to: range.max };
	if (text === '') fail(field, part);
	const [start, end, ...extra] = text.split('-');
	if (extra.length) fail(field, part);
	const from = value(start, field, range);
	const to = end === undefined ? (stepped ? range.max : from) : value(end, field, range);
	if (to < from) fail(field, part);
	return { from, to };
}

// One comma-separated term, added into `out`.
function term(part: string, field: string, range: FieldRange, out: Set<number>): void {
	const [spanText, stepText, ...extra] = part.split('/');
	if (extra.length) fail(field, part);
	const step = stepOf(stepText, field, part);
	const { from, to } = spanOf(spanText, stepText !== undefined, field, range, part);
	for (let n = from; n <= to; n += step) out.add(n);
}

function field(text: string, label: string, range: FieldRange): { values: Set<number>; restricted: boolean } {
	const values = new Set<number>();
	for (const part of text.split(',')) term(part.trim(), label, range, values);
	if (!values.size) fail(label, text);
	return { values, restricted: text.trim() !== '*' };
}

// Parse an expression, throwing a CronError naming the field that failed.
export function parseCron(expression: string): CronSpec {
	const parts = expression.trim().split(/\s+/).filter(Boolean);
	if (parts.length !== 5) {
		throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}`);
	}
	const parsed = FIELDS.map((f, i) => ({ ...f, ...field(parts[i], f.label, f.range) }));
	const spec = Object.fromEntries(parsed.map((p) => [p.key, p.values])) as unknown as CronSpec;
	// Cron spells Sunday both 0 and 7, so a spec written either way has to match
	// the 0 that Date.getDay() reports.
	if (spec.dow.delete(7)) spec.dow.add(0);
	spec.domRestricted = parsed[2].restricted;
	spec.dowRestricted = parsed[4].restricted;
	return spec;
}

// Whether an expression parses, for a form that validates as you type.
export function cronProblem(expression: string): string | null {
	try {
		parseCron(expression);
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : 'invalid schedule';
	}
}

// Cron's one real oddity: with *both* day fields narrowed, a day matching
// *either* counts, so `0 9 1 * mon` is the 1st and every Monday. With one of
// them `*`, only the other decides. Keeping the rule means an expression
// copied from a crontab behaves the way its author expected.
function dayMatches(spec: CronSpec, d: Date): boolean {
	if (!spec.month.has(d.getMonth() + 1)) return false;
	const dom = spec.dom.has(d.getDate());
	const dow = spec.dow.has(d.getDay());
	if (spec.domRestricted && spec.dowRestricted) return dom || dow;
	if (spec.domRestricted) return dom;
	if (spec.dowRestricted) return dow;
	return true;
}

// The walk steps the Date's *local* fields, so "02:30" means the reading on the
// wall clock and not an instant. That matters once a year: when clocks go back,
// 02:30 comes round twice, and a walk that stepped the timestamp would match
// both and fire a daily job twice that day. Stepping the fields passes 02:59
// straight to 03:00 and the hour happens once.
//
// The cost is the opposite case: when clocks go forward the fields jump 01:59 to
// 03:00, so a job scheduled inside the hour that never happened does not run
// that day. One missed run a year, for schedules set inside the transition hour,
// against a double run otherwise.
function bumpMinute(d: Date): void {
	d.setMinutes(d.getMinutes() + 1, 0, 0);
}

function bumpHour(d: Date): void {
	d.setMinutes(0, 0, 0);
	d.setHours(d.getHours() + 1);
}

function bumpDay(d: Date): void {
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() + 1);
}

// How far ahead to look before calling an expression unsatisfiable. `0 0 30 2 *`
// (30 February) never matches, and the walk has to stop rather than run forever.
// Days that do not match are skipped whole, so the hopeless case costs a few
// thousand steps rather than the minutes in five years.
const HORIZON_YEARS = 5;

// The next matching minute strictly after `from`, or null if the expression
// cannot happen (29 February is reachable; 30 February is not).
//
// Strictly after, so a schedule that has just run on its due minute does not
// come back due on that same minute.
export function nextAfter(spec: CronSpec, from: number): number | null {
	const cursor = new Date(from);
	const lastYear = cursor.getFullYear() + HORIZON_YEARS;
	bumpMinute(cursor);
	while (cursor.getFullYear() <= lastYear) {
		if (!dayMatches(spec, cursor)) {
			bumpDay(cursor);
		} else if (!spec.hour.has(cursor.getHours())) {
			bumpHour(cursor);
		} else if (!spec.minute.has(cursor.getMinutes())) {
			bumpMinute(cursor);
		} else {
			// A wall-clock reading in the hour clocks went back through maps to the
			// earlier of its two instants, which can be behind `from` even though
			// the fields have moved on. That run already happened; keep walking.
			const at = cursor.getTime();
			if (at > from) return at;
			bumpMinute(cursor);
		}
	}
	return null;
}

// The next `count` runs after `from`, for the form's preview. Stops early at
// the horizon rather than padding the list.
export function nextRuns(expression: string, from: number, count = 3): number[] {
	let spec: CronSpec;
	try {
		spec = parseCron(expression);
	} catch {
		return [];
	}
	const out: number[] = [];
	let at = from;
	for (let i = 0; i < count; i++) {
		const next = nextAfter(spec, at);
		if (next === null) break;
		out.push(next);
		at = next;
	}
	return out;
}

// A starting point for the form: common shapes, each with the label it is
// offered under. Deliberately short — anything else is typed as an expression,
// and the preview says what it will do.
export const CRON_PRESETS: { label: string; cron: string }[] = [
	{ label: 'Every 15 minutes', cron: '*/15 * * * *' },
	{ label: 'Hourly, on the hour', cron: '0 * * * *' },
	{ label: 'Every weekday at 9am', cron: '0 9 * * mon-fri' },
	{ label: 'Every weekday at 6pm', cron: '0 18 * * mon-fri' },
	{ label: 'Daily at 8am', cron: '0 8 * * *' },
	{ label: 'Daily at midnight', cron: '0 0 * * *' },
	{ label: 'Mondays at 9am', cron: '0 9 * * mon' },
	{ label: 'First of the month at 9am', cron: '0 9 1 * *' }
];
