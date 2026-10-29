'use strict';
// Arayüz dosyalarının (web/) derleme gerektirmeyen denetimleri: saat dilimi yardımcısı, çeviri kapsamı ve
// yayın öncesi gizlilik taraması. Tarayıcı gerektirmez.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KOK = path.join(__dirname, '..');
const WEB = path.join(KOK, 'web');
const oku = (...p) => fs.readFileSync(path.join(KOK, ...p), 'utf8');

test('saat dilimi: duvar saati ↔ an, yaz saati geçişi, geçersiz bölge', () => {
  // saat.js tarayıcı betiği (paket "type": "module" olduğu için require edilemez): ayrı bağlamda çalıştırılır.
  const window = {};
  vm.runInNewContext(oku('web', 'saat.js'), { window, fetch: async () => ({ ok: false }) });
  const Saat = window.Saat;
  assert.strictEqual(Saat.bolge(), 'Europe/Istanbul', 'varsayılan');
  const an = Date.UTC(2026, 9, 18, 21, 5);   // 18.10.2026 21:05 UTC
  assert.strictEqual(Saat.saat(an), '00:05', 'İstanbul UTC+3');
  assert.strictEqual(Saat.gun(an), '2026-10-19');
  assert.strictEqual(Saat.yerelAn(2026, 10, 19, 0, 5), an);
  assert.strictEqual(Saat.gunBasi('2026-10-19'), Date.UTC(2026, 9, 18, 21, 0));
  assert.strictEqual(Saat.kur('Mars/Olympus'), false);
  assert.strictEqual(Saat.bolge(), 'Europe/Istanbul', 'geçersiz bölge eskisini bozmaz');
  assert.ok(Saat.kur('Europe/Berlin'));
  // 29.03.2026: Berlin'de saat 02:00'de 03:00'e atlar (UTC+1 → UTC+2).
  assert.strictEqual(Saat.gunBasi('2026-03-29'), Date.UTC(2026, 2, 28, 23, 0));
  assert.strictEqual(Saat.yerelAn(2026, 3, 29, 12, 0), Date.UTC(2026, 2, 29, 10, 0));
  assert.strictEqual(Saat.gunBasi('2026-03-30') - Saat.gunBasi('2026-03-29'), 23 * 3600e3, 'kısa gün');
  assert.strictEqual(Saat.saat(Date.UTC(2026, 9, 25, 0, 30)), '02:30');
  assert.strictEqual(Saat.saatNo(Date.UTC(2026, 9, 25, 1, 30)), 2, 'geri dönüşte 02 iki kez');
  assert.strictEqual(Saat.gunEkle('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(Saat.haftaGunu('2026-10-18'), 0, 'Pazar');
  assert.strictEqual(Saat.tarihYaz('2026-10-18', { day: 'numeric', month: 'long' }, 'en-GB'), '18 October');
  Saat.kur('Europe/Istanbul');
});

/** i18n.js'i tarayıcısız çalıştırır (Türkçe tarayıcı: sayfa çevirisi devreye girmez); bul() döner. */
function sozluk() {
  const window = {};
  const baglam = { window, navigator: { language: 'tr-TR' }, localStorage: { getItem: () => null, setItem() {} }, document: {}, location: {} };
  vm.runInNewContext(oku('web', 'i18n.js'), baglam);
  return window.i18n.bul;
}

/** JS dosyasındaki L('…') / L("…") / L(`…`) dize sabitleri (değişken içermeyenler). */
function lMetinleri(kaynak) {
  const sonuc = new Set();
  const kalip = /\bL\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`$\\]*)`)/g;
  for (const m of kaynak.matchAll(kalip)) {
    const ham = m[1] ?? m[2] ?? m[3];
    sonuc.add(ham.replace(/\\(.)/g, '$1'));
  }
  return sonuc;
}

// Çevrilmeyen (her dilde aynı) metinler: marka/uygulama adları, tuş etiketleri.
const CEVRILMEZ = new Set(['LG Remote', 'Türkçe', 'English', 'Apple TV', 'Netflix', 'Amazon Prime', 'Disney+', 'OK', 'TV', 'tv', 'N', 'prime', 'D+', 'Ch /', 'Vol', 'Exit', 'Apple TV (undetected)']);

test('çeviri: arayüz betiklerindeki her L() metninin İngilizcesi var', () => {
  const bul = sozluk();
  const eksik = [];
  for (const dosya of ['app.js', 'izleme.js', 'engel.js']) {
    for (const m of lMetinleri(oku('web', dosya))) if (bul(m) == null && !CEVRILMEZ.has(m)) eksik.push(`${dosya}: ${m}`);
  }
  assert.deepStrictEqual(eksik, [], 'web/i18n.js sözlüğüne eklenmeli');
});

test('çeviri: sayfalardaki metinlerin ve erişilebilirlik niteliklerinin İngilizcesi var', () => {
  const bul = sozluk();
  const eksik = [];
  for (const dosya of ['index.html', 'izleme.html', 'engel.html']) {
    const html = oku('web', dosya).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const metinler = [];
    for (const m of html.matchAll(/>([^<>]+)</g)) metinler.push(m[1]);
    for (const m of html.matchAll(/\s(?:aria-label|placeholder|title|alt)="([^"]+)"/g)) metinler.push(m[1]);
    const t = /<title>([^<]+)<\/title>/.exec(html);
    if (t) metinler.push(t[1]);
    for (const ham of metinler) {
      const m = ham.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();
      if (!/\p{L}/u.test(m) || CEVRILMEZ.has(m)) continue;
      if (bul(m) == null) eksik.push(`${dosya}: ${m}`);
    }
  }
  assert.deepStrictEqual(eksik, [], 'web/i18n.js sözlüğüne eklenmeli');
});

test('çeviri: geçidin istemciye giden sabit hata metinleri sözlükte', () => {
  const bul = sozluk();
  const metinler = new Set(['çok büyük istek', 'geçersiz istek', 'sunucu hatası']);   // sunucu.cjs hata işleyicisi
  for (const dosya of ['tvKumanda.cjs', 'kumanda.cjs']) {
    const k = fs.readFileSync(path.join(__dirname, dosya), 'utf8');
    for (const m of k.matchAll(/(?:error:\s*(?:j\.hata\s*\|\|\s*)?|hata\(res,\s*)'([^']+)'/g)) metinler.add(m[1]);
  }
  assert.ok(metinler.size > 30, 'kalıp metinleri buluyor');
  assert.deepStrictEqual([...metinler].filter((m) => bul(m) == null), []);
});

test('gizlilik: geçit, arayüz ve demo dosyalarında kişisel/kurulum izi yok (public depo)', () => {
  const dosyalar = [];
  const gez = (d) => {
    for (const ad of fs.readdirSync(d)) {
      const p = path.join(d, ad);
      if (fs.statSync(p).isDirectory()) { if (ad !== 'icons') gez(p); } else if (/\.(c?js|mjs|html|css|json)$/.test(ad)) dosyalar.push(p);
    }
  };
  gez(WEB);
  gez(__dirname);
  dosyalar.push(path.join(KOK, 'scripts', 'demo.mjs'), path.join(KOK, 'config.example.json'));
  const kurallar = [
    ['özel ağ IPv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/],
    ['MAC adresi', /\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i],
    ['tarihli not', /\b\d{1,2}\.\d{1,2}\.20\d{2}\b/],
    ['oda adı', /\bsalon\b|oturma odası|\boturma\b/i],
    ['üçüncü taraf IPTV uygulaması', /flex\s*iptv/i],
  ];
  const bulgular = [];
  for (const d of dosyalar) {
    if (d === __filename) continue;   // kalıpların kendisi burada
    const satirlar = fs.readFileSync(d, 'utf8').split('\n');
    satirlar.forEach((s, i) => { for (const [ad, k] of kurallar) if (k.test(s)) bulgular.push(`${path.relative(KOK, d)}:${i + 1} ${ad}: ${s.trim().slice(0, 90)}`); });
  }
  assert.deepStrictEqual(bulgular, []);
});
