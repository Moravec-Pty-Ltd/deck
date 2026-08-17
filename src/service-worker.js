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

// Web Push: show the notification deck sent (question asked, turn ended, crash).
self.addEventListener('push', (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { title: 'deck', body: event.data ? event.data.text() : '' };
	}
	event.waitUntil(
		self.registration.showNotification(data.title || 'deck', {
			body: data.body || '',
			tag: data.tag,
			data: { url: data.url || '/' },
			icon: '/icon-192.png',
			badge: '/icon-192.png',
			renotify: !!data.tag
		})
	);
});

// Focus an existing window for the session if one is open, else open it.
self.addEventListener('notificationclick', (event) => {
	event.notification.close();
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
