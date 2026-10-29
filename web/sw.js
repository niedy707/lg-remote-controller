// Kumanda servis çalışanı — YALNIZ bildirim gösterir.
//
// Fetch dinleyicisi bilerek yok: kumanda her açılışta sunucudan yüklenir, eski sürüm önbellekte takılı kalmaz.
// Bildirimler: planlı yayın başladı / reklam bitti / zamanlayıcı hatası / YouTube engeli / kilitli TV
// (server/tvKumanda.cjs → sonucIzleyici) ve giriş kilidi (server/kumanda.cjs).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'LG Remote', {
    body: d.body || '',
    tag: d.tag || 'kumanda',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }));
});

// Tarayıcı aboneliği kendiliğinden yenilerse (süre dolumu, anahtar değişimi) yeni uç sunucuya bildirilir;
// yoksa sunucu eski uca göndermeye devam eder ve bildirimler sessizce kesilir.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const eski = e.oldSubscription;
    const yeni = e.newSubscription || (eski && eski.options && await self.registration.pushManager.subscribe(eski.options));
    if (!yeni) return;
    await fetch('/api/bildirim/abone', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: yeni.toJSON() }),
    });
  })().catch(() => { /* bir sonraki açılışta kumanda aboneliği yeniden doğrular */ }));
});

// Dokununca kumanda açılır.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const pencereler = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of pencereler) if ('focus' in c) return c.focus();
    return self.clients.openWindow('/');
  })());
});
