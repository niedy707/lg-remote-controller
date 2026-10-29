'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const kumanda = require('./kumanda.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST = 'kumanda.ornek.test';
const SIFRE = 'kalici-sifre-ornek';
const OTURUM = 'tek-oturum-ornek';
const ANAHTAR = 'x'.repeat(64);

/** Kumanda yönlendiricisi + arkasında, kumandanın yakalamaması gereken istekleri gösteren bir yakalayıcı. */
async function kur(t, ek = {}) {
  const app = express();
  app.use(express.json());
  const tvCagrilar = [];
  const tvRouter = express.Router();
  tvRouter.get('/tvler', (req, res) => { tvCagrilar.push('tvler'); res.json({ tvler: [] }); });
  tvRouter.post('/tus', (req, res) => { tvCagrilar.push('tus'); res.json({ ok: true }); });
  const bildirimler = [];
  const gunluk = [];
  app.use(kumanda.olustur({ sifre: SIFRE, oturumSifresi: OTURUM, imzaAnahtari: ANAHTAR, tvRouter, log: (m) => gunluk.push(m), hataGecikmesiMs: 0, bildir: async (b, m) => { bildirimler.push(`${b}|${m}`); }, ...ek }));
  app.use((req, res) => res.status(299).send('YAKALANMAMALI'));
  const s = http.createServer(app);
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  const port = s.address().port;
  t.after(() => new Promise((ok) => s.close(ok)));
  const istek = (yol, { host = HOST, cerez, form, json, ip, origin, yontem, basliklar = {} } = {}) => new Promise((ok, red) => {
    const govde = form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : null;
    const tip = json ? 'application/json' : 'application/x-www-form-urlencoded';
    const r = http.request({
      host: '127.0.0.1', port, path: yol, method: yontem || (govde != null ? 'POST' : 'GET'),
      headers: { Host: host, ...basliklar, ...(ip ? { 'X-Test-Ip': ip } : {}), ...(origin ? { Origin: origin } : {}), ...(cerez ? { Cookie: cerez } : {}), ...(govde != null ? { 'Content-Type': tip, 'Content-Length': Buffer.byteLength(govde) } : {}) },
    }, (yanit) => {
      let veri = '';
      yanit.on('data', (p) => { veri += p; });
      yanit.on('end', () => ok({ kod: yanit.statusCode, basliklar: yanit.headers, govde: veri }));
    });
    r.on('error', red);
    if (govde != null) r.write(govde);
    r.end();
  });
  return { istek, tvCagrilar, bildirimler, gunluk };
}

