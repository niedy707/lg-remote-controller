'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const push = require('./push.cjs');

const gecici = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const abonelik = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/ornek-${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

/** Sahte web-push: uç noktaya göre sonuç döner, çağrıları kaydeder. */
function sahteWebpush(sonuc = () => null) {
  const cagrilar = [];
  return {
    cagrilar,
    sendNotification: async (sub, govde, secenek) => {
      cagrilar.push({ endpoint: sub.endpoint, govde: JSON.parse(govde), secenek });
      const kod = sonuc(sub.endpoint);
      if (kod) { const e = new Error(`HTTP ${kod}`); e.statusCode = kod; throw e; }
      return { statusCode: 201 };
    },
  };
}
const kur = (t, ek = {}) => {
  const gunluk = [];
  const dosya = path.join(gecici(t), 'abonelikler.json');
  const p = push.olustur({ dosya, publicKey: 'PUB', privateKey: 'PRIV', log: (m) => gunluk.push(m), ...ek });
  return { p, dosya, gunluk };
};

test('anahtar yoksa bildirim kapalı: herkese hiçbir şey göndermez, deneme "not-configured"', async (t) => {
  const wp = sahteWebpush();
  const p = push.olustur({ dosya: path.join(gecici(t), 'a.json'), publicKey: '', privateKey: '', webpush: wp });
  assert.strictEqual(p.anahtar(), '');
  assert.deepStrictEqual(await p.herkese('b', 'm'), { gonderilen: 0 });
  assert.strictEqual(await p.dene('x'), 'not-configured');
  assert.strictEqual(wp.cagrilar.length, 0);
});

test('ekle / varMi / sil; dosya 600 izinle yazılır; aynı uç ikinci kez eklenmez', (t) => {
  const { p, dosya } = kur(t, { webpush: sahteWebpush() });
  p.ekle(abonelik(1));
  p.ekle(abonelik(1));
  p.ekle(abonelik(2));
  assert.strictEqual(JSON.parse(fs.readFileSync(dosya, 'utf8')).length, 2);
  assert.strictEqual(fs.statSync(dosya).mode & 0o777, 0o600);
  assert.ok(p.varMi(abonelik(1).endpoint));
  p.sil(abonelik(1).endpoint);
  assert.ok(!p.varMi(abonelik(1).endpoint));
  assert.ok(p.varMi(abonelik(2).endpoint));
});

test('abonelik sayısı sınırlı: dolunca en eskisi düşer', (t) => {
  const { p, dosya } = kur(t, { webpush: sahteWebpush(), enCok: 3 });
  for (let i = 1; i <= 5; i++) p.ekle(abonelik(i));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(dosya, 'utf8')).map((x) => x.endpoint), [3, 4, 5].map((i) => abonelik(i).endpoint));
});

test('gönderim: 404/410 aboneliği siler, 403 ve diğer hatalar silmez; zaman aşımı push servisine verilir', async (t) => {
  const kodlar = { 1: null, 2: 404, 3: 410, 4: 403, 5: 500 };
  const wp = sahteWebpush((e) => kodlar[e.split('-').pop()]);
  const { p, gunluk } = kur(t, { webpush: wp, zamanAsimiMs: 1234 });
  for (let i = 1; i <= 5; i++) p.ekle(abonelik(i));
  const r = await p.herkese('Başlık', 'Mesaj', 'etiket');
  assert.deepStrictEqual(r, { gonderilen: 1 });
  assert.deepStrictEqual(wp.cagrilar[0].govde, { title: 'Başlık', body: 'Mesaj', tag: 'etiket' });
  assert.ok(wp.cagrilar.every((c) => c.secenek.timeout === 1234 && c.secenek.TTL === 3600), 'her gönderimde zaman aşımı');
  assert.ok(p.varMi(abonelik(1).endpoint));
  assert.ok(!p.varMi(abonelik(2).endpoint), '404 silindi');
  assert.ok(!p.varMi(abonelik(3).endpoint), '410 silindi');
  assert.ok(p.varMi(abonelik(4).endpoint), '403 silinmedi');
  assert.ok(p.varMi(abonelik(5).endpoint), '500 silinmedi');
  assert.ok(gunluk.some((m) => /403/.test(m) && /silinmedi/.test(m)));
});

test('deneme bildirimi yalnız o aboneliğe gider', async (t) => {
  const wp = sahteWebpush();
  const { p } = kur(t, { webpush: wp });
  p.ekle(abonelik(1));
  p.ekle(abonelik(2));
  assert.strictEqual(await p.dene(abonelik(2).endpoint), 'ok');
  assert.strictEqual(await p.dene('https://fcm.googleapis.com/yok'), 'yok');
  assert.deepStrictEqual(wp.cagrilar.map((c) => c.endpoint), [abonelik(2).endpoint]);
});

test('bozuk abonelik dosyası sessizce sıfırlanmaz: kenara alınır, günlüğe yazılır, sonra yeni kayıt eklenir', (t) => {
  const { p, dosya, gunluk } = kur(t, { webpush: sahteWebpush(), simdi: () => 42 });
  fs.writeFileSync(dosya, '[{"endpoint": "yarım');
  assert.strictEqual(p.varMi('x'), false);
  assert.ok(fs.existsSync(`${dosya}.bozuk-42`), 'bozuk dosya saklandı');
  assert.strictEqual(fs.readFileSync(`${dosya}.bozuk-42`, 'utf8'), '[{"endpoint": "yarım');
  assert.ok(gunluk.some((m) => /bozuk/.test(m)));
  p.ekle(abonelik(1));
  assert.ok(p.varMi(abonelik(1).endpoint));
});

test('yazılamayan veri dizini: ekle hata fırlatır (geçit bunu 500\'e çevirir), süreç düşmez', (t) => {
  const d = gecici(t);
  const dosyaDegilDizin = path.join(d, 'duz-dosya');
  fs.writeFileSync(dosyaDegilDizin, 'x');
  const p = push.olustur({ dosya: path.join(dosyaDegilDizin, 'abonelikler.json'), publicKey: 'PUB', privateKey: 'PRIV', webpush: sahteWebpush(), log: () => {} });
  assert.throws(() => p.ekle(abonelik(1)));
});

test('veri dizini KUMANDA_VERI\'den', () => {
  const eski = process.env.KUMANDA_VERI;
  process.env.KUMANDA_VERI = '/var/lib/ornek-kumanda';
  try { assert.strictEqual(push.veriDizini(), '/var/lib/ornek-kumanda'); } finally {
    if (eski === undefined) delete process.env.KUMANDA_VERI; else process.env.KUMANDA_VERI = eski;
  }
});
