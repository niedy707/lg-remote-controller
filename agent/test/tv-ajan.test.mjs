/**
 * TV ajanı testleri — TV'ye, ağa ve digiturk'e BAĞLANMADAN (sahte fetch, sahte TV, sahte saat).
 *
 *   node --test agent/test/tv-ajan.test.mjs
 *
 * Gerçek cihaz davranışı (Wake-on-LAN'ın TV'yi gerçekten açması, tvplus'ın evden çalışması)
 * burada sınanamaz; o doğrulama evde yapılır (TODO.md).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digiturkAyristir, tvplusAyristir, simdiSonraki, trGunu, Rehber } from '../net/rehber.mjs';
import { sihirliPaket, yayinAdresi } from '../net/wol.mjs';
import { uyandir, Tv, sunucuKur, gucKapaliMi } from '../tv-ajan.mjs';
import { Zamanlayici } from '../net/zamanlayici.mjs';
import { AppleTvKopru } from '../net/atv-kopru.mjs';
import { LgSsap } from '../net/lg-ssap.mjs';
import { IzlemeKaydi } from '../net/izleme.mjs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORNEK = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/digiturk-ornek.html'), 'utf8');
const TR = 3 * 3600 * 1000;
/** İstanbul saatiyle an. */
const tr = (y, m, d, s, dk = 0) => Date.UTC(y, m - 1, d, s, dk) - TR;
const GUN = trGunu(tr(2026, 10, 16, 12));

// ───────────────────────────────────────────── rehber: ayrıştırma

test('trGunu: UTC gece yarısından önce de İstanbul günü doğru', () => {
  assert.equal(trGunu(Date.UTC(2026, 9, 15, 22, 30)).anahtar, '2026-10-16');   // TR 01:30
  assert.equal(trGunu(Date.UTC(2026, 9, 15, 20, 59)).anahtar, '2026-10-15');   // TR 23:59
});

test('digiturkAyristir: kanallar, varlık çözümü, süre, programsız kanal atlanır', () => {
  const m = digiturkAyristir(ORNEK, GUN);
  assert.deepEqual([...m.keys()].sort(), ['CNNTURK', 'KANALD']);
  const d = m.get('KANALD');
  assert.equal(d.ad, 'KANAL D');
  assert.equal(d.programlar[0].ad, 'Sabah Kuşağı');
  assert.equal(d.programlar[1].ad, 'Akşam Dizisi & Final');
  assert.equal(d.programlar[0].bas, tr(2026, 10, 16, 6));
  assert.equal(d.programlar[0].bit, tr(2026, 10, 16, 8));
  assert.equal(m.get('CNNTURK').programlar[1].ad, "Tartışma 'Masa'");
});

test('digiturkAyristir: gece yarısını geçen program ertesi güne yazılır', () => {
  const p = digiturkAyristir(ORNEK, GUN).get('KANALD').programlar;
  assert.equal(p[2].bas, tr(2026, 10, 16, 23, 30));
  assert.equal(p[2].bit, tr(2026, 10, 17, 0, 30));
  assert.equal(p[3].ad, 'Tekrar Bölüm');
  assert.equal(p[3].bas, tr(2026, 10, 17, 0, 30));
});

test('simdiSonraki: süren program + sonraki, saatler İstanbul saati', () => {
  const p = digiturkAyristir(ORNEK, GUN).get('KANALD').programlar;
  const r = simdiSonraki(p, tr(2026, 10, 16, 21, 15));
  assert.equal(r.simdi.ad, 'Akşam Dizisi & Final');
  assert.equal(r.simdi.bas, '20:00');
  assert.equal(r.simdi.bit, '23:30');
  assert.equal(r.sonraki.ad, 'Gece Filmi');
  // Boşlukta (08:00-20:00 arası yayın yok): şu an yok, sonraki var.
  const b = simdiSonraki(p, tr(2026, 10, 16, 12));
  assert.equal(b.simdi, null);
  assert.equal(b.sonraki.ad, 'Akşam Dizisi & Final');
});

test('tvplusAyristir: saat dilimi, geçersiz kayıt atlanır, sıralı', () => {
  const r = tvplusAyristir({ playbilllist: [
    { name: 'İkinci', starttime: '2026-10-16 21:00:00 UTC+03:00', endtime: '2026-10-16 22:00:00 UTC+03:00' },
    { name: 'Birinci &amp; Ön', starttime: '2026-10-16 20:00:00 UTC+03:00', endtime: '2026-10-16 21:00:00 UTC+03:00' },
    { name: 'Bozuk', starttime: 'dün', endtime: '2026-10-16 22:00:00 UTC+03:00' },
    { name: '', starttime: '2026-10-16 20:00:00 UTC+03:00', endtime: '2026-10-16 21:00:00 UTC+03:00' },
  ] });
  assert.deepEqual(r.map((p) => p.ad), ['Birinci & Ön', 'İkinci']);
  assert.equal(r[0].bas, tr(2026, 10, 16, 20));
  assert.deepEqual(tvplusAyristir(null), []);
});

// ───────────────────────────────────────────── rehber: önbellek ve kaynak sırası

/** Gerçek işaretlemeyle n kanallı sayfa (sözleşme: < 10 kanal hata). */
function sayfa(n, ekle = '') {
  const kanal = (ad, prog) => `<div class="swiper-slide channelContent">
    <input type="hidden" id="channelID" name="channelID" value="${ad}" />
    <div class="tvGuideResult-box-wholeDates channelDetail">
      <span class="tvGuideResult-box-wholeDates-time-hour">20:00</span>
      <span class="tvGuideResult-box-wholeDates-time-totalMinute">- 120dk</span>
      <span class="tvGuideResult-box-wholeDates-title" title="${prog}">${prog}</span>
    </div></div>`;
  return Array.from({ length: n }, (_, i) => kanal(`DOLGU ${i}`, `Program ${i}`)).join('') + ekle;
}

function sahteFetch(govde, { durum = 200 } = {}) {
  const f = async (url) => {
    f.cagrilar.push(String(url));
    if (govde instanceof Error) throw govde;
    return { ok: durum === 200, status: durum, text: async () => govde };
  };
  f.cagrilar = [];
  return f;
}