const cerezAl = (r) => (r.basliklar['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(`${kumanda.COOKIE_NAME}=`));
const girisYap = async (k, sifre = SIFRE) => cerezAl(await k.istek('/login', { form: { password: sifre } }));
const ipIle = { istemciIp: (req) => req.headers['x-test-ip'] || 'yok' };

test('yalnız açık listedeki dosyalar sunulur: kaynak, ayar ve veri dosyaları 404', async (t) => {
  const k = await kur(t);
  for (const yol of ['/index.html', '/izleme.html', '/engel.html', '/server/sunucu.cjs', '/config.json', '/package.json', '/data/abonelikler.json', '/.env', '/api/baska']) {
    const r = await k.istek(yol);
    assert.strictEqual(r.kod, 404, `${yol} sunuldu`);
  }
  for (const yol of ['/app.js', '/i18n.js', '/saat.js', '/izleme.js', '/engel.js']) assert.strictEqual((await k.istek(yol)).kod, 200, yol);
});

test('girişsiz: sayfalar giriş ekranına, API 401', async (t) => {
  const k = await kur(t);
  for (const yol of ['/', '/detail', '/engel']) {
    const a = await k.istek(yol);
    assert.strictEqual(a.kod, 302, yol);
    assert.strictEqual(a.basliklar.location, '/login');
  }
  assert.strictEqual((await k.istek('/api/tv/tvler')).kod, 401);
  assert.strictEqual((await k.istek('/api/ayar')).kod, 401);
  assert.strictEqual((await k.istek('/api/tv/tus', { json: { tv: 'tv1', tus: 'UP' } })).kod, 401, 'POST uçları da girişsiz 401');
  assert.strictEqual(k.tvCagrilar.length, 0);
  const g = await k.istek('/login');
  assert.strictEqual(g.kod, 200);
  assert.match(g.govde, /<title>LG Remote — Giriş<\/title>/);
  assert.match(g.govde, /<h1>LG Remote<\/h1>/);
});

test('giriş sayfası her klavyeyi kabul eder (yalnız rakam klavyesi açılmaz)', () => {
  assert.doesNotMatch(kumanda.girisSayfasi(), /inputmode=/);
});

test('kalıcı şifre: uzun ömürlü çerez, kumanda sayfası ve API açılır', async (t) => {
  const k = await kur(t);
  const g = await k.istek('/login', { form: { password: SIFRE } });
  assert.strictEqual(g.kod, 302);
  assert.strictEqual(g.basliklar.location, '/');
  const ham = g.basliklar['set-cookie'].find((c) => c.startsWith(kumanda.COOKIE_NAME));
  const maxAge = Number(/Max-Age=(\d+)/.exec(ham)[1]);
  assert.ok(maxAge >= 399 * 86400 && maxAge <= 400 * 86400, 'tarayıcının 400 gün sınırı içinde');
  assert.match(ham, /HttpOnly/);
  assert.match(ham, /Secure/, 'kumanda çerezi yalnız HTTPS ile gitmeli');
  assert.match(ham, /SameSite=Lax/);
  const c = cerezAl(g);
  const s = await k.istek('/', { cerez: c });
  assert.strictEqual(s.kod, 200);
  assert.match(s.govde, /<title>LG Remote<\/title>/);
  assert.match(s.govde, /<form[^>]*method="POST"[^>]*action="\/logout"/, 'çıkış POST formu');
  assert.match(s.govde, /<script src="\/app.js"><\/script>/);
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: c })).kod, 200);
  assert.deepStrictEqual(k.tvCagrilar, ['tvler']);
});

test('Detail ve Engeller sayfaları: girişliyken sunulur, betikleri yüklenir; kumandadaki bağlantılar bu adreslere', async (t) => {
  const k = await kur(t);
  const c = await girisYap(k);
  const d = await k.istek('/detail', { cerez: c });
  assert.strictEqual(d.kod, 200);
  assert.match(d.govde, /<script src="\/i18n.js"><\/script>\s*<script src="\/saat.js"><\/script>\s*<script src="\/izleme.js"><\/script>/);
  const e = await k.istek('/engel', { cerez: c });
  assert.strictEqual(e.kod, 200);
  assert.match(e.govde, /<script src="\/i18n.js"><\/script>\s*<script src="\/saat.js"><\/script>\s*<script src="\/engel.js"><\/script>/);
  const ana = await k.istek('/', { cerez: c });
  assert.match(ana.govde, /href="\/detail" id="izlemeAc"/);
  assert.match(ana.govde, /href="\/engel" id="engelAc"/);
  for (const g of [d.govde, e.govde]) assert.match(g, /href="\/"/, 'kumandaya geri dönüş');
});

test('saat dilimi: KUMANDA_TZ arayüze verilir; geçersizse varsayılan İstanbul', async (t) => {
  const k = await kur(t, { saatDilimi: 'Europe/Berlin' });
  const c = await girisYap(k);
  assert.deepStrictEqual(JSON.parse((await k.istek('/api/ayar', { cerez: c })).govde), { saatDilimi: 'Europe/Berlin' });
  const v = await kur(t, { saatDilimi: undefined });
  assert.deepStrictEqual(JSON.parse((await v.istek('/api/ayar', { cerez: await girisYap(v) })).govde), { saatDilimi: 'Europe/Istanbul' });
  const b = await kur(t, { saatDilimi: 'Mars/Olympus' });
  assert.deepStrictEqual(JSON.parse((await b.istek('/api/ayar', { cerez: await girisYap(b) })).govde), { saatDilimi: 'Europe/Istanbul' });
  assert.ok(b.gunluk.some((m) => /KUMANDA_TZ geçersiz/.test(m)));
});

