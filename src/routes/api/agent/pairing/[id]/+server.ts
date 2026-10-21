import type { RequestHandler } from './$types';
import { decidePairingRoute } from '$lib/server/settings';

export const POST: RequestHandler = decidePairingRoute;