test('Rehber: bellek → disk önbelleği; yeniden başlatmada ağa çıkmaz', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'rehber-'));
  try {
    const an = tr(2026, 10, 16, 21);
    const f = sahteFetch(sayfa(12, ORNEK));
    const r = new Rehber({ dizin, fetchFn: f, simdi: () => an });
    const k = await r.kanal('Kanal D');
    assert.equal(k.simdi.ad, 'Akşam Dizisi & Final');
    assert.equal(k.kaynak, 'digiturk');
    await r.kanal('CNN Türk TV');
    assert.equal(f.cagrilar.length, 1, 'aynı gün ikinci kez çekilmez');
    assert.match(f.cagrilar[0], /Day=10%2F16%2F2026\+00%3A00%3A00/);

    const f2 = sahteFetch(new Error('ağ yok'));
    const r2 = new Rehber({ dizin, fetchFn: f2, simdi: () => an + 3600e3 });
    assert.equal((await r2.kanal('KANAL D HD')).simdi.ad, 'Akşam Dizisi & Final');
    assert.equal(f2.cagrilar.length, 0, 'diskteki taze kayıt yeter');
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('Rehber: dün yalnız önbellekten okunur (digiturk geçmiş günü boş verir)', async () => {
  const f = sahteFetch(sayfa(12, ORNEK));
  const r = new Rehber({ fetchFn: f, simdi: () => tr(2026, 10, 17, 0, 15) });
  await r.kanal('Kanal D');
  // 00:15'te Kanal D'de digiturk'e göre yayın yok → tvplus yedeği de denenir; digiturk'e tek istek.
  const dt = f.cagrilar.filter((u) => u.includes('digiturk'));
  assert.equal(dt.length, 1);
  assert.match(dt[0], /Day=10%2F17%2F2026/, 'yalnız bugün istenir');
});

test('Rehber: gece yarısından sonra dünün süren programı bulunur', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'rehber-'));
  try {
    // Dün (16.10) çekilip diske yazılmış; bugün (17.10) sayfasında Kanal D yok.
    await new Rehber({ dizin, fetchFn: sahteFetch(sayfa(12, ORNEK)), simdi: () => tr(2026, 10, 16, 21) }).kanal('Kanal D');
    const r = new Rehber({ dizin, fetchFn: sahteFetch(sayfa(12)), simdi: () => tr(2026, 10, 17, 0, 10) });
    const k = await r.kanal('Kanal D');
    assert.equal(k.simdi.ad, 'Gece Filmi');
    assert.equal(k.sonraki.ad, 'Tekrar Bölüm');
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('Rehber: biçim değişmişse (< 10 kanal) sessizce boş dönmez, hata 15 dk tekrarlanmaz', async () => {
  let an = tr(2026, 10, 16, 21);
  const f = sahteFetch(ORNEK);   // yalnız 2 kanal
  const r = new Rehber({ fetchFn: f, simdi: () => an });
  await assert.rejects(r.gun(trGunu(an)), /yalnız 2 kanal/);
  await assert.rejects(r.gun(trGunu(an)), /yalnız 2 kanal/);
  assert.equal(f.cagrilar.length, 1, 'olumsuz önbellek');
  an += 16 * 60 * 1000;
  await assert.rejects(r.gun(trGunu(an)));
  assert.equal(f.cagrilar.length, 2, '15 dk sonra yeniden dener');
});

test('Rehber: ağ hatasında bayat veri kullanılır', async () => {
  let an = tr(2026, 10, 16, 8, 30);
  let govde = sayfa(12, ORNEK);
  let istek = 0;
  const fetchFn = async () => {
    istek++;
    if (govde instanceof Error) throw govde;
    return { ok: true, status: 200, text: async () => govde };
  };
  const r = new Rehber({ fetchFn, simdi: () => an });
  await r.kanal('Kanal D');
  govde = new Error('ağ yok');
  an += 7 * 3600e3;   // 15:30 — tazelik (6 sa) geçti, aynı gün
  const once = istek;
  const k = await r.kanal('Kanal D');
  assert.ok(istek > once, 'yeniden çekmeyi denedi');
  assert.equal(k.simdi, null);
  assert.equal(k.sonraki.ad, 'Akşam Dizisi & Final');
});

test('Rehber: digiturk\'te programı olmayan kanal için tvplus yedeği', async () => {
  const fetchFn = async (url, ops = {}) => {
    if (String(url).includes('digiturk')) return { ok: true, status: 200, text: async () => sayfa(12) };
    if (String(url).endsWith('/Authenticate')) return { ok: true, status: 200, headers: { getSetCookie: () => ['JSESSIONID=abc; Path=/'] }, json: async () => ({}) };
    assert.equal(ops.headers.Cookie, 'JSESSIONID=abc');
    assert.equal(JSON.parse(ops.body).channelid, '87');
    return { ok: true, status: 200, json: async () => ({ playbilllist: [
      { name: 'Gece Bülteni', starttime: '2026-10-16 20:00:00 UTC+03:00', endtime: '2026-10-16 22:00:00 UTC+03:00' },
    ] }) };
  };
  const r = new Rehber({ fetchFn, simdi: () => tr(2026, 10, 16, 21) });
  const k = await r.kanal('Habertürk TV');
  assert.equal(k.simdi.ad, 'Gece Bülteni');
  assert.equal(k.kaynak, 'tvplus');
});

test('Rehber: tvplus ulaşılamıyorsa 15 dk yeniden denenmez', async () => {
  let an = tr(2026, 10, 16, 21);
  let tvplus = 0;
  const fetchFn = async (url) => {
    if (String(url).includes('digiturk')) return { ok: true, status: 200, text: async () => sayfa(12) };
    tvplus++;
    throw new Error('bağlantı kurulamadı');
  };
  const r = new Rehber({ fetchFn, simdi: () => an });
  assert.equal(await r.kanal('Habertürk TV'), null);
  await r.kanal('Kanal D');
  assert.equal(tvplus, 1);
  an += 16 * 60 * 1000;
  await r.kanal('Habertürk TV');
  assert.equal(tvplus, 2);
});

// ───────────────────────────────────────────── Wake-on-LAN

test('sihirliPaket: 6×FF + 16×MAC, ayraç biçimi fark etmez', () => {
  const p = sihirliPaket('02:1A:2B:3C:4D:5E');
  assert.equal(p.length, 102);
  assert.ok(p.subarray(0, 6).every((b) => b === 0xff));
  for (let i = 0; i < 16; i++) assert.equal(p.subarray(6 + i * 6, 12 + i * 6).toString('hex'), '021a2b3c4d5e');
  assert.deepEqual(sihirliPaket('02-1a-2b-3c-4d-5e'), p);
  assert.throws(() => sihirliPaket('02:1a:2b'), /geçersiz MAC/);
});

test('yayinAdresi: TV\'nin alt ağındaki arayüzden; bulunamazsa /24', () => {
  const ara = {
    lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }],
    vpn0: [{ family: 'IPv4', internal: false, address: '192.0.2.9', netmask: '255.255.255.255' }],
    eth0: [{ family: 'IPv4', internal: false, address: '198.51.100.5', netmask: '255.255.252.0' }],
  };
  assert.equal(yayinAdresi('198.51.101.40', ara), '198.51.103.255');
  assert.equal(yayinAdresi('203.0.113.9', ara), '203.0.113.255');
  assert.equal(yayinAdresi('203.0.113.9', null), '203.0.113.255');
});

// ───────────────────────────────────────────── uyandırma döngüsü

