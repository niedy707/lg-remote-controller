'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const sunucu = require('./sunucu.cjs');

const AYAR = { kanallar: { favoriler: ['Kanal A'], diger: [], logolar: {} } };
const sahteBildirim = { anahtar: () => '', ekle() {}, sil() {}, varMi: () => false, dene: async () => 'not-configured', herkese: async () => ({ gonderilen: 0 }) };

async function kur(t, ek = {}) {
  const app = sunucu.uygulama({
    ayar: AYAR, bildirim: sahteBildirim, log: () => {},
    kumandaSecenek: { sifre: 'ornek-kalici-sifre', imzaAnahtari: 'z'.repeat(64), log: () => {}, hataGecikmesiMs: 0, ...(ek.kumanda || {}) },
    tvSecenek: { url: '', token: '', log: () => {} },
  });
  const s = http.createServer(app);
  await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => s.close(ok)));
  const port = s.address().port;
  const istek = (yol, { method = 'GET', basliklar = {}, govde = null } = {}) => new Promise((ok, red) => {
    const r = http.request({ host: '127.0.0.1', port, path: yol, method, headers: { ...basliklar, ...(govde != null ? { 'Content-Length': Buffer.byteLength(govde) } : {}) } }, (y) => {
      let v = '';
      y.on('data', (p) => { v += p; });
      y.on('end', () => ok({ kod: y.statusCode, basliklar: y.headers, govde: v }));
    });
    r.on('error', red);
    if (govde != null) r.write(govde);
    r.end();
  });
  return { istek };
}

test('güvenlik başlıkları: çerçeveleme yok, referrer yok, CSP alt kümesi, HSTS (Secure çerezle)', async (t) => {
  const k = await kur(t);
  const r = await k.istek('/login');
  assert.strictEqual(r.basliklar['x-frame-options'], 'DENY');
  assert.strictEqual(r.basliklar['referrer-policy'], 'no-referrer');
  assert.strictEqual(r.basliklar['x-content-type-options'], 'nosniff');
  assert.match(r.basliklar['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(r.basliklar['content-security-policy'], /form-action 'self'/);
  assert.match(r.basliklar['strict-transport-security'], /max-age=\d+/);
  assert.strictEqual(r.basliklar['x-powered-by'], undefined);
  const duz = await kur(t, { kumanda: { guvenliCerez: false } });
  assert.strictEqual((await duz.istek('/login')).basliklar['strict-transport-security'], undefined, 'düz HTTP denemesinde HSTS yok');
});

test('hata işleyici: girişsiz istemciye yığın izi ve kurulum yolu gitmez', async (t) => {
  const k = await kur(t);
  const durumlar = [
    [{ 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Encoding': 'xyz' }, 'password=a', 415],
    [{ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-99' }, 'password=a', 415],
    [{ 'Content-Type': 'application/x-www-form-urlencoded' }, `password=${'a'.repeat(10000)}`, 413],
  ];
  for (const [basliklar, govde, kod] of durumlar) {
    const r = await k.istek('/login', { method: 'POST', basliklar, govde });
    assert.strictEqual(r.kod, kod, JSON.stringify(basliklar));
    assert.doesNotMatch(r.govde, /node_modules|at |Error|\//, 'yığın izi / yol yok');
  }
});

test('hata işleyici: API isteğinde JSON hata (bozuk JSON gövde)', async (t) => {
  const k = await kur(t);
  // Girişli olmak için çerez: giriş formu.
  const giris = await k.istek('/login', { method: 'POST', basliklar: { 'Content-Type': 'application/x-www-form-urlencoded' }, govde: 'password=ornek-kalici-sifre' });
  const cerez = giris.basliklar['set-cookie'][0].split(';')[0];
  const r = await k.istek('/api/tv/tus', { method: 'POST', basliklar: { Cookie: cerez, 'Content-Type': 'application/json' }, govde: '{bozuk' });
  assert.strictEqual(r.kod, 400);
  assert.deepStrictEqual(JSON.parse(r.govde), { error: 'geçersiz istek' });
});

test('istemci IP: vekil kapalıyken başlıklar yok sayılır; açıkken yalnız vekilin yazdığı değer', () => {
  const istek = (uzak, basliklar = {}) => ({ socket: { remoteAddress: uzak }, headers: basliklar });
  const eski = process.env.KUMANDA_PROXY;
  try {
    delete process.env.KUMANDA_PROXY;
    assert.strictEqual(sunucu.istemciIp(istek('203.0.113.7', { 'x-real-ip': '198.51.100.1' })), '203.0.113.7');
    process.env.KUMANDA_PROXY = '1';
    assert.strictEqual(sunucu.istemciIp(istek('127.0.0.1', { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '192.0.2.9' })), '198.51.100.1', 'X-Real-IP önce');
    assert.strictEqual(sunucu.istemciIp(istek('127.0.0.1', { 'x-forwarded-for': '192.0.2.9, 198.51.100.2' })), '198.51.100.2', "XFF'nin SON öğesi (istemcinin yazdığı ilk öğe değil)");
    assert.strictEqual(sunucu.istemciIp(istek('::1')), '::1', 'başlık yoksa bağlantı adresi');
    assert.strictEqual(sunucu.istemciIp(istek('203.0.113.7', { 'x-real-ip': '198.51.100.1' })), '203.0.113.7', 'loopback dışından gelen başlığa güvenilmez');
  } finally {
    if (eski === undefined) delete process.env.KUMANDA_PROXY; else process.env.KUMANDA_PROXY = eski;
  }
});
