'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const tvKumanda = require('./tvKumanda.cjs');
const KANALLAR = require('../config.example.json').kanallar;
const FAV = KANALLAR.favoriler;
const DIGER = KANALLAR.diger;

/** Router'ı gerçek bir HTTP sunucusuna bağlar; ajan çağrıları `fetchFn` ile taklit edilir. */
async function kur(secenek) {
  const app = express();
  app.use(express.json());
  app.use('/api/tv', tvKumanda.olustur({ log: () => {}, kanallar: KANALLAR, ...secenek }));
  const sunucu = http.createServer(app);
  await new Promise((ok) => sunucu.listen(0, '127.0.0.1', ok));
  const taban = `http://127.0.0.1:${sunucu.address().port}/api/tv`;
  return {
    async istek(yol, govde, yontem = null) {
      const r = await fetch(taban + yol, govde
        ? { method: yontem || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde) }
        : { method: yontem || 'GET' });
      const tip = r.headers.get('content-type') || '';
      return { kod: r.status, tip, govde: tip.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
    },
    taban,
    kapat: () => new Promise((ok) => { sunucu.closeAllConnections?.(); sunucu.close(ok); }),
  };
}

function sahteAjan(yanitla) {
  const cagrilar = [];
  const fetchFn = async (url, opt) => {
    cagrilar.push({ url, opt, govde: opt.body ? JSON.parse(opt.body) : null });
    return yanitla(url, opt);
  };
  return { fetchFn, cagrilar };
}
const jsonYanit = (kod, j) => new Response(JSON.stringify(j), { status: kod, headers: { 'Content-Type': 'application/json' } });
const AYAR = { url: 'http://ajan.test:3027', token: 'x'.repeat(40) };
const AJAN = AYAR.url;

test('ajan tanımlı değilse 503 — sessizce çalışıyor gibi görünmez', async () => {
  const s = await kur({ url: '', token: '', fetchFn: async () => { throw new Error('çağrılmamalı'); } });
  const r = await s.istek('/tvler');
  assert.strictEqual(r.kod, 503);
  await s.kapat();
});

test('geçersiz TV kimliği ve izinsiz tuş ajana HİÇ gitmez', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  assert.strictEqual((await s.istek('/tus', { tv: '../tv1', tus: 'UP' })).kod, 400);
  assert.strictEqual((await s.istek('/tus', { tv: 'tv1', tus: 'POWER' })).kod, 400);
  assert.strictEqual((await s.istek('/kanal', { tv: 'tv1' })).kod, 400);
  assert.strictEqual((await s.istek('/kanal', { tv: 'tv1', no: '12a' })).kod, 400);
  assert.strictEqual(a.cagrilar.length, 0);
  await s.kapat();
});

test('tuş belirteçle, "panel" istemci başlığıyla ve doğru gövdeyle iletilir', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/tus', { tv: 'tv2', tus: 'volumeup' });
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(a.cagrilar[0].url, `${AJAN}/tus`);
  assert.strictEqual(a.cagrilar[0].opt.headers.Authorization, `Bearer ${AYAR.token}`);
  assert.strictEqual(a.cagrilar[0].opt.headers['X-Istemci'], 'panel', 'ajan işlem kaydına "panel" yazar');
  assert.deepStrictEqual(a.cagrilar[0].govde, { tv: 'tv2', tus: 'VOLUMEUP' });
  await s.kapat();
});