function sahteSaat() {
  let t = 0;
  return { simdi: () => t, bekle: async (ms) => { t += ms; } };
}

test('uyandir: hazırsa paket göndermez', async () => {
  let wol = 0;
  const r = await uyandir({ hazirMi: async () => true, wol: async () => { wol++; }, ...sahteSaat() });
  assert.deepEqual(r, { uyandirildi: false, wolSayisi: 0 });
  assert.equal(wol, 0);
});

test('uyandir: paket gönderir, 5 sn\'de bir yineler, hazır olunca döner', async () => {
  const s = sahteSaat();
  let wol = 0;
  const r = await uyandir({ hazirMi: async () => s.simdi() >= 12000, wol: async () => { wol++; }, ...s });
  assert.equal(r.uyandirildi, true);
  assert.equal(wol, 2);            // 0. ve 6. sn (5 sn geçtikten sonraki ilk yoklamada); 12. sn'de hazır
  assert.equal(r.wolSayisi, 2);
});

test('uyandir: açılmazsa zaman aşımı, paket sayısıyla', async () => {
  const r = await uyandir({ hazirMi: async () => false, wol: async () => {}, sureMs: 20000, ...sahteSaat() });
  assert.equal(r.zamanAsimi, true);
  assert.ok(r.wolSayisi >= 3);
});

// ───────────────────────────────────────────── Tv: "her türlü o kanalı aç"

/**
 * SSAP'a hiç dokunmayan Tv: bağlantı/istek/kanal listesi sahte, ekrandaki kanal durumlu.
 * `geriAl`: uyanmadan sonraki ilk N kanal komutunu TV "kabul edip" uygulamaz (gerçek cihazda
 * görülen: açılışını bitirirken son kanala döndü). `hepGeriAl`: hiç uygulamaz.
 */
function sahteTv({ acik = false, acilirMi = true, mac = 'aa:bb:cc:dd:ee:ff', liste, geriAl = 0, hepGeriAl = false, onPlan = 'com.webos.app.livetv', teshisDizini = null, girisler = [{ id: 'HDMI_2', label: 'Apple OTT', appId: 'com.webos.app.hdmi2' }], uygulamalar = [{ id: 'netflix', title: 'Netflix' }, { id: 'amazon', title: 'Prime Video' }], appletv = null, atv = null } = {}) {
  const s = sahteSaat();
  const olaylar = [];
  const kanallar = liste || [
    { no: 3, ad: 'KANAL D HD', channelId: 'k3' },
    { no: 12, ad: 'CNN TÜRK HD', channelId: 'c12' },
  ];
  const durum = { kanal: { channelNumber: '7', channelName: 'TRT 1 HD', channelId: 't7' }, onPlan };
  const tv = new Tv({ id: 'oda', ad: 'Oda', ip: '192.0.2.10', mac, appletv }, 'anahtar', {
    atv,
    wol: async (m, ip) => { olaylar.push(`wol ${m} ${ip}`); if (acilirMi) acik = true; },
    uyanma: { simdi: s.simdi, bekle: s.bekle },
    teshisDizini,
  });
  tv.hazirMi = async () => acik;
  tv.kanallar = async () => kanallar;
  tv.ekran = async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  tv.iste = async (uri, payload) => {
    if (uri === 'ssap://tv/getCurrentChannel') return durum.kanal;
    if (uri.endsWith('/getForegroundAppInfo')) return { appId: durum.onPlan };
    if (uri === 'ssap://tv/getExternalInputList') return { devices: girisler };
    if (uri.endsWith('/getPowerState')) return { state: 'Active' };
    if (uri.endsWith('/listLaunchPoints')) return { launchPoints: uygulamalar };
    if (uri === 'ssap://system.launcher/launch') durum.onPlan = payload.id;
    olaylar.push(`${uri} ${JSON.stringify(payload)}`);
    if (uri === 'ssap://tv/openChannel' && !hepGeriAl && !(geriAl-- > 0)) {
      const k = kanallar.find((x) => x.channelId === payload.channelId);
      durum.kanal = { channelNumber: String(k.no), channelName: k.ad, channelId: k.channelId };
      durum.onPlan = 'com.webos.app.livetv';
    }
    return {};
  };
  return { tv, olaylar, durum };
}

const kanalKomutlari = (olaylar) => olaylar.filter((o) => o.startsWith('ssap://tv/openChannel'));

test('kanalAc: TV açıksa uyandırmadan doğrudan kanalı açar', async () => {
  const { tv, olaylar } = sahteTv({ acik: true });
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.deepEqual(k, { no: 3, ad: 'KANAL D HD', acildi: false });
  assert.deepEqual(olaylar, ['ssap://tv/openChannel {"channelId":"k3"}']);
});

test('kanalAc: TV kapalıysa önce açar, sonra kanalı açar', async () => {
  const { tv, olaylar } = sahteTv({ acik: false });
  const k = await tv.kanalAc({ ad: 'CNN Türk TV' });
  assert.equal(k.acildi, true);
  assert.equal(k.yineleme, 0);
  assert.equal(k.no, 12);
  assert.equal(olaylar[0], 'wol aa:bb:cc:dd:ee:ff 192.0.2.10');
  assert.equal(olaylar.at(-1), 'ssap://tv/openChannel {"channelId":"c12"}');
});

test('kanalAc: yeni açılan TV ilk istekleri reddederse yeniden dener', async () => {
  const { tv, olaylar } = sahteTv({ acik: false });
  let red = 2;
  const iste = tv.iste;
  tv.iste = async (uri, p) => { if (red-- > 0) throw new Error('canlı yayın hazır değil'); return iste(uri, p); };
  const k = await tv.kanalAc({ no: 3 });
  assert.equal(k.no, 3);
  assert.equal(olaylar.filter((o) => o.startsWith('ssap://tv/openChannel')).length, 1);
});

test('kanalAc: uyanan TV son kanala dönerse fark edilir ve komut yinelenir', async () => {
  const { tv, olaylar, durum } = sahteTv({ acik: false, geriAl: 1 });
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.deepEqual(k, { no: 3, ad: 'KANAL D HD', acildi: true, yineleme: 1 });
  assert.equal(kanalKomutlari(olaylar).length, 2);
  assert.equal(durum.kanal.channelId, 'k3');
});

test('kanalAc: TV son HDMI girişinde açılırsa canlı yayına geçirilir', async () => {
  const { tv, durum } = sahteTv({ acik: false, onPlan: 'com.webos.app.hdmi1', geriAl: 1 });
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.equal(k.yineleme, 1);
  assert.equal(durum.onPlan, 'com.webos.app.livetv');
});

