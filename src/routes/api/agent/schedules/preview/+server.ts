import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cronProblem, nextRuns } from '$lib/cron';

// What an expression would do, without saving anything. The web form reads
// $lib/cron directly, but the iOS form cannot, and a second cron
// implementation in Swift would be a second set of bugs. So the one engine
// answers for both.
//
// `next` is empty when `problem` is set, and also for an expression that parses
// but can never happen (30 February), which is why the two are separate fields.
export const GET: RequestHandler = async ({ url }) => {
	const cron = url.searchParams.get('cron') ?? '';
	const problem = cronProblem(cron);
	const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 3, 1), 10);
	return json({
		cron,
		problem,
		next: problem ? [] : nextRuns(cron, Date.now(), count)
	});
};
