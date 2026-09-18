/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const CACHE = `deck-${version}`;
// Content-hashed build assets + everything in static/. Safe to cache aggressively.
const ASSETS = [...build, ...files];

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;

	const url = new URL(request.url);

	// Never intercept the API, SSE streams, or cross-origin requests.
	if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

	// Immutable, content-hashed assets: serve from cache first.
	if (ASSETS.includes(url.pathname)) {
		event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
		return;
	}

	// Page navigations: network-first, fall back to the cached offline shell.
	// Serving something when offline is part of Chrome's installability criteria.
	if (request.mode === 'navigate') {
		event.respondWith(fetch(request).catch(() => caches.match('/offline.html')));
		return;
	}

	// Anything else: network-first, fall back to cache if present.
	event.respondWith(fetch(request).catch(() => caches.match(request)));
});

function pushData(event) {
	try {
		return event.data ? event.data.json() : {};
	} catch {
		return { title: 'deck', body: event.data ? event.data.text() : '' };
	}
}

// A single-choice question offers its options as notification actions, so it
// can be answered without opening deck (where the platform shows them).
function askActions(ask) {
	const maxActions = (self.Notification && self.Notification.maxActions) || 0;
	return ask.options.slice(0, maxActions).map((label, i) => ({ action: `option:${i}`, title: label }));
}

const str = (value, fallback) => (typeof value === 'string' ? value : fallback);

// Option actions only fit an ask with one question; a multi-question ask is
// opened in deck like any other notification.
function singleQuestionAsk(data) {
	const ask = data.ask;
	return ask && ask.questions === 1 ? ask : undefined;
}

function notificationOptions(data) {
	const ask = singleQuestionAsk(data);
	return {
		body: str(data.body, ''),
		tag: data.tag,
		data: { url: str(data.url, '/'), ask },
		icon: '/icon-192.png',
		badge: '/icon-192.png',
		renotify: Boolean(data.tag),
		actions: ask ? askActions(ask) : []
	};
}

// Web Push: show the notification deck sent (question asked, turn ended, crash).
self.addEventListener('push', (event) => {
	const data = pushData(event);
	event.waitUntil(self.registration.showNotification(data.title || 'deck', notificationOptions(data)));
});

// Post the picked option as the ask's answer: the same text and structured
// pick the ask card sends, so the transcript shows it answered.
function answerFromNotification(ask, label) {
	const header = ask.header || 'Answer';
	return fetch(`/api/sessions/${encodeURIComponent(ask.sessionId)}/answer`, {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			text: `Answering your question:\n- ${header}: ${label}`,
			toolUseId: ask.askId,
			answers: [{ header, labels: [label] }]
		})
	}).catch(() => {});
}

// The index an option action names, or -1 for a plain click.
function optionIndex(event) {
	const match = /^option:(\d+)$/.exec(str(event.action, ''));
	return match ? Number(match[1]) : -1;
}

function askOf(event) {
	const data = event.notification.data;
	return data ? data.ask : undefined;
}

// The option label an action click picked, or null for a plain click.
function pickedOption(event) {
	const ask = askOf(event);
	if (!ask) return null;
	const label = ask.options[optionIndex(event)];
	return label ? { ask, label } : null;
}

// An option action answers in place; a plain click focuses an existing window
// for the session if one is open, else opens it.
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const picked = pickedOption(event);
	if (picked) {
		event.waitUntil(answerFromNotification(picked.ask, picked.label));
		return;
	}
	const target = event.notification.data?.url || '/';
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			for (const client of clients) {
				if (client.url.includes(target) && 'focus' in client) return client.focus();
			}
			// Reusing a window only works same-origin: client.navigate rejects on a
			// cross-origin target (a retired review session links out to its PR).
			if (!target.startsWith('/')) return self.clients.openWindow(target);
			if (clients.length && 'navigate' in clients[0]) {
				return clients[0].focus().then((c) => c && c.navigate(target));
			}
			return self.clients.openWindow(target);
		})
	);
});