test('kanalAc: kanal hiç tutmazsa "açıldı" denmez — 502 ve teşhis görüntüsü', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'teshis-'));
  try {
    const { tv, olaylar } = sahteTv({ acik: false, hepGeriAl: true, teshisDizini: dizin });
    await assert.rejects(tv.kanalAc({ ad: 'Kanal D' }), (e) => e.kod === 502 && /ekrana gelmedi/.test(e.message) && /7 TRT 1 HD/.test(e.message));
    assert.equal(kanalKomutlari(olaylar).length, 4, 'ilk komut + en çok 3 yineleme');
    const dosyalar = readdirSync(dizin);
    assert.equal(dosyalar.length, 1);
    assert.match(dosyalar[0], /^uyanma-oda-.*\.jpg$/);
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('kanalAc: TV zaten açıksa doğrulama beklenmez (hızlı yol)', async () => {
  const { tv, olaylar } = sahteTv({ acik: true, hepGeriAl: true });
  assert.deepEqual(await tv.kanalAc({ ad: 'Kanal D' }), { no: 3, ad: 'KANAL D HD', acildi: false });
  assert.equal(kanalKomutlari(olaylar).length, 1);
});

test('kanalAc: MAC yoksa 409, açılmazsa 504 ve ayar ipucu', async () => {
  const yok = sahteTv({ mac: null }).tv;
  await assert.rejects(yok.kanalAc({ ad: 'Kanal D' }), (e) => e.kod === 409 && /MAC/.test(e.message));
  const acilmaz = sahteTv({ acilirMi: false }).tv;
  await assert.rejects(acilmaz.kanalAc({ ad: 'Kanal D' }), (e) => e.kod === 504 && /Wi-Fi ile aç/.test(e.message));
});

test('kanalAc: bilinmeyen kanal 404', async () => {
  const { tv } = sahteTv({ acik: true });
  await assert.rejects(tv.kanalAc({ ad: 'Yok TV' }), (e) => e.kod === 404);
});

test('giriş: Apple TV, TV\'nin giriş adından bulunur; canlı yayına dönülür; durum kaynağı söyler', async () => {
  const { tv, olaylar, durum } = sahteTv({ acik: true });
  assert.deepEqual(await tv.girisDegistir('apple'), { kaynak: 'apple', uygulama: 'com.webos.app.hdmi2' });
  assert.equal(durum.onPlan, 'com.webos.app.hdmi2');
  assert.equal((await tv.durum()).kaynak, 'apple');
  assert.deepEqual(await tv.girisDegistir('canli'), { kaynak: 'canli', uygulama: 'com.webos.app.livetv' });
  assert.equal((await tv.durum()).kaynak, 'canli');
  assert.equal(olaylar.filter((o) => o.startsWith('ssap://system.launcher/launch')).length, 2);
});

test('kaynak menüsü: uygulama TV\'nin kendi uygulamasıyla açılır, durum onu söyler; yüklü değilse 404', async () => {
  const { tv, durum } = sahteTv({ acik: true });
  assert.deepEqual(await tv.girisDegistir('netflix'), { kaynak: 'netflix', uygulama: 'netflix', cihaz: 'lg' });
  assert.equal(durum.onPlan, 'netflix');
  assert.equal((await tv.durum()).kaynak, 'netflix');
  assert.deepEqual(await tv.girisDegistir('prime'), { kaynak: 'prime', uygulama: 'amazon', cihaz: 'lg' });
  assert.equal((await tv.durum()).kaynak, 'prime');
  await assert.rejects(tv.girisDegistir('disney'), (e) => e.kod === 404 && /Disney\+ bu TV'de yüklü değil/.test(e.message));
});

test('giriş: keyfi hedef 400, Apple TV girişi yoksa 404, kapalı TV önce açılır', async () => {
  const { tv } = sahteTv({ acik: true });
  await assert.rejects(tv.girisDegistir('com.netflix'), (e) => e.kod === 400);
  const yok = sahteTv({ acik: true, girisler: [{ id: 'HDMI_1', label: 'HDMI 1', appId: 'com.webos.app.hdmi1' }] }).tv;
  await assert.rejects(yok.girisDegistir('apple'), (e) => e.kod === 404 && /Apple TV girişi bulunamadı/.test(e.message));
  const kapali = sahteTv({ acik: false });
  await kapali.tv.girisDegistir('apple');
  assert.equal(kapali.olaylar[0], 'wol aa:bb:cc:dd:ee:ff 192.0.2.10');
});

// ───────────────────────────────────────────── HTTP uçları

const TOKEN = 'x'.repeat(40);

async function sunucuyla(tvler, ops, fn) {
  const s = sunucuKur(tvler, { token: TOKEN, log: () => {}, ...ops });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const taban = `http://127.0.0.1:${s.address().port}`;
  const iste = (yol, govde, { token = TOKEN } = {}) => fetch(taban + yol, {
    method: govde ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: govde ? JSON.stringify(govde) : undefined,
  });
  try { await fn(iste); } finally { await new Promise((r) => s.close(r)); }
}

test('HTTP: belirteçsiz 401, bilinmeyen TV 404, geçersiz kanal 400', async () => {
  const { tv } = sahteTv({ acik: true });
  await sunucuyla([tv], {}, async (iste) => {
    assert.equal((await iste('/tvler', null, { token: 'y'.repeat(40) })).status, 401);
    assert.equal((await iste('/kanal', { tv: 'yok', ad: 'Kanal D' })).status, 404);
    assert.equal((await iste('/kanal', { tv: 'oda' })).status, 400);
    assert.equal((await iste('/kanal', { tv: 'oda', no: '3; rm' })).status, 400);
  });
});

test('HTTP: /kanal kapalı TV\'yi açıp kanalı açar, /ac yalnız açar', async () => {
  const { tv, olaylar } = sahteTv({ acik: false });
  await sunucuyla([tv], {}, async (iste) => {
    const r = await iste('/kanal', { tv: 'oda', ad: 'Kanal D' });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).kanal, { no: 3, ad: 'KANAL D HD', acildi: true, yineleme: 0 });
    const a = await iste('/ac', { tv: 'oda' });
    assert.deepEqual(await a.json(), { ok: true, uyandirildi: false });
    assert.equal(olaylar.filter((o) => o.startsWith('wol')).length, 1);
  });
});

test('HTTP: /giris yalnız bilinen hedefleri kabul eder', async () => {
  const { tv } = sahteTv({ acik: true });
  await sunucuyla([tv], {}, async (iste) => {
    assert.equal((await iste('/giris', { tv: 'oda', hedef: 'youtube' })).status, 400);
    const r = await iste('/giris', { tv: 'oda', hedef: 'apple' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, kaynak: 'apple', uygulama: 'com.webos.app.hdmi2' });
  });
});

test('HTTP: /ac açılmayan TV için 504 ve okunur hata', async () => {
  const { tv } = sahteTv({ acilirMi: false });
  await sunucuyla([tv], {}, async (iste) => {
    const r = await iste('/ac', { tv: 'oda' });
    assert.equal(r.status, 504);
    assert.match((await r.json()).hata, /Wi-Fi ile aç/);
  });
});

