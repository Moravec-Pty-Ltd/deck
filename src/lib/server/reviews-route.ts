import { json } from '@sveltejs/kit';
import { cachedReviews } from './morabot';

// The morabot review snapshot from the monitor's last poll (issue #188), shared
// by GET /api/reviews and GET /api/agent/reviews. No fresh file read here.
export function reviewsRoute(): Response {
	return json(cachedReviews());
}