test('tek oturumluk şifre: Max-Age olmayan (tarayıcı kapanınca silinen) çerez', async (t) => {
  const k = await kur(t);
  const g = await k.istek('/login', { form: { password: OTURUM } });
  const ham = g.basliklar['set-cookie'].find((c) => c.startsWith(kumanda.COOKIE_NAME));
  assert.doesNotMatch(ham, /Max-Age/i);
  assert.strictEqual((await k.istek('/', { cerez: cerezAl(g) })).kod, 200);
});

test('tek oturumluk belirteç 12 saat sonra geçersiz', async (t) => {
  let saat = 1_800_000_000_000;
  const k = await kur(t, { simdi: () => saat });
  const c = await girisYap(k, OTURUM);
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: c })).kod, 200);
  saat += 12 * 3600e3 + 1000;
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: c })).kod, 401);
});

test('başka anahtarla imzalanmış ya da kurcalanmış çerez geçmez', async (t) => {
  const k = await kur(t);
  const c = await girisYap(k);
  // Çerez değeri URL kodlu (`:` → `%3A`): çöz, verilişi değiştir, geri kodla.
  const [ad, deger] = c.split('=');
  const kurcali = `${ad}=${encodeURIComponent(decodeURIComponent(deger).replace(/^master:(\d+)/, (m, z) => `master:${Number(z) - 1}`))}`;
  assert.notStrictEqual(kurcali, c, 'kurcalama gerçekleşmeli');
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: kurcali })).kod, 401);
  const tur = `${ad}=${encodeURIComponent(decodeURIComponent(deger).replace(/^master:/, 'admin:'))}`;
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: tur })).kod, 401, 'bilinmeyen tür');
  const baska = await kur(t, { imzaAnahtari: 'y'.repeat(64) });
  assert.strictEqual((await baska.istek('/api/tv/tvler', { cerez: c })).kod, 401);
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: 'baska_session=master:1:99999999999999.abc' })).kod, 401);
});

test('şifre değişince o türün eski çerezleri geçersiz; oturum nesli değişince hepsi', async (t) => {
  const k = await kur(t);
  const kalici = await girisYap(k);
  const misafir = await girisYap(k, OTURUM);
  const yeniSifre = await kur(t, { sifre: 'baska-kalici-sifre' });
  assert.strictEqual((await yeniSifre.istek('/api/tv/tvler', { cerez: kalici })).kod, 401, 'kalıcı şifre değişti');
  assert.strictEqual((await yeniSifre.istek('/api/tv/tvler', { cerez: misafir })).kod, 200, 'misafir şifresi aynı');
  const yeniMisafir = await kur(t, { oturumSifresi: 'baska-misafir' });
  assert.strictEqual((await yeniMisafir.istek('/api/tv/tvler', { cerez: misafir })).kod, 401);
  assert.strictEqual((await yeniMisafir.istek('/api/tv/tvler', { cerez: kalici })).kod, 200);
  const nesil = await kur(t, { oturumNesli: '1' });
  assert.strictEqual((await nesil.istek('/api/tv/tvler', { cerez: kalici })).kod, 401);
  assert.strictEqual((await nesil.istek('/api/tv/tvler', { cerez: misafir })).kod, 401);
});

test('kalıcı giriş kullanıldıkça yenilenir (kayan süre): 30 günden eski çereze yenisi verilir', async (t) => {
  let saat = 1_800_000_000_000;
  const k = await kur(t, { simdi: () => saat });
  const c = await girisYap(k);
  const taze = await k.istek('/api/tv/tvler', { cerez: c });
  assert.strictEqual(cerezAl(taze), undefined, 'yeni çerezde yenileme yok');
  saat += 31 * 86400e3;
  const eski = await k.istek('/api/tv/tvler', { cerez: c });
  assert.strictEqual(eski.kod, 200);
  const yeni = cerezAl(eski);
  assert.ok(yeni && yeni !== c, 'yeni çerez verildi');
  saat += 380 * 86400e3;   // ilk çerezin 400 günü dolmak üzere; yenisi geçerli
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: yeni })).kod, 200);
  saat += 30 * 86400e3;
  assert.strictEqual((await k.istek('/api/tv/tvler', { cerez: c })).kod, 401, 'ilk çerezin süresi doldu');
});