test('HTTP: /epg rehberden gelir, TV kapalıyken de çalışır, numara önbellekten', async () => {
  const { tv } = sahteTv({ acik: false });
  tv.liste = [{ no: 3, ad: 'KANAL D HD', channelId: 'k3' }];
  const rehber = { kanal: async (ad) => (ad === 'Kanal D' ? { simdi: { ad: 'Dizi', bas: '20:00', bit: '22:00' }, sonraki: null, kaynak: 'digiturk' } : null) };
  await sunucuyla([tv], { rehber }, async (iste) => {
    const j = await (await iste('/epg', { tv: 'oda', adlar: ['Kanal D', 'Star TV'] })).json();
    assert.deepEqual(j.kanallar[0], { ad: 'Kanal D', no: 3, simdi: { ad: 'Dizi', bas: '20:00', bit: '22:00' }, sonraki: null, kaynak: 'digiturk' });
    assert.deepEqual(j.kanallar[1], { ad: 'Star TV', no: null, simdi: null, sonraki: null, kaynak: null });
  });
});

test('HTTP: /tvler bir TV uyandırılırken sırada beklemez', async () => {
  const { tv } = sahteTv({ acik: true });
  tv.durum = async () => ({ id: 'oda', acik: true });
  let birak;
  tv.sirayla(() => new Promise((r) => { birak = r; }));   // uzun süren iş (uyandırma gibi)
  await sunucuyla([tv], {}, async (iste) => {
    const r = await Promise.race([
      iste('/tvler').then((x) => x.json()),
      new Promise((_, red) => setTimeout(() => red(new Error('/tvler sırada bekledi')), 1000)),
    ]);
    assert.deepEqual(r.tvler, [{ id: 'oda', acik: true, kilit: null }]);
    assert.equal(r.saatDilimi, 'Europe/Istanbul');
    assert.equal(r.ofsetDk, 180);
  });
  birak();
});

// ───────────────────────────────────────────── zamanlayıcı, ekran, mesaj, canlı önizleme

test('HTTP: geri dön sayacı o anki kanala kurulur; canlı yayında değilse 409', async () => {
  const { tv, durum } = sahteTv({ acik: true });
  durum.kanal = { channelNumber: '3', channelName: 'KANAL D HD', channelId: 'k3' };
  const zamanlayici = new Zamanlayici({ calistir: async () => ({ sonuc: 'ok' }) });
  await sunucuyla([tv], { zamanlayici }, async (iste) => {
    const r = await iste('/zamanlayici', { islem: 'geri-don', tv: 'oda', dk: 8 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.sonuc.kanal, { no: 3, ad: 'KANAL D HD' });
    assert.equal(j.gorevler.length, 1);
    assert.equal((await iste('/zamanlayici', { islem: 'geri-don', tv: 'oda', dk: 0 })).status, 400);
    assert.equal((await iste('/zamanlayici', { islem: 'bilinmeyen' })).status, 400);
    assert.equal((await iste('/zamanlayici', { islem: 'sil', id: 'yok' })).status, 404);
    durum.onPlan = 'com.webos.app.hdmi2';
    assert.equal((await iste('/zamanlayici', { islem: 'geri-don', tv: 'oda', dk: 5 })).status, 409);
    const l = await (await iste('/zamanlayici')).json();
    assert.equal(l.gorevler.length, 1);
  });
  zamanlayici.durdur();
});

test('HTTP: program görevi eklenir ve listelenir', async () => {
  const { tv } = sahteTv({ acik: true });
  const zamanlayici = new Zamanlayici({ calistir: async () => ({ sonuc: 'ok' }) });
  await sunucuyla([tv], { zamanlayici }, async (iste) => {
    const r = await iste('/zamanlayici', { islem: 'ekle', tv: 'oda', kanal: 'TV8', zaman: { tur: 'haftalik', saat: '21:00', gunler: [1, 2, 3, 4, 5] }, tvKapaliysa: 'ac' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.gorevler[0].tur, 'haftalik');
    assert.equal(j.gorevler[0].kanal.ad, 'TV8');
    assert.equal((await iste('/zamanlayici', { islem: 'ekle', tv: 'yok', kanal: 'TV8', zaman: { tur: 'tek', tarih: '2030-01-01', saat: '10:00' } })).status, 404);
  });
  zamanlayici.durdur();
});

test('HTTP: ekranı kapat/aç ve TV mesajı (doğrulama)', async () => {
  const { tv, olaylar } = sahteTv({ acik: true });
  await sunucuyla([tv], {}, async (iste) => {
    assert.deepEqual(await (await iste('/ekran-guc', { tv: 'oda', kapali: true })).json(), { ok: true, ekranKapali: true });
    assert.ok(olaylar.some((o) => o.includes('power/turnOffScreen')));
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: 'Örnek bildirim', sureSn: 5 })).status, 200);
    assert.ok(olaylar.some((o) => o.includes('createToast') && o.includes('Örnek bildirim')));
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: '', sureSn: 5 })).status, 400);
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: 'x'.repeat(161), sureSn: 5 })).status, 400);
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: 'a', sureSn: 500 })).status, 400);
  });
});

test('HTTP: canlı önizleme — iki izleyici birbirini KESMEZ, tek çekim ikisine de dağıtılır', async () => {
  const { tv } = sahteTv({ acik: true });
  let kare = 0;
  tv.ekran = async () => { kare++; await new Promise((r) => setTimeout(r, 10)); return Buffer.from([0xff, 0xd8, kare & 255, 0xff, 0xd9]); };
  const s = sunucuKur([tv], { token: TOKEN, log: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const ac = async () => {
    const kes = new AbortController();
    const r = await fetch(`http://127.0.0.1:${s.address().port}/ekran-akis?tv=oda&sn=30&fps=10`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: kes.signal });
    const ok = r.body.getReader();
    const oku = async (n) => { let m = ''; while ((m.match(/--kare/g) || []).length < n) m += Buffer.from((await ok.read()).value).toString('latin1'); return m; };
    return { kes, oku };
  };
  const a = await ac();
  const b = await ac();
  await a.oku(3);
  await b.oku(3);                      // ikincisi açıldıktan sonra birincisi de akmaya devam etmeli
  await a.oku(2);
  const iki = kare;
  assert.ok(iki < 12, `tek çekim döngüsü: ${iki} kare çekildi (iki ayrı döngü olsaydı çok daha fazla)`);
  a.kes.abort(); b.kes.abort();
  await new Promise((r) => setTimeout(r, 300));
  const once = kare;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(kare - once <= 1, 'izleyici kalmayınca çekim durmalı');
  await new Promise((r) => s.close(r));
});

test('HTTP: canlı önizleme hızı fps ile sınırlanır (varsayılan 1 kare/sn)', async () => {
  const { tv } = sahteTv({ acik: true });
  let kare = 0;
  tv.ekran = async () => { kare++; return Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]); };
  const s = sunucuKur([tv], { token: TOKEN, log: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const kes = new AbortController();
  await fetch(`http://127.0.0.1:${s.address().port}/ekran-akis?tv=oda&sn=30`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: kes.signal });
  await new Promise((r) => setTimeout(r, 1600));
  kes.abort();
  assert.ok(kare >= 1 && kare <= 3, `1,6 sn'de 1 kare/sn ile ${kare} kare`);
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => s.close(r));
});