test('ajanın hatası panel biçimine çevrilir ({hata} → {error})', async () => {
  const a = sahteAjan(() => jsonYanit(404, { hata: 'TV 1: "Yok TV" kanalı bulunamadı' }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/kanal', { tv: 'tv1', ad: 'Yok TV' });
  assert.strictEqual(r.kod, 404);
  assert.match(r.govde.error, /bulunamadı/);
  await s.kapat();
});

test('ajan belirteci reddederse (401/403) 502 — arayüzün oturum 401\'iyle karışmaz', async () => {
  const gunluk = [];
  const a = sahteAjan(() => jsonYanit(401, { hata: 'yetkisiz' }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn, log: (m) => gunluk.push(m) });
  for (const [yol, govde] of [['/tvler'], ['/ekran?tv=tv1'], ['/akis?tv=tv1'], ['/favoriler?tv=tv1'], ['/tus', { tv: 'tv1', tus: 'UP' }], ['/ekran-akis?tv=tv1']]) {
    const r = await s.istek(yol, govde);
    assert.strictEqual(r.kod, 502, yol);
    assert.match(r.govde.error, /belirteci reddetti/, yol);
  }
  assert.ok(gunluk.some((m) => /TV_AJAN_TOKEN/.test(m)), 'günlüğe ipucu');
  const b = sahteAjan(() => jsonYanit(403, {}));
  const s2 = await kur({ ...AYAR, fetchFn: b.fetchFn });
  assert.strictEqual((await s2.istek('/engel')).kod, 502);
  await s.kapat();
  await s2.kapat();
});

test('favoriler kullanıcının kanallarını ajana sorar', async () => {
  const a = sahteAjan(() => jsonYanit(200, { kanallar: FAV.map((ad, i) => ({ ad, no: i + 1 })) }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/favoriler?tv=tv2');
  assert.strictEqual(r.kod, 200);
  assert.deepStrictEqual(a.cagrilar[0].govde.adlar.slice(0, FAV.length), FAV);
  assert.strictEqual(r.govde.kanallar.length, FAV.length);
  assert.strictEqual(r.govde.kanallar[0].logo, `/logolar/${KANALLAR.logolar[FAV[0]]}.png`);
  assert.deepStrictEqual(r.govde.diger, [], 'yanıtta olmayan ızgara kanalı gösterilmez');
  await s.kapat();
});

test('ızgara kanalları favorilerle aynı çözümlemede istenir; bu TV\'de olmayan elenir', async () => {
  const yok = DIGER[2];
  const a = sahteAjan((url, opt) => jsonYanit(200, { kanallar: JSON.parse(opt.body).adlar.map((ad, i) => ({ ad, no: ad === yok ? null : i + 1 })) }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/favoriler?tv=tv1');
  assert.strictEqual(a.cagrilar.length, 1, 'TV\'ye tek istek');
  assert.deepStrictEqual(r.govde.kanallar.map((k) => k.ad), FAV);
  assert.deepStrictEqual(r.govde.diger.map((k) => k.ad), DIGER.filter((ad) => ad !== yok));
  assert.ok(r.govde.diger.every((k) => /^\/logolar\/[a-z0-9]+\.png$/.test(k.logo)), 'her ızgara kanalının logosu var');
  await s.kapat();
});

test('TV kapalıyken favori düğmeleri yine adla gelir (numarasız + uyarı)', async () => {
  const a = sahteAjan(() => jsonYanit(502, { hata: 'Bağlantı kapandı' }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/favoriler?tv=tv1');
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(r.govde.kanallar.length, FAV.length);
  assert.ok(r.govde.kanallar.every((k) => k.no === null && k.logo));
  assert.strictEqual(r.govde.diger.length, DIGER.length, 'TV kapalıyken ızgara da adla gelir');
  assert.strictEqual(r.govde.uyari, 'Bağlantı kapandı');
  await s.kapat();
});

test('"şu an ne var" favori kanallar için istenir', async () => {
  const a = sahteAjan(() => jsonYanit(200, { kanallar: [{ ad: FAV[1], no: 4, simdi: { ad: 'Akşam Haberleri', bas: '19:00', bit: '20:00' }, sonraki: null }] }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/epg?tv=tv2');
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(a.cagrilar[0].url, `${AJAN}/epg`);
  assert.deepStrictEqual(a.cagrilar[0].govde, { tv: 'tv2', adlar: FAV });
  assert.strictEqual(r.govde.kanallar[0].simdi.ad, 'Akşam Haberleri');
  assert.strictEqual((await s.istek('/epg?tv=TV1!')).kod, 400);
  await s.kapat();
});

test('ekran görüntüsü JPEG olarak, önbelleksiz geçer', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const a = sahteAjan(() => new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/ekran?tv=tv2');
  assert.strictEqual(r.kod, 200);
  assert.match(r.tip, /image\/jpeg/);
  assert.deepStrictEqual(r.govde, jpeg);
  await s.kapat();
});

test('ajan yanıt vermezse 504 ve anlaşılır mesaj', async () => {
  const a = sahteAjan(() => { const e = new Error('zaman'); e.name = 'TimeoutError'; throw e; });
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/tvler');
  assert.strictEqual(r.kod, 504);
  assert.strictEqual(r.govde.error, 'TV ajanı yanıt vermedi');
  await s.kapat();
});

test('aç: geçersiz TV ajana gitmez, geçerli olan iletilir; ajanın 504 ipucu kullanıcıya ulaşır', async () => {
  const a = sahteAjan(() => jsonYanit(504, { hata: 'TV 1 açılmadı (8 uyandırma paketi gönderildi). TV ayarlarında "Mobil TV Açık / Wi-Fi ile aç" açık olmalı.' }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  assert.strictEqual((await s.istek('/ac', { tv: 'TV1!' })).kod, 400);
  assert.strictEqual(a.cagrilar.length, 0);
  const r = await s.istek('/ac', { tv: 'tv1' });
  assert.strictEqual(r.kod, 504);
  assert.match(r.govde.error, /Wi-Fi ile aç/);
  assert.strictEqual(a.cagrilar[0].url, `${AJAN}/ac`);
  assert.deepStrictEqual(a.cagrilar[0].govde, { tv: 'tv1' });
  await s.kapat();
});

test('kanal: ajanın "TV açılarak" yanıtı arayüze olduğu gibi gider', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true, kanal: { no: 3, ad: 'KANAL D HD', acildi: true } }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/kanal', { tv: 'tv1', ad: 'Kanal D' });
  assert.strictEqual(r.kod, 200);
  assert.deepStrictEqual(r.govde.kanal, { no: 3, ad: 'KANAL D HD', acildi: true });
  assert.deepStrictEqual(a.cagrilar[0].govde, { tv: 'tv1', ad: 'Kanal D' });
  await s.kapat();
});

test('kaynak menüsü yalnız bilinen hedeflere, ajana doğru gövdeyle', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true, kaynak: 'apple' }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  assert.strictEqual((await s.istek('/giris', { tv: 'tv1', hedef: 'com.webos.app.browser' })).kod, 400);
  assert.strictEqual((await s.istek('/giris', { tv: 'tv1', hedef: 'youtube' })).kod, 400);
  assert.strictEqual((await s.istek('/giris', { tv: 'tv1' })).kod, 400);
  assert.strictEqual(a.cagrilar.length, 0);
  const r = await s.istek('/giris', { tv: 'tv1', hedef: 'apple' });
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(a.cagrilar[0].url, `${AJAN}/giris`);
  assert.deepStrictEqual(a.cagrilar[0].govde, { tv: 'tv1', hedef: 'apple' });
  for (const hedef of ['netflix', 'prime', 'disney', 'canli']) assert.strictEqual((await s.istek('/giris', { tv: 'tv1', hedef })).kod, 200);
  await s.kapat();
});

test('zamanlayıcı: geçersiz girdiler ajana gitmez; geçerli gövde süzülerek iletilir', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true, gorevler: [], gecmis: [] }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const kanal = DIGER[0];
  const kotu = [
    { islem: 'rm -rf' },
    { islem: 'geri-don', tv: 'tv1', dk: 0 },
    { islem: 'geri-don', tv: '../x', dk: 5 },
    { islem: 'ekle', tv: 'tv1', kanal: 'Bilinmeyen TV', tvKapaliysa: 'ac', zaman: { tur: 'tek', tarih: '2030-01-01', saat: '20:00' } },
    { islem: 'ekle', tv: 'tv1', kanal, tvKapaliysa: 'ac', zaman: { tur: 'haftalik', saat: '20:00', gunler: [8] } },
    { islem: 'ekle', tv: 'tv1', kanal, tvKapaliysa: 'belki', zaman: { tur: 'tek', tarih: '2030-01-01', saat: '20:00' } },
    { islem: 'sil', id: '../../etc' },
    { islem: 'etkin', id: 'abc123', acik: 'evet' },
  ];
  for (const g of kotu) assert.strictEqual((await s.istek('/zamanlayici', g)).kod, 400, JSON.stringify(g));
  assert.strictEqual(a.cagrilar.length, 0);
  await s.istek('/zamanlayici', { islem: 'ekle', tv: 'tv1', kanal, tvKapaliysa: 'ac', zaman: { tur: 'haftalik', saat: '21:00', gunler: [1, 2, 3, 4, 5], fazla: 'x' }, ekAlan: 1 });
  assert.deepStrictEqual(a.cagrilar[0].govde, { islem: 'ekle', tv: 'tv1', kanal, tvKapaliysa: 'ac', zaman: { tur: 'haftalik', saat: '21:00', gunler: [1, 2, 3, 4, 5] } });
  await s.istek('/zamanlayici', { islem: 'geri-don', tv: 'tv1', dk: 8 });
  assert.deepStrictEqual(a.cagrilar[1].govde, { islem: 'geri-don', tv: 'tv1', dk: 8 });
  await s.kapat();
});

test('ekran kapat/aç ve TV mesajı: doğrulama + iletme', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  assert.strictEqual((await s.istek('/ekran-guc', { tv: 'tv1', kapali: 'evet' })).kod, 400);
  assert.strictEqual((await s.istek('/bildirim', { tv: 'tv1', mesaj: '', sureSn: 5 })).kod, 400);
  assert.strictEqual((await s.istek('/bildirim', { tv: 'tv1', mesaj: 'a', sureSn: 3 })).kod, 400);
  assert.strictEqual(a.cagrilar.length, 0);
  assert.strictEqual((await s.istek('/ekran-guc', { tv: 'tv1', kapali: true })).kod, 200);
  assert.strictEqual((await s.istek('/bildirim', { tv: 'tv1', mesaj: ' Yemek hazır ', sureSn: 15 })).kod, 200);
  assert.deepStrictEqual(a.cagrilar.map((c) => [c.url.replace(AJAN, ''), c.govde]), [
    ['/ekran-guc', { tv: 'tv1', kapali: true }],
    ['/bildirim', { tv: 'tv1', mesaj: 'Yemek hazır', sureSn: 15 }],
  ]);
  await s.kapat();
});

test('canlı önizleme akışı ajandan olduğu gibi aktarılır', async () => {
  const govde = Buffer.from('--kare\r\nContent-Type: image/jpeg\r\nContent-Length: 2\r\n\r\nAB\r\n');
  const a = sahteAjan(() => new Response(govde, { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=kare' } }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/ekran-akis?tv=tv1&sn=999&fps=0.34');
  assert.strictEqual(r.kod, 200);
  assert.match(r.tip, /multipart\/x-mixed-replace/);
  assert.match(a.cagrilar[0].url, /\/ekran-akis\?tv=tv1&sn=180&fps=0\.34$/, 'süre 180 sn ile sınırlanır, kare sıklığı iletilir');
  await s.istek('/ekran-akis?tv=tv1&fps=50');
  assert.match(a.cagrilar[1].url, /&fps=2$/, 'kare sıklığı en çok 2/sn');
  assert.strictEqual((await s.istek('/ekran-akis?tv=../x')).kod, 400);
  await s.kapat();
});

test('canlı önizleme: eşzamanlı akış sınırlı (6); kapanan akış yer açar', async (t) => {
  const fetchFn = async (url, opt) => {
    const akis = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('--kare\r\n')); } });
    opt.signal.addEventListener('abort', () => { akis.cancel().catch(() => {}); });
    return new Response(akis, { status: 200, headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=kare' } });
  };
  const s = await kur({ ...AYAR, fetchFn });
  const acik = [];
  // Doğrulama düşse de açık akışlar kapansın (yoksa sunucu kapanmayı bekler, test takılır).
  t.after(() => { for (const x of acik) x.abort(); return s.kapat(); });
  const ac = async () => {
    const k = new AbortController();
    const r = await fetch(`${s.taban}/ekran-akis?tv=tv1`, { signal: k.signal });
    // Yanıt nesnesi de tutulur: undici çöpe giden yanıtın gövdesini kapatır (akış erken biterdi).
    if (r.status === 200) acik.push({ k, r, abort: () => k.abort() });
    else await r.arrayBuffer();
    return r.status;
  };
  for (let i = 0; i < 6; i++) assert.strictEqual(await ac(), 200, `akış ${i + 1}`);
  assert.strictEqual(await ac(), 429, '7. akış reddedilir');
  acik.shift().abort();
  await new Promise((ok) => setTimeout(ok, 150));
  assert.strictEqual(await ac(), 200, 'kapanan akış yer açtı');
});

test('sonuç izleyici: yalnız YENİ kayıt bildirilir; hata → "tv", reklam bitti / yayın başladı → "tv-olay"', async () => {
  let gecmis = [{ id: 'a1', bitti: 1, tur: 'geri-don', tv: 'tv1', kanal: { ad: 'KANAL D HD' }, sonuc: 'hata', neden: 'eski' }];
  const bildirimler = [];
  const iz = tvKumanda.sonucIzleyici({
    ...AYAR, araMs: 1e9,
    fetchFn: async (url) => jsonYanit(200, url.endsWith('/zamanlayici') ? { gorevler: [], gecmis } : {}),
    bildir: async (b, m, konu) => { bildirimler.push(`${konu}|${b}|${m}`); },
  });
  await iz.yokla();
  assert.strictEqual(bildirimler.length, 0, 'ilk okuma bildirmez');
  gecmis = [
    { id: 'b4', bitti: 5, tur: 'haftalik', tv: 'tv2', kanal: { ad: 'TRT 1' }, etiket: 'Akşam Dizisi', sonuc: 'atlandi', neden: 'TV kapalıydı' },
    { id: 'b3', bitti: 4, tur: 'tek', tv: 'tv1', kanal: { ad: 'TV8' }, etiket: 'Yemek Yarışması', sonuc: 'ok' },
    { id: 'b2', bitti: 3, tur: 'tek', tv: 'tv2', kanal: { ad: 'TV8' }, sonuc: 'kacirildi', neden: '12 dk geç' },
    { id: 'b1', bitti: 2, tur: 'geri-don', tv: 'tv1', kanal: { ad: 'Show TV' }, sonuc: 'ok' },
    ...gecmis,
  ];
  await iz.yokla();
  await iz.yokla();
  assert.deepStrictEqual(bildirimler, [
    'tv-olay|📺 Reklam bitti|Tv1: Show TV açıldı',
    'tv|📺 Program: kaçırıldı|Tv2 · TV8 — 12 dk geç',
    'tv-olay|📺 Başladı: Yemek Yarışması|Tv1: TV8 açıldı',
    'tv-olay|📺 Başladı: Akşam Dizisi|Tv2 kapalıydı — kanal açılmadı',
  ]);
  iz.durdur();
});

test('sonuç izleyici: vakti yakın görev varken sık yoklar', async () => {
  const simdi = 1_000_000;
  let gorevler = [{ id: 'g1', etkin: true, an: simdi + 10 * 60000 }];
  const iz = tvKumanda.sonucIzleyici({
    ...AYAR, araMs: 1e9, simdi: () => simdi,
    fetchFn: async () => jsonYanit(200, { gorevler, gecmis: [] }),
    bildir: async () => {},
  });
  assert.strictEqual(await iz.yokla(), false, '10 dk sonraki görev: olağan aralık');
  gorevler = [{ id: 'g1', etkin: true, an: simdi + 30000 }];
  assert.strictEqual(await iz.yokla(), true, '30 sn sonra: sık yoklama');
  gorevler = [{ id: 'g1', etkin: true, an: simdi - 60000 }];
  assert.strictEqual(await iz.yokla(), true, 'vakti 1 dk geçmiş, sonuç bekleniyor: sık yoklama');
  gorevler = [{ id: 'g1', etkin: false, an: simdi + 30000 }];
  assert.strictEqual(await iz.yokla(), false, 'durdurulmuş görev sayılmaz');
  iz.durdur();
});

test('sonuç izleyici: TV mesajı görevi başarıda telefona bildirim göndermez, hatada gönderir', async () => {
  let gecmis = [];
  const bildirimler = [];
  const iz = tvKumanda.sonucIzleyici({ ...AYAR, araMs: 1e9, fetchFn: async () => jsonYanit(200, { gorevler: [], gecmis }), bildir: async (b, m, konu) => { bildirimler.push(`${konu}|${b}|${m}`); } });
  await iz.yokla();
  gecmis = [
    { id: 'm2', bitti: 2, tur: 'haftalik', tv: 'tv1', kanal: null, mesaj: { metin: 'Yatma vakti' }, sonuc: 'hata', neden: 'bağlantı' },
    { id: 'm1', bitti: 1, tur: 'haftalik', tv: 'tv1', kanal: null, mesaj: { metin: 'Yatma vakti' }, sonuc: 'ok' },
  ];
  await iz.yokla();
  assert.deepStrictEqual(bildirimler, ['tv|📺 Program: yapılamadı|Tv1 · TV mesajı — bağlantı']);
  iz.durdur();
});

test('sonuç izleyici: YENİ engel olayı ve kilitli TV\'nin kapatılması bildirilir; kilitleme/açma bildirilmez; TV adı ajandan', async () => {
  let olaylar = [{ id: 'e1', zaman: 1, tv: 'tv2', baslik: 'Eski', kanal: 'K', kural: { tur: 'kelime', deger: 'spoiler' } }];
  let kilitOlaylari = [{ id: 'k1', zaman: 1, tv: 'tv1', ne: 'kapatildi' }];
  const bildirimler = [];
  const iz = tvKumanda.sonucIzleyici({
    ...AYAR, araMs: 1e9,
    fetchFn: async (url) => jsonYanit(200, url.endsWith('/engel') ? { olaylar }
      : url.endsWith('/kilit') ? { tvler: [{ id: 'tv1', ad: 'Living room' }, { id: 'tv2', ad: 'Bedroom' }], olaylar: kilitOlaylari }
        : { gorevler: [], gecmis: [] }),
    bildir: async (b, m, konu) => { bildirimler.push(`${konu}|${b}|${m}`); },
  });
  await iz.yokla();
  assert.deepStrictEqual(bildirimler, [], 'ilk yoklamada eskiler bildirilmez');
  olaylar = [{ id: 'e2', zaman: 2, tv: 'tv2', baslik: 'Spoiler dolu bir inceleme', kanal: 'Örnek Kanal', kural: { tur: 'kelime', deger: 'spoiler' } }, ...olaylar];
  kilitOlaylari = [
    { id: 'k4', zaman: 3, tv: 'tv1', ne: 'acildi', kaynak: 'panel' },
    { id: 'k3', zaman: 2, tv: 'tv1', ne: 'kilitlendi', kaynak: 'panel' },
    { id: 'k2', zaman: 2, tv: 'tv1', ne: 'kapatildi' },
    ...kilitOlaylari,
  ];
  await iz.yokla();
  assert.deepStrictEqual(bildirimler, [
    'tv-olay|🚫 YouTube engellendi|Bedroom: Spoiler dolu bir inceleme (Örnek Kanal) — kelime: spoiler',
    'tv-olay|🔒 Kilitli TV açıldı|Living room kilitliyken açıldı — mesaj gösterilip kapatıldı',
  ]);
  iz.durdur();
});

test('sonuç izleyici: bir kaynak ilk okumada düşerse, sonradan gelen eski kayıtları bildirmez; bildirim hatası döngüyü durdurmaz', async () => {
  let engelHazir = false;
  const gunluk = [];
  const bildirimler = [];
  let gecmis = [];
  const iz = tvKumanda.sonucIzleyici({
    ...AYAR, araMs: 1e9, log: (m) => gunluk.push(m),
    fetchFn: async (url) => {
      if (url.endsWith('/engel')) return engelHazir ? jsonYanit(200, { olaylar: [{ id: 'e1', tv: 'tv1', baslik: 'Eski' }] }) : jsonYanit(500, {});
      if (url.endsWith('/kilit')) return jsonYanit(200, { olaylar: [] });
      return jsonYanit(200, { gorevler: [], gecmis });
    },
    bildir: async (b) => { bildirimler.push(b); throw new Error('push servisi yok'); },
  });
  await iz.yokla();
  assert.ok(gunluk.some((m) => /\/engel → HTTP 500/.test(m)), 'ajan hatası günlüğe');
  engelHazir = true;
  await iz.yokla();
  assert.deepStrictEqual(bildirimler, [], 'engel kaynağının ilk başarılı okuması bildirmez');
  gecmis = [{ id: 'z1', bitti: 1, tur: 'geri-don', tv: 'tv1', kanal: { ad: 'NTV' }, sonuc: 'ok' }];
  await iz.yokla();
  assert.deepStrictEqual(bildirimler, ['📺 Reklam bitti']);
  assert.ok(gunluk.some((m) => /bildirim gönderilemedi: push servisi yok/.test(m)), 'bildirim hatası günlüğe, çökme yok');
  iz.durdur();
});

test('yayın akışı: favoriler + ızgara kanalları için istenir, logolar eklenir; program etiketi süzülerek iletilir', async () => {
  const a = sahteAjan((url) => (url.endsWith('/akis')
    ? jsonYanit(200, { simdi: 5, kanallar: [{ ad: 'TV8', programlar: [{ ad: 'Yemek Yarışması', bas: 10, bit: 20 }] }] })
    : jsonYanit(200, { ok: true, gorevler: [], gecmis: [] })));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/akis?tv=tv1');
  assert.strictEqual(r.kod, 200);
  assert.deepStrictEqual(a.cagrilar[0].govde, { adlar: [...FAV, ...DIGER], saat: 30 });
  assert.strictEqual(r.govde.kanallar[0].logo, `/logolar/${KANALLAR.logolar.TV8}.png`);
  assert.strictEqual((await s.istek('/akis?tv=../x')).kod, 400);
  const zaman = { tur: 'tek', tarih: '2030-01-01', saat: '21:00' };
  assert.strictEqual((await s.istek('/zamanlayici', { islem: 'ekle', tv: 'tv1', kanal: 'TV8', tvKapaliysa: 'ac', zaman, etiket: 'x'.repeat(81) })).kod, 400);
  await s.istek('/zamanlayici', { islem: 'ekle', tv: 'tv1', kanal: 'TV8', tvKapaliysa: 'ac', zaman, etiket: '  Yemek Yarışması  ' });
  assert.strictEqual(a.cagrilar.at(-1).govde.etiket, 'Yemek Yarışması');
  await s.kapat();
});

test('zamanlayıcı: "X dk sonra" süzülerek iletilir; sınır dışı süre ajana gitmez', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true, gorevler: [], gecmis: [] }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  for (const dk of [0, 721, 2.5, 'x']) {
    assert.strictEqual((await s.istek('/zamanlayici', { islem: 'ekle', tv: 'tv1', kanal: 'NTV', tvKapaliysa: 'ac', zaman: { tur: 'sonra', dk } })).kod, 400);
  }
  assert.strictEqual(a.cagrilar.length, 0);
  const r = await s.istek('/zamanlayici', { islem: 'ekle', tv: 'tv1', kanal: 'NTV', tvKapaliysa: 'ac', zaman: { tur: 'sonra', dk: 7, fazla: 1 } });
  assert.strictEqual(r.kod, 200);
  assert.deepStrictEqual(a.cagrilar[0].govde, { islem: 'ekle', tv: 'tv1', kanal: 'NTV', tvKapaliysa: 'ac', zaman: { tur: 'sonra', dk: 7 } });
  await s.kapat();
});

test('dokunmatik yüzey: hareket ve tıklama süzülerek iletilir; geçersizi ajana gitmez', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  for (const g of [{ dx: 1.5, dy: 0 }, { dx: 3000, dy: 0 }, { dx: 0, dy: 0 }, { dx: '5', dy: 1 }, { tikla: 'evet' }]) {
    assert.strictEqual((await s.istek('/isaretci', { tv: 'tv1', ...g })).kod, 400);
  }
  assert.strictEqual(a.cagrilar.length, 0);
  assert.strictEqual((await s.istek('/isaretci', { tv: 'tv1', dx: 14, dy: -3, fazla: 1 })).kod, 200);
  assert.strictEqual((await s.istek('/isaretci', { tv: 'tv1', tikla: true })).kod, 200);
  assert.deepStrictEqual(a.cagrilar.map((c) => c.govde), [{ tv: 'tv1', dx: 14, dy: -3 }, { tv: 'tv1', tikla: true }]);
  await s.kapat();
});

test('Apple TV: tuş cihaz bilgisiyle iletilir, başka cihaz değeri iletilmez; metin süzülür', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  assert.strictEqual((await s.istek('/tus', { tv: 'tv1', tus: 'enter', cihaz: 'apple' })).kod, 200);
  assert.strictEqual((await s.istek('/tus', { tv: 'tv1', tus: 'UP', cihaz: 'baska' })).kod, 200);
  assert.strictEqual((await s.istek('/metin', { tv: 'tv1', metin: 'x'.repeat(101) })).kod, 400);
  assert.strictEqual((await s.istek('/metin', { tv: 'tv1', metin: 42 })).kod, 400);
  assert.strictEqual((await s.istek('/metin', { tv: 'tv1', metin: 'belgesel', fazla: 1 })).kod, 200);
  assert.deepStrictEqual(a.cagrilar.map((c) => c.govde), [
    { tv: 'tv1', tus: 'ENTER', cihaz: 'apple' },
    { tv: 'tv1', tus: 'UP' },
    { tv: 'tv1', metin: 'belgesel' },
  ]);
  await s.kapat();
});

test('ses düzeyi: okunur ve 0-100 tam sayı süzülerek ayarlanır', async () => {
  const a = sahteAjan((url) => jsonYanit(200, url.includes('/ses?') ? { seviye: 23, sessiz: false } : { ok: true, seviye: 40 }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  const r = await s.istek('/ses?tv=tv1');
  assert.strictEqual(r.govde.seviye, 23);
  assert.strictEqual(a.cagrilar[0].url, `${AJAN}/ses?tv=tv1`);
  for (const seviye of [-1, 101, 2.5, '40', null]) assert.strictEqual((await s.istek('/ses', { tv: 'tv1', seviye })).kod, 400);
  assert.strictEqual((await s.istek('/ses', { tv: 'tv1', seviye: 40, fazla: 1 })).kod, 200);
  assert.deepStrictEqual(a.cagrilar.map((c) => c.govde), [null, { tv: 'tv1', seviye: 40 }]);
  assert.strictEqual((await s.istek('/ses?tv=../x')).kod, 400);
  await s.kapat();
});

test('izleme geçmişi: parametreler süzülerek ajana gider', async () => {
  const a = sahteAjan(() => jsonYanit(200, { bas: 0, bit: 1, kesitler: [] }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  assert.strictEqual((await s.istek('/izleme?tv=../x')).kod, 400);
  assert.strictEqual((await s.istek('/izleme?gun=dün')).kod, 400);
  assert.strictEqual((await s.istek('/izleme?gun=2026-10-18&gun=2026-10-19')).kod, 400, 'dizi parametre');
  assert.strictEqual((await s.istek('/izleme?tv=tv1&gun=2026-10-18&gunSayisi=99')).kod, 200);
  assert.strictEqual(a.cagrilar[0].url, `${AJAN}/izleme?gunSayisi=31&gun=2026-10-18&tv=tv1`);
  await s.istek('/izleme');
  assert.strictEqual(a.cagrilar[1].url, `${AJAN}/izleme?gunSayisi=1`);
  await s.kapat();
});

test('YouTube engelleri ve TV kilidi: girdiler süzülerek ajana gider', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  for (const g of [{ metin: '' }, { metin: 'x', tur: 'kötü' }, { metin: 'a'.repeat(301) }, { metin: 5 }]) assert.strictEqual((await s.istek('/engel', g)).kod, 400);
  assert.strictEqual(a.cagrilar.length, 0);
  assert.strictEqual((await s.istek('/engel', { metin: ' spoiler ', tur: 'kelime', fazla: 1 })).kod, 200);
  assert.deepStrictEqual([a.cagrilar[0].url, a.cagrilar[0].opt.method, a.cagrilar[0].govde], [`${AJAN}/engel`, 'POST', { metin: 'spoiler', tur: 'kelime' }]);
  assert.strictEqual(a.cagrilar[0].opt.headers['X-Istemci'], 'panel');
  assert.strictEqual((await s.istek('/engel/ZZZZZZZZ', null, 'DELETE')).kod, 400);
  assert.strictEqual((await s.istek('/engel/a1b2c3d4', null, 'DELETE')).kod, 200);
  assert.deepStrictEqual([a.cagrilar[1].url, a.cagrilar[1].opt.method], [`${AJAN}/engel?id=a1b2c3d4`, 'DELETE']);
  for (const g of [{ tv: '../x' }, { tv: 'tv1', dk: 0 }, { tv: 'tv1', dk: 1.5 }, { tv: 'tv1', dk: 50000 }, { tv: 'tv1', kapsam: 'apple' }]) {
    assert.strictEqual((await s.istek('/kilit', g)).kod, 400, JSON.stringify(g));
  }
  assert.strictEqual((await s.istek('/kilit', { tv: 'tv1' })).kod, 200);
  assert.deepStrictEqual(a.cagrilar[2].govde, { tv: 'tv1', dk: null }, 'süre verilmezse süresiz');
  assert.strictEqual((await s.istek('/kilit', { tv: 'tv1', dk: 30, kapsam: 'tv', fazla: 1 })).kod, 200);
  assert.deepStrictEqual(a.cagrilar[3].govde, { tv: 'tv1', dk: 30, kapsam: 'tv' });
  assert.strictEqual((await s.istek('/kilit/tv1', null, 'DELETE')).kod, 200);
  assert.deepStrictEqual([a.cagrilar[4].url, a.cagrilar[4].opt.method], [`${AJAN}/kilit?tv=tv1`, 'DELETE']);
  assert.strictEqual((await s.istek('/kilit/TV!', null, 'DELETE')).kod, 400);
  await s.kapat();
});

test('kilit mesajı: en çok 7 ham satır, satır başına 80 karakter; aradaki boş satır geçer', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  for (const mesaj of ['tek metin', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], ['x'.repeat(81)], [1, 2], null]) {
    assert.strictEqual((await s.istek('/kilit/ayar', { mesaj })).kod, 400, JSON.stringify(mesaj));
  }
  assert.strictEqual(a.cagrilar.length, 0);
  assert.strictEqual((await s.istek('/kilit/ayar', { mesaj: ['', '🔒 Uygun değil.', '', 'ℹ️ Sonra deneyiniz.', ''], fazla: 1 })).kod, 200, 'aradaki ve kenardaki boş satırlar geçer');
  assert.deepStrictEqual(a.cagrilar[0].govde, { mesaj: ['', '🔒 Uygun değil.', '', 'ℹ️ Sonra deneyiniz.', ''] });
  await s.kapat();
});

test('engel ayarı: açık/kapalı, 1. kademe mesajı ve 2. kademe uyarısı ayrı ayrı ya da birlikte; yalnız gelen alan iletilir', async () => {
  const a = sahteAjan(() => jsonYanit(200, { ok: true }));
  const s = await kur({ ...AYAR, fetchFn: a.fetchFn });
  for (const g of [{}, { acik: 'evet' }, { mesaj: 'düz' }, { uyari: ['x'.repeat(81)] }, { mesaj: Array(8).fill('a') }, { acik: true, uyari: [3] }, { fazla: 1 }]) {
    assert.strictEqual((await s.istek('/engel/ayar', g)).kod, 400, JSON.stringify(g));
  }
  assert.strictEqual(a.cagrilar.length, 0);
  await s.istek('/engel/ayar', { acik: false });
  await s.istek('/engel/ayar', { mesaj: ['🚫 Bu video engelli.', '', 'Başka bir şey izleyin.'] });
  await s.istek('/engel/ayar', { uyari: ['⚠️ YouTube kapatılıyor.'], fazla: 1 });
  await s.istek('/engel/ayar', { acik: true, mesaj: [], uyari: ['a'] });
  assert.deepStrictEqual(a.cagrilar.map((c) => [c.url.replace(AJAN, ''), c.govde]), [
    ['/engel/ayar', { acik: false }],
    ['/engel/ayar', { mesaj: ['🚫 Bu video engelli.', '', 'Başka bir şey izleyin.'] }],
    ['/engel/ayar', { uyari: ['⚠️ YouTube kapatılıyor.'] }],
    ['/engel/ayar', { acik: true, mesaj: [], uyari: ['a'] }],
  ]);
  await s.kapat();
});
