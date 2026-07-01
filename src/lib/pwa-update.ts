// PWA update detection. An installed PWA (notably on iOS) keeps running an
// already-loaded build after a new version ships, because the browser only checks
// for a new service worker on its own lazy cadence. This proactively checks on
// resume/focus and reports when a newer worker is ready, so the layout can offer a
// non-blocking "reload" prompt. Assets are content-hashed, so the reload is what
// actually swaps the app; see src/service-worker.js.

// Wait this long between conditional GETs of the worker script when the app keeps
// regaining focus. `reg.update()` is cheap but focus can flap.
const CHECK_THROTTLE_MS = 60_000;

// Whether a freshly-installed worker means an update is ready to prompt. It's an
// update, not the first install, only when a worker was already controlling the
// page when the new one finished installing.
export function isUpdateReady(state: ServiceWorkerState, hasController: boolean): boolean {
	return state === 'installed' && hasController;
}

// Watch the service-worker registration and call `onReady` once a shipped update is
// installed and ready. Proactively checks on focus/visibility so a resumed iOS PWA
// actually looks for a new worker instead of waiting. Returns a teardown.
export function watchForUpdate(onReady: () => void): () => void {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

	const sw = navigator.serviceWorker;
	// Captured before any activation this session, so `clients.claim()` on the very
	// first install doesn't read as an update.
	const hadController = !!sw.controller;

	let registration: ServiceWorkerRegistration | null = null;
	let lastCheck = 0;
	let disposed = false;
	const tracked = new WeakSet<ServiceWorker>();

	// Report readiness at most once per watcher: the statechange and controllerchange
	// paths can both fire for one update, and a dismissed prompt shouldn't pop back.
	let readyNotified = false;
	const notifyReady = () => {
		if (readyNotified || disposed) return;
		readyNotified = true;
		onReady();
	};

	// Follow one installing worker to readiness. Guarded so a worker is tracked once,
	// and the listener removes itself once it has reported (or gone redundant).
	const track = (worker: ServiceWorker | null) => {
		if (!worker || tracked.has(worker)) return;
		tracked.add(worker);
		const onStateChange = () => {
			if (isUpdateReady(worker.state, !!sw.controller)) {
				worker.removeEventListener('statechange', onStateChange);
				notifyReady();
			} else if (worker.state === 'redundant') {
				worker.removeEventListener('statechange', onStateChange);
			}
		};
		worker.addEventListener('statechange', onStateChange);
	};

	// Reopening/refocusing the PWA should actually ask the server for a new worker.
	const check = () => {
		if (document.visibilityState !== 'visible' || !registration) return;
		const now = Date.now();
		if (now - lastCheck < CHECK_THROTTLE_MS) return;
		lastCheck = now;
		registration.update().catch(() => {});
	};

	const onUpdateFound = () => track(registration?.installing ?? null);

	sw.ready.then((reg) => {
		if (disposed) return; // torn down before the registration resolved
		registration = reg;
		reg.addEventListener('updatefound', onUpdateFound);
		track(reg.installing);
		// A resume's focus/visibility event can land before `sw.ready` resolves, so
		// run one check now that the registration exists; the first one isn't lost.
		check();
	});

	// A new worker taking control is also an update, but only if one was already in
	// charge (guards the first install, where skipWaiting()/claim() still fire this).
	const onControllerChange = () => {
		if (hadController) notifyReady();
	};
	sw.addEventListener('controllerchange', onControllerChange);

	document.addEventListener('visibilitychange', check);
	window.addEventListener('focus', check);

	return () => {
		disposed = true;
		registration?.removeEventListener('updatefound', onUpdateFound);
		sw.removeEventListener('controllerchange', onControllerChange);
		document.removeEventListener('visibilitychange', check);
		window.removeEventListener('focus', check);
	};
}