test('HTTP: canlı önizleme art arda JPEG akıtır, istemci kopunca durur', async () => {
  const { tv } = sahteTv({ acik: true });
  let kare = 0;
  tv.ekran = async () => { kare++; await new Promise((r) => setTimeout(r, 20)); return Buffer.from([0xff, 0xd8, kare, 0xff, 0xd9]); };
  const s = sunucuKur([tv], { token: TOKEN, log: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const kes = new AbortController();
  const r = await fetch(`http://127.0.0.1:${s.address().port}/ekran-akis?tv=oda&sn=30&fps=20`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: kes.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /multipart\/x-mixed-replace; boundary=kare/);
  const okuyucu = r.body.getReader();
  let metin = '';
  while ((metin.match(/--kare/g) || []).length < 3) metin += Buffer.from((await okuyucu.read()).value).toString('latin1');
  kes.abort();
  await new Promise((r2) => setTimeout(r2, 150));
  const once = kare;
  await new Promise((r2) => setTimeout(r2, 200));
  assert.ok(kare - once <= 1, 'istemci kopunca kare çekimi durmalı');
  await new Promise((r2) => s.close(r2));
});

test('Rehber.akis: tvplus günün tamamını verir; biten programlar düşer; sıralı ve tekil', async () => {
  const an = tr(2026, 10, 17, 21);
  const fetchFn = async (url, ops = {}) => {
    if (String(url).includes('digiturk')) return { ok: true, status: 200, text: async () => sayfa(12) };
    if (String(url).endsWith('/Authenticate')) return { ok: true, status: 200, headers: { getSetCookie: () => [] }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ playbilllist: [
      { name: 'Haber', starttime: '2026-10-17 19:00:00 UTC+03:00', endtime: '2026-10-17 20:00:00 UTC+03:00' },
      { name: 'Dizi', starttime: '2026-10-17 20:00:00 UTC+03:00', endtime: '2026-10-17 23:15:00 UTC+03:00' },
      { name: 'Gece', starttime: '2026-10-17 23:15:00 UTC+03:00', endtime: '2026-10-18 01:00:00 UTC+03:00' },
    ] }) };
  };
  const r = new Rehber({ fetchFn, simdi: () => an });
  const p = await r.akis('Kanal D', { saat: 30 });
  assert.deepEqual(p.map((x) => x.ad), ['Dizi', 'Gece']);
  assert.equal(p[0].bas, tr(2026, 10, 17, 20));
});

test('Rehber.akis: tvplus kimliği yoksa digiturk', async () => {
  const an = tr(2026, 10, 16, 12);
  const f = sahteFetch(sayfa(12, ORNEK));
  const r = new Rehber({ fetchFn: f, simdi: () => an });
  const p = await r.akis('CNN TURK', { saat: 30 });   // ORNEK'te CNN TURK var; TVPLUS_KIMLIK'te CNNTURK var ama sahte fetch tvplus'a JSON vermez
  assert.ok(p.length >= 1);
  assert.ok(p.every((x) => x.bit > an));
});

test('HTTP: /akis kanalların akışını döndürür', async () => {
  const { tv } = sahteTv({ acik: false });
  const rehber = { akis: async (ad) => (ad === 'TV8' ? [{ ad: 'Örnek Program', bas: 1, bit: 2 }] : []) };
  await sunucuyla([tv], { rehber }, async (iste) => {
    const j = await (await iste('/akis', { adlar: ['TV8', 'ATV'], saat: 30 })).json();
    assert.deepEqual(j.kanallar, [{ ad: 'TV8', programlar: [{ ad: 'Örnek Program', bas: 1, bit: 2 }] }, { ad: 'ATV', programlar: [] }]);
  });
});

test('HTTP: /isaretci imleci oynatır ya da tıklar; geçersiz hareket 400', async () => {
  const { tv } = sahteTv({ acik: true });
  const gonderilen = [];
  tv.kumanda = async () => ({ move: (dx, dy) => gonderilen.push(`move ${dx} ${dy}`), click: () => gonderilen.push('click') });
  await sunucuyla([tv], {}, async (iste) => {
    assert.equal((await iste('/isaretci', { tv: 'oda', dx: 12, dy: -7 })).status, 200);
    assert.equal((await iste('/isaretci', { tv: 'oda', tikla: true })).status, 200);
    for (const g of [{ dx: 1.5, dy: 0 }, { dx: 5000, dy: 0 }, { dx: 0, dy: 0 }, { dx: 'a', dy: 1 }]) {
      assert.equal((await iste('/isaretci', { tv: 'oda', ...g })).status, 400);
    }
  });
  assert.deepEqual(gonderilen, ['move 12 -7', 'click']);
});

// ───────────────────────────────────────────── Apple TV (pyatv köprüsü)

const ATV = { ip: '192.0.2.20', id: 'ORNEK000002' };
function sahteKopru({ hata = null } = {}) {
  const cagrilar = [];
  return { cagrilar, hazirMi: () => true, iste: async (cihaz, is, ek) => { cagrilar.push({ cihaz, is, ...ek }); if (hata) throw hata; return { ok: true }; } };
}

test('Apple TV: uygulama Apple TV\'de açılır, TV o girişe geçer; durum uygulamayı ve cihazı söyler', async () => {
  const k = sahteKopru();
  const { tv, durum } = sahteTv({ acik: true, appletv: ATV, atv: k });
  assert.deepEqual(await tv.girisDegistir('netflix'), { kaynak: 'netflix', cihaz: 'apple', uygulama: 'com.netflix.Netflix' });
  assert.deepEqual(k.cagrilar, [{ cihaz: ATV, is: 'uygulama', uygulama: 'com.netflix.Netflix' }]);
  assert.equal(durum.onPlan, 'com.webos.app.hdmi2');
  const d = await tv.durum();
  assert.equal(d.kaynak, 'netflix');
  assert.equal(d.cihaz, 'apple');
  assert.equal(d.appleTv, true);
  await tv.girisDegistir('canli');
  assert.equal((await tv.durum()).kaynak, 'canli');
  durum.onPlan = 'com.webos.app.hdmi2';   // elle Apple TV'ye dönülürse artık "netflix" sanılmaz
  assert.equal((await tv.durum()).kaynak, 'apple');
});