test('çıkış: POST çerezi siler; GET çıkış yapmaz; başka siteden POST reddedilir', async (t) => {
  const k = await kur(t);
  const c = await girisYap(k);
  const g = await k.istek('/logout', { cerez: c });
  assert.strictEqual(g.kod, 302);
  assert.strictEqual(g.basliklar.location, '/');
  assert.strictEqual(g.basliklar['set-cookie'], undefined, 'GET çerezi silmez');
  const yabanci = await k.istek('/logout', { cerez: c, form: {}, origin: 'https://kotu.example' });
  assert.strictEqual(yabanci.kod, 403);
  const p = await k.istek('/logout', { cerez: c, form: {}, basliklar: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(p.kod, 303);
  assert.strictEqual(p.basliklar.location, '/login');
  assert.match(p.basliklar['set-cookie'].join(';'), new RegExp(`${kumanda.COOKIE_NAME}=;`));
});

test('kısa şifre ve kısa imza anahtarı: uyarı / başlatmama', async (t) => {
  const k = await kur(t, { sifre: '1234' });
  assert.ok(k.gunluk.some((m) => /10 karakterden kısa/.test(m)));
  assert.throws(() => kumanda.olustur({ tvRouter: express.Router(), imzaAnahtari: 'kisa', log: () => {} }), /en az 32 karakter/);
});

test('şifre tanımsızsa kimse giremez (boş şifre tuzağı)', async (t) => {
  const k = await kur(t, { sifre: undefined, oturumSifresi: undefined });
  const g = await k.istek('/login', { form: { password: '' } });
  assert.strictEqual(g.basliklar.location, '/login?error=1');
  assert.strictEqual(cerezAl(g), undefined);
});

test('5 hatalı denemeden sonra doğru şifre de kilitli', async (t) => {
  const k = await kur(t);
  for (let i = 0; i < 5; i++) await k.istek('/login', { form: { password: 'yanlis' } });
  const g = await k.istek('/login', { form: { password: SIFRE } });
  assert.strictEqual(g.basliklar.location, '/login?error=lock');
  assert.strictEqual(cerezAl(g), undefined);
});

test('web uygulaması dosyaları: kumandanın kendi manifesti ve ikonları', async (t) => {
  const k = await kur(t);
  const m = await k.istek('/manifest.json');
  assert.strictEqual(m.kod, 200);
  assert.match(m.basliklar['content-type'], /application\/manifest\+json/);
  assert.strictEqual(JSON.parse(m.govde).short_name, 'LG Remote');
  const i = await k.istek('/icons/apple-touch-icon.png');
  assert.strictEqual(i.kod, 200);
  assert.match(i.basliklar['content-type'], /image\/png/);
});

test('sayfalar yerinde: kumanda, giriş, Detail ve Engeller sayfası okunur', () => {
  assert.match(kumanda.kumandaSayfasi(), /<h1 class="sr">LG Remote<\/h1>/);
  assert.match(kumanda.girisSayfasi(), /rel="manifest"/);
  assert.match(kumanda.izlemeSayfasi(), /<script src="\/izleme.js"><\/script>/);
  assert.match(kumanda.engelSayfasi(), /<script src="\/engel.js"><\/script>/);
});

test('farklı adreslerden toplam 20 hatalı deneme: giriş herkese kilitlenir (kısa şifreye karşı)', async (t) => {
  const k = await kur(t, ipIle);
  for (let i = 0; i < 19; i++) await k.istek('/login', { form: { password: 'yanlis' }, ip: `198.51.100.${i}` });
  const once = await k.istek('/login', { form: { password: SIFRE }, ip: '203.0.113.9' });
  assert.strictEqual(once.basliklar.location, '/', '19 hatada henüz kilit yok');
  await k.istek('/login', { form: { password: 'yanlis' }, ip: '198.51.100.200' });
  const sonra = await k.istek('/login', { form: { password: SIFRE }, ip: '203.0.113.8' });
  assert.strictEqual(sonra.basliklar.location, '/login?error=lock');
  assert.strictEqual(cerezAl(sonra), undefined);
  // Girişli cihaz etkilenmez.
  assert.strictEqual((await k.istek('/', { cerez: cerezAl(once) })).kod, 200);
});

test('5 hatalı denemede kilit + bildirim; ikinci IP kilidi 15 dk içinde ikinci "kilitlendi" bildirimi göndermez', async (t) => {
  const k = await kur(t, ipIle);
  for (let i = 0; i < 5; i++) await k.istek('/login', { form: { password: 'yanlis' }, ip: '198.51.100.1' });
  assert.strictEqual(k.bildirimler.length, 1);
  assert.match(k.bildirimler[0], /198\.51\.100\.1 adresinden 5 hatalı şifre/);
  for (let i = 0; i < 5; i++) await k.istek('/login', { form: { password: 'yanlis' }, ip: '198.51.100.2' });
  assert.strictEqual(k.bildirimler.filter((b) => /kilitlendi/.test(b)).length, 1, 'kısıtlama: 15 dk içinde ikinci IP kilidi bildirimi yok');
  // Kilitli IP doğru şifreyle de giremez; başka IP girebilir.
  assert.strictEqual((await k.istek('/login', { form: { password: SIFRE }, ip: '198.51.100.1' })).basliklar.location, '/login?error=lock');
  assert.strictEqual((await k.istek('/login', { form: { password: SIFRE }, ip: '198.51.100.3' })).basliklar.location, '/');
});

test('IP kilidi bildirimi GENEL KİLİT bildirimini yutmaz (konu başına kısıtlama)', async (t) => {
  const k = await kur(t, ipIle);
  for (let a = 1; a <= 4; a++) for (let i = 0; i < 5; i++) await k.istek('/login', { form: { password: 'yanlis' }, ip: `198.51.100.${a}` });
  assert.ok(k.bildirimler.some((b) => /^Kumanda: giriş denemesi kilitlendi/.test(b)));
  assert.ok(k.bildirimler.some((b) => /^Kumanda: GENEL GİRİŞ KİLİDİ/.test(b)), 'genel kilit bildirimi gitti');
});

test('eşik altı yavaş tarama: saatte 19 deneme sessiz kalmaz, 24 saatte 60 hatada giriş 24 saat kapanır', async (t) => {
  let saat = 1_800_000_000_000;
  const k = await kur(t, { ...ipIle, simdi: () => saat });
  let n = 0;
  const tur = async () => {
    for (let i = 0; i < 19; i++) await k.istek('/login', { form: { password: `yanlis-${n++}` }, ip: `198.51.100.${n % 200}` });
    saat += 3600e3 + 1000;
  };
  await tur();
  assert.ok(k.bildirimler.some((b) => /şüpheli giriş denemeleri/.test(b)), 'kilit tetiklenmese de bildirim');
  assert.ok(!k.bildirimler.some((b) => /KİLİDİ/.test(b)), 'saatte 19: genel kilit yok');
  await tur();
  await tur();
  for (let i = 0; i < 3; i++) await k.istek('/login', { form: { password: 'yanlis' }, ip: `203.0.113.${i}` });
  assert.ok(k.bildirimler.some((b) => /GÜNLÜK GİRİŞ KİLİDİ/.test(b)), '60. hatada günlük kilit');
  saat += 2 * 3600e3;   // saatlik kilit çoktan bitti; günlük sürüyor
  assert.strictEqual((await k.istek('/login', { form: { password: SIFRE }, ip: '203.0.113.50' })).basliklar.location, '/login?error=lock');
  saat += 23 * 3600e3;
  assert.strictEqual((await k.istek('/login', { form: { password: SIFRE }, ip: '203.0.113.51' })).basliklar.location, '/');
});

test('başka siteden gelen POST reddedilir, aynı siteden gelen geçer', async (t) => {
  const k = await kur(t);
  const yabanci = await k.istek('/login', { form: { password: SIFRE }, origin: 'https://kotu.example' });
  assert.strictEqual(yabanci.kod, 403);
  assert.strictEqual(cerezAl(yabanci), undefined);
  const ayni = await k.istek('/login', { form: { password: SIFRE }, origin: `https://${HOST}` });
  assert.strictEqual(ayni.kod, 302);
  assert.ok(cerezAl(ayni));
});

test('API yazma uçları da başka siteden reddedilir (girişli çerezle bile)', async (t) => {
  const k = await kur(t);
  const c = await girisYap(k);
  const r = await k.istek('/api/tv/tus', { cerez: c, json: { tv: 'tv1', tus: 'UP' }, basliklar: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(r.kod, 403);
  const b = await k.istek('/api/bildirim/birak', { cerez: c, json: { endpoint: 'https://web.push.apple.com/x' }, origin: 'https://kotu.example' });
  assert.strictEqual(b.kod, 403);
  const sil = await k.istek('/api/tv/kilit/tv1', { cerez: c, yontem: 'DELETE', origin: 'https://kotu.example' });
  assert.strictEqual(sil.kod, 403);
  assert.strictEqual(k.tvCagrilar.length, 0);
});

test('kendi sayfamızdan giden form: Origin "null" (no-referrer politikası) REDDEDİLMEZ', async (t) => {
  const k = await kur(t);
  // Tarayıcının gerçekte gönderdiği: Referrer-Policy no-referrer → Origin: null, Sec-Fetch-Site: same-origin
  const g = await k.istek('/login', { form: { password: SIFRE }, origin: 'null', basliklar: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(g.kod, 302);
  assert.strictEqual(g.basliklar.location, '/');
  assert.ok(cerezAl(g));
  // Sec-Fetch-Site göndermeyen eski tarayıcı + null: yine geçer (SameSite=Lax çerez zaten korur)
  assert.strictEqual((await k.istek('/login', { form: { password: SIFRE }, origin: 'null' })).kod, 302);
});

test('Origin null olsa da tarayıcı "başka site" diyorsa reddedilir', async (t) => {
  const k = await kur(t);
  for (const site of ['cross-site', 'same-site']) {
    const g = await k.istek('/login', { form: { password: SIFRE }, origin: 'null', basliklar: { 'Sec-Fetch-Site': site } });
    assert.strictEqual(g.kod, 403, site);
    assert.strictEqual(cerezAl(g), undefined);
  }
});

test('kanal logoları logo dizininden sunulur; yol dışına çıkılamaz', async (t) => {
  const dizin = fs.mkdtempSync(path.join(os.tmpdir(), 'logolar-'));
  fs.writeFileSync(path.join(dizin, 'kanald.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  t.after(() => fs.rmSync(dizin, { recursive: true, force: true }));
  const k = await kur(t, { logoDizini: dizin });
  const r = await k.istek('/logolar/kanald.png');
  assert.strictEqual(r.kod, 200);
  assert.match(r.basliklar['content-type'], /image\/png/);
  assert.strictEqual((await k.istek('/logolar/..%2Fkumanda.cjs')).kod, 404);
  assert.strictEqual((await k.istek('/logolar/yok.png')).kod, 404);
});

const ornekAbonelik = () => ({ endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } });

test('bildirim aboneliği: girişsiz 401; girişli abone olur, deneme gönderilir, bırakır; servis çalışanı sunulur', async (t) => {
  const kayit = new Map();
  const denenen = [];
  const bildirimler = {
    anahtar: () => 'BXYZ',
    ekle: (sub) => kayit.set(sub.endpoint, sub),
    sil: (e) => kayit.delete(e),
    varMi: (e) => kayit.has(e),
    dene: async (e) => { denenen.push(e); return 'ok'; },
  };
  const k = await kur(t, { bildirimler });
  const sub = ornekAbonelik();
  assert.strictEqual((await k.istek('/api/bildirim/anahtar')).kod, 401);
  assert.strictEqual((await k.istek('/api/bildirim/abone', { json: { subscription: sub } })).kod, 401);
  assert.strictEqual(kayit.size, 0);
  const c = await girisYap(k);
  const a = await k.istek('/api/bildirim/anahtar', { cerez: c });
  assert.deepStrictEqual(JSON.parse(a.govde), { key: 'BXYZ', configured: true });
  assert.strictEqual((await k.istek('/api/bildirim/abone', { cerez: c, json: { subscription: { ...sub, endpoint: 'http://x.test/a' } } })).kod, 400, 'https olmayan uç reddedilir');
  for (const e of ['https://192.0.2.5/a', 'https://ornek.test/push', 'https://web.push.apple.com.kotu.test/a', 'https://web.push.apple.com:8443/a']) {
    assert.strictEqual((await k.istek('/api/bildirim/abone', { cerez: c, json: { subscription: { ...sub, endpoint: e } } })).kod, 400, `push servisi olmayan uç reddedilir: ${e}`);
  }
  assert.strictEqual((await k.istek('/api/bildirim/abone', { cerez: c, json: { subscription: { endpoint: sub.endpoint, keys: {} } } })).kod, 400);
  for (const keys of [{ p256dh: 'p'.repeat(20), auth: sub.keys.auth }, { p256dh: sub.keys.p256dh, auth: 'a/b+c' }, { p256dh: sub.keys.p256dh, auth: Buffer.alloc(8).toString('base64url') }]) {
    assert.strictEqual((await k.istek('/api/bildirim/abone', { cerez: c, json: { subscription: { endpoint: sub.endpoint, keys } } })).kod, 400, 'biçimi bozuk anahtar');
  }
  const r = await k.istek('/api/bildirim/abone', { cerez: c, json: { subscription: sub } });
  assert.strictEqual(r.kod, 200);
  assert.strictEqual(JSON.parse(r.govde).deneme, 'ok');
  assert.deepStrictEqual(denenen, [sub.endpoint]);
  assert.deepStrictEqual(JSON.parse((await k.istek('/api/bildirim/durum?endpoint=' + encodeURIComponent(sub.endpoint), { cerez: c })).govde), { abone: true });
  assert.strictEqual((await k.istek('/api/bildirim/birak', { cerez: c, json: { endpoint: sub.endpoint } })).kod, 200);
  assert.strictEqual(kayit.size, 0);
  const sw = await k.istek('/kumanda-sw.js');
  assert.strictEqual(sw.kod, 200);
  assert.match(sw.basliklar['content-type'], /javascript/);
  assert.match(sw.govde, /addEventListener\('push'/);
  assert.doesNotMatch(sw.govde, /addEventListener\('fetch'/, 'kumanda servis çalışanı önbelleğe almaz');
});

test('abonelik yazılamazsa geçit düşmez: 500 JSON + günlük', async (t) => {
  const yazilamaz = () => { const e = new Error('EACCES: izin yok'); e.code = 'EACCES'; throw e; };
  const k = await kur(t, { bildirimler: { anahtar: () => 'B', ekle: yazilamaz, sil: yazilamaz, varMi: () => false, dene: async () => 'ok' } });
  const c = await girisYap(k);
  const r = await k.istek('/api/bildirim/abone', { cerez: c, json: { subscription: ornekAbonelik() } });
  assert.strictEqual(r.kod, 500);
  assert.deepStrictEqual(JSON.parse(r.govde), { error: 'abonelik kaydedilemedi' });
  assert.strictEqual((await k.istek('/api/bildirim/birak', { cerez: c, json: { endpoint: ornekAbonelik().endpoint } })).kod, 500);
  assert.ok(k.gunluk.some((m) => /abonelik kaydedilemedi: EACCES/.test(m)));
  assert.strictEqual((await k.istek('/api/bildirim/anahtar', { cerez: c })).kod, 200, 'süreç ayakta');
});

test('bildirim altyapısı verilmediyse uçlar 503', async (t) => {
  const k = await kur(t);
  const c = await girisYap(k);
  assert.strictEqual((await k.istek('/api/bildirim/anahtar', { cerez: c })).kod, 503);
});
