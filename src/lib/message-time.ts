// When a transcript message was sent, for the small time under its bubble.
// Node-free. A message from today shows only the time, anything older the date
// as well, both on a 24-hour clock: "14:32", "05-11-2026 23:59".

// The moment a transcript event happened, in ms: deck stamps the prompts it
// sends (`ts`), and Claude stamps its messages with an ISO `timestamp` (absent
// from transcripts written before the CLI started recording it).
export function eventTime(event: Record<string, unknown>): number | null {
	if (typeof event.ts === 'number' && Number.isFinite(event.ts)) return event.ts;
	if (typeof event.timestamp === 'string') {
		const ms = Date.parse(event.timestamp);
		return Number.isNaN(ms) ? null : ms;
	}
	return null;
}

type Parts = { day: string; month: string; year: string; hour: string; minute: string };

function parts(ms: number, timeZone?: string): Parts {
	const fmt = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	});
	const out = { day: '', month: '', year: '', hour: '', minute: '' };
	for (const p of fmt.formatToParts(ms)) if (p.type in out) out[p.type as keyof Parts] = p.value;
	return out;
}

// `timeZone` is for tests; the browser's own zone applies otherwise.
export function formatMessageTime(ms: number, now: number, timeZone?: string): string {
	const t = parts(ms, timeZone);
	const today = parts(now, timeZone);
	const time = `${t.hour}:${t.minute}`;
	const sameDay = t.day === today.day && t.month === today.month && t.year === today.year;
	return sameDay ? time : `${t.day}-${t.month}-${t.year} ${time}`;
}