test('Apple TV: ulaşılamazsa TV\'nin kendi uygulaması açılır ve not düşülür; eşleşme yoksa doğrudan TV uygulaması', async () => {
  const k = sahteKopru({ hata: new Error('Apple TV bulunamadı') });
  const { tv, durum } = sahteTv({ acik: true, appletv: ATV, atv: k });
  const r = await tv.girisDegistir('netflix');
  assert.equal(r.cihaz, 'lg');
  assert.match(r.not, /Apple TV'ye ulaşılamadı/);
  assert.equal(durum.onPlan, 'netflix');
  const yok = sahteTv({ acik: true }).tv;   // Apple TV kaydı yok
  assert.deepEqual(await yok.girisDegistir('prime'), { kaynak: 'prime', uygulama: 'amazon', cihaz: 'lg' });
});

test('HTTP: /tus cihaz=apple tuşu Apple TV\'ye çevirerek gönderir; karşılıksız tuş 400, Apple TV yoksa 409; /metin', async () => {
  const k = sahteKopru();
  const { tv } = sahteTv({ acik: true, appletv: ATV, atv: k });
  const yok = sahteTv({ acik: true }).tv;
  yok.id = 'tv2';
  await sunucuyla([tv, yok], {}, async (iste) => {
    assert.equal((await iste('/tus', { tv: 'oda', tus: 'ENTER', cihaz: 'apple' })).status, 200);
    assert.equal((await iste('/tus', { tv: 'oda', tus: 'back', cihaz: 'apple' })).status, 200);
    assert.equal((await iste('/tus', { tv: 'oda', tus: 'RED', cihaz: 'apple' })).status, 400);
    assert.equal((await iste('/tus', { tv: 'tv2', tus: 'UP', cihaz: 'apple' })).status, 409);
    assert.equal((await iste('/metin', { tv: 'oda', metin: 'arama' })).status, 200);
    assert.equal((await iste('/metin', { tv: 'oda', metin: 'x'.repeat(101) })).status, 400);
  });
  assert.deepEqual(k.cagrilar.map((c) => `${c.is}:${c.tus || c.metin}`), ['tus:select', 'tus:menu', 'metin:arama']);
});

test('köprü: yardımcıya satır başına JSON yazar, yanıtı numarasıyla eşler; hata ve süreç düşmesi okunur hata olur', async () => {
  const surecler = [];
  const spawnFn = () => {
    const p = new EventEmitter();
    p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.stdin.on('data', (d) => {
      for (const satir of String(d).split('\n').filter(Boolean)) {
        const j = JSON.parse(satir);
        if (j.is === 'oldur') { p.emit('exit', 1); continue; }
        p.stdout.write(JSON.stringify(j.is === 'tus' ? { no: j.no, ok: true } : { no: j.no, ok: false, hata: 'eşleştirilmemiş' }) + '\n');
      }
    });
    surecler.push(p);
    return p;
  };
  const k = new AppleTvKopru({ python: '/x/python3', betik: '/x/b.py', depo: '/x/d.conf', spawnFn, varMi: () => true });
  assert.deepEqual(await k.iste(ATV, 'tus', { tus: 'up' }), { no: 1, ok: true });
  await assert.rejects(k.iste(ATV, 'uygulama', { uygulama: 'a' }), (e) => e.kod === 502 && /eşleştirilmemiş/.test(e.message));
  await assert.rejects(k.iste(ATV, 'oldur'), (e) => /yardımcısı kapandı/.test(e.message));
  await k.iste(ATV, 'tus', { tus: 'down' });
  assert.equal(surecler.length, 2, 'düşen süreç sonraki istekte yeniden başlar');
  const yok = new AppleTvKopru({ python: '/x', betik: '/x', depo: '/x', spawnFn, varMi: () => false });
  await assert.rejects(yok.iste(ATV, 'tus', { tus: 'up' }), (e) => e.kod === 409);
});

// ───────────────────────────────────────────── Ağ açık bekleme ("Active Standby")

test('güç: bekleme/askı kapalı sayılır; "Screen Off" (ekran kapalı, ses açık) ve "Active" açık', () => {
  for (const r of [{ state: 'Active Standby' }, { state: 'Suspend' }, { state: 'Active', processing: 'Request Power Off' }, { state: 'Power Off' }]) assert.equal(gucKapaliMi(r), true, JSON.stringify(r));
  for (const r of [{ state: 'Active' }, { state: 'Screen Off' }, { state: 'Screen Saver' }, null]) assert.equal(gucKapaliMi(r), false, JSON.stringify(r));
});

test('beklemedeki TV (eski oturum yanıt veriyor): durum kapalı der, kanal düğmesi uyandırır', async () => {
  const s = { guc: 'Active Standby', olaylar: [] };
  const tv = new Tv({ id: 'tv1', ad: 'TV 1', ip: '192.0.2.11', mac: 'aa:bb:cc:dd:ee:01' }, 'anahtar', {
    wol: async () => { s.olaylar.push('wol'); s.guc = 'Active'; },
    uyanma: { sureMs: 10000, araMs: 1, wolAraMs: 1, bekle: async () => {}, simdi: (() => { let t = 0; return () => (t += 100); })() },
  });
  tv.baglan = async () => ({});   // oturum açık: bekleyen TV'de de kurulu kalıyor
  tv.birak = () => { s.olaylar.push('birak'); };
  tv.kanallar = async () => [{ no: 3, ad: 'KANAL D HD', channelId: 'k3' }];
  let kanal = { channelNumber: '7', channelName: 'TRT 1 HD', channelId: 't7' };
  tv.iste = async (uri, payload) => {
    if (uri.endsWith('/getPowerState')) return { state: s.guc };
    if (uri.endsWith('/getForegroundAppInfo')) return { appId: 'com.webos.app.livetv' };
    if (uri === 'ssap://tv/getCurrentChannel') return kanal;
    if (uri.endsWith('/listLaunchPoints')) return { launchPoints: [] };
    if (uri === 'ssap://tv/getExternalInputList') return { devices: [] };
    if (uri === 'ssap://tv/openChannel') { s.olaylar.push('kanal'); kanal = { channelNumber: '3', channelName: 'KANAL D HD', channelId: 'k3' }; }
    return {};
  };
  const d = await tv.durum();
  assert.equal(d.acik, false);
  assert.match(d.sebep, /beklemede/);
  assert.equal(await tv.hazirMi(), false);
  const k = await tv.kanalAc({ ad: 'Kanal D' });
  assert.equal(k.acildi, true);
  assert.equal(s.olaylar.indexOf('wol') < s.olaylar.indexOf('kanal'), true, 'önce uyandırma, sonra kanal');
  assert.equal((await tv.durum()).acik, true);
});

test('lg-ssap: eşleşmede yanıtsız kapanan bağlantı → "beklemede" hatası', async () => {
  // Beklemedeki TV 3001'i açık tutar, eşleşme mesajını alıp soketi kapatır — kapanış bekleyenleri düşürür.
  const tv = new LgSsap('192.0.2.1');
  tv.ws = { send() { queueMicrotask(() => { for (const { fail } of tv.pending.values()) fail(new Error('Bağlantı kapandı')); tv.pending.clear(); }); } };
  await assert.rejects(tv.register('anahtar'), (e) => e.kod === 'beklemede' && /beklemede/.test(e.message) && /Wake-on-LAN/.test(e.message));
  // Başka hatalar olduğu gibi geçer.
  tv.ws = { send() { queueMicrotask(() => { for (const { fail } of tv.pending.values()) fail(new Error('yanıt gelmedi (zaman aşımı)')); tv.pending.clear(); }); } };
  await assert.rejects(tv.register('anahtar'), /zaman aşımı/);
});

// ───────────────────────────────────────────── denetim bulgularının regresyonları

test('Apple TV: uygulama açıldı ama TV o girişe geçirilemiyorsa "açıldı" denmez — TV uygulamasına düşülür, not doğru', async () => {
  const k = sahteKopru();
  const { tv, durum } = sahteTv({ acik: true, appletv: ATV, atv: k, girisler: [{ id: 'HDMI_1', label: 'HDMI 1', appId: 'com.webos.app.hdmi1' }] });
  const r = await tv.girisDegistir('netflix');
  assert.equal(r.cihaz, 'lg');
  assert.match(r.not, /Apple TV girişi bulunamadı/);
  assert.equal(durum.onPlan, 'netflix');
});

test('uygulama/giriş adları: ilk istek başarısızsa eksik harita önbelleğe alınmaz (Apple TV girişi sonra bulunur)', async () => {
  const { tv } = sahteTv({ acik: true });
  const asil = tv.iste;
  let dusur = true;
  tv.iste = async (uri, payload) => {
    if (dusur && uri === 'ssap://tv/getExternalInputList') throw new Error('yanıt gelmedi (zaman aşımı)');
    return asil(uri, payload);
  };
  await tv.adlar();
  assert.equal(tv.appleUygulama, null);
  assert.equal(tv.uygulamaAdlari, null, 'eksik yanıt önbelleğe girmedi');
  dusur = false;
  assert.deepEqual(await tv.girisDegistir('apple'), { kaynak: 'apple', uygulama: 'com.webos.app.hdmi2' });
  assert.ok(tv.uygulamaAdlari, 'tam yanıt önbellekte');
});

test('HTTP: /bildirim ortada — çok satır (aradaki boş satır, girinti korunur), 300 karakter / 5 satır sınırı', async () => {
  const { tv, olaylar } = sahteTv({ acik: true });
  await sunucuyla([tv], {}, async (iste) => {
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: '\nSatır 1\n\n   Satır 3', sureSn: 5, ortada: true })).status, 200);
    const alert = olaylar.find((o) => o.includes('createAlert'));
    assert.ok(alert, 'ortadaki pencere açıldı');
    assert.match(alert, /Satır 1<br><br>\u00a0\u00a0\u00a0Satır 3/, 'aradaki boş satır ve girinti korunur');
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: 'a\nb\nc\nd\ne\nf', sureSn: 5, ortada: true })).status, 400);
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: 'x'.repeat(250), sureSn: 5, ortada: true })).status, 200);
    assert.equal((await iste('/bildirim', { tv: 'oda', mesaj: 'x'.repeat(301), sureSn: 5, ortada: true })).status, 400);
  });
});

test('HTTP: /ses okur (iki yanıt biçimi, harici çıkışta seviye yok) ve ayarlar (0-100)', async () => {
  const { tv, olaylar } = sahteTv({ acik: true });
  const asil = tv.iste;
  let yanit = { volumeStatus: { volume: 12, muteStatus: false, soundOutput: 'tv_speaker' } };
  tv.iste = async (uri, payload) => (uri === 'ssap://audio/getVolume' ? yanit : asil(uri, payload));
  await sunucuyla([tv], {}, async (iste) => {
    assert.deepEqual(await (await iste('/ses?tv=oda')).json(), { seviye: 12, sessiz: false, cikis: 'tv_speaker' });
    yanit = { volume: -1, muted: true, scenario: 'external_arc' };
    assert.deepEqual(await (await iste('/ses?tv=oda')).json(), { seviye: null, sessiz: true, cikis: 'external_arc' });
    assert.deepEqual(await (await iste('/ses', { tv: 'oda', seviye: 20 })).json(), { ok: true, seviye: 20 });
    assert.ok(olaylar.some((o) => o.startsWith('ssap://audio/setVolume') && o.includes('20')));
    assert.equal((await iste('/ses', { tv: 'oda', seviye: 101 })).status, 400);
  });
});

test('HTTP: /izleme — gün aralığı, kesitler ve özet; kapalıysa 503, geçersiz gün 400', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'izleme-'));
  try {
    const { tv } = sahteTv({ acik: true });
    const iz = new IzlemeKaydi({ dizin, tvler: [] });
    await iz.yukle();
    const k = { tv: 'oda', bas: tr(2026, 10, 18, 20, 0), bit: tr(2026, 10, 18, 21, 0), kaynak: 'canli', kanal: { no: 3, ad: 'KANAL D HD' }, program: 'Dizi', uygulama: null };
    await iz._yaz('oda', k, k.bit);
    await sunucuyla([tv], {}, async (iste) => { assert.equal((await iste('/izleme')).status, 503); });
    await sunucuyla([tv], { izleme: iz }, async (iste) => {
      const r = await (await iste('/izleme?gun=2026-10-18&tv=oda')).json();
      assert.deepEqual([r.bas, r.bit], [tr(2026, 10, 18, 0), tr(2026, 10, 19, 0)]);
      assert.equal(r.kesitler.length, 1);
      assert.equal(r.ozet.izlenen, 3600e3);
      assert.equal(r.ozet.saat[20], 3600e3);
      assert.equal((await iste('/izleme?gun=2026-02-31')).status, 400);
      assert.equal((await iste('/izleme?gun=dun')).status, 400);
      assert.equal((await iste('/izleme?tv=yok')).status, 404);
    });
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('HTTP: sırada uzun bekleyen kumanda tuşu basılmaz (takılma bitince biriken tuşlar topluca gitmez)', async () => {
  const { tv } = sahteTv({ acik: true });
  const basilan = [];
  tv.tus = async (ad) => { basilan.push(ad); };
  let birak;
  tv.sirayla(() => new Promise((r) => { birak = r; }));   // TV takıldı
  await sunucuyla([tv], {}, async (iste) => {
    const bekleyen = iste('/tus', { tv: 'oda', tus: 'VOLUMEUP' });
    await new Promise((r) => setTimeout(r, 3300));
    birak();
    const r = await bekleyen;
    assert.equal(r.status, 503);
    assert.match((await r.json()).hata, /sırada bekledi/);
    assert.equal((await iste('/tus', { tv: 'oda', tus: 'VOLUMEUP' })).status, 200);
  });
  assert.deepEqual(basilan, ['VOLUMEUP']);
});
