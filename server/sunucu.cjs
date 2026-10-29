'use strict';
// ── LG Remote Controller — internet geçidi (isteğe bağlı) ──
//
// Telefon bu sunucuya bağlanır; sunucu girişi denetler ve istekleri evdeki ajana (agent/tv-ajan.mjs)
// belirteçle iletir. Ajan ev ağında kalır, internete açılmaz. Yalnız ev ağında kullanacaksan da bu
// sunucuyu evde çalıştırabilirsin (TV_AJAN_URL = ajanın yerel adresi).
//
// Ortam değişkenleri (bkz. README):
//   TV_AJAN_URL, TV_AJAN_TOKEN                ajanın adresi ve belirteci (ajandaki ile aynı)
//   KUMANDA_PASSWORD, KUMANDA_SESSION_SECRET  giriş (zorunlu), KUMANDA_SESSION_PASSWORD (isteğe bağlı)
//   KUMANDA_COOKIE_SECURE=false               yalnız HTTPS olmadan denerken
//   KUMANDA_PROXY=1                           nginx gibi bir ters vekil arkasında (istemci IP'si X-Real-IP'den)
//   KUMANDA_TZ                                arayüzün saat dilimi (varsayılan Europe/Istanbul; ajandaki TV_AJAN_TZ ile aynı)
//   KUMANDA_VERI                              veri dizini: abonelikler + kanal logoları (varsayılan data/)
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT   bildirimler (isteğe bağlı)
//   KUMANDA_AYAR                              ayar dosyası (varsayılan config.json, yoksa config.example.json)
//   PORT (varsayılan 3060), HOST (varsayılan 127.0.0.1)

const fs = require('fs');
const path = require('path');
const express = require('express');
const kumanda = require('./kumanda.cjs');
const tvKumanda = require('./tvKumanda.cjs');
const push = require('./push.cjs');

const KOK = path.join(__dirname, '..');

function ayarOku() {
  const aday = process.env.KUMANDA_AYAR || path.join(KOK, 'config.json');
  const dosya = fs.existsSync(aday) ? aday : path.join(KOK, 'config.example.json');
  if (dosya !== aday) console.log(`[sunucu] ${aday} yok — örnek ayar kullanılıyor (${dosya})`);
  return JSON.parse(fs.readFileSync(dosya, 'utf8'));
}

/**
 * Ters vekil arkasındaysa gerçek istemci IP'si (kaba kuvvet kilidi IP başına çalışır). Yalnız bağlantı
 * loopback'ten geliyorsa ve KUMANDA_PROXY=1 ise başlıklara bakılır; o zaman da yalnız vekilin KENDİ yazdığı
 * değer: X-Real-IP (örnek nginx istemcinin gönderdiğinin üzerine yazar), yoksa X-Forwarded-For'un SON öğesi.
 * XFF'nin ilk öğesi istemcinin kendi yazdığıdır — ona güvenilseydi IP kilidi atlatılır, başkasının IP'si kilitlenirdi.
 */
function istemciIp(req) {
  const uzak = req.socket.remoteAddress || '';
  if (process.env.KUMANDA_PROXY === '1' && /^(127\.|::1$|::ffff:127\.)/.test(uzak)) {
    const gercek = String(req.headers['x-real-ip'] || '').trim();
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    return gercek || xff[xff.length - 1] || uzak;
  }
  return uzak;
}

function uygulama({ ayar = ayarOku(), bildirim = push.olustur(), kumandaSecenek = {}, tvSecenek = {}, log = console.log } = {}) {
  const app = express();
  app.disable('x-powered-by');
  const guvenli = (kumandaSecenek.guvenliCerez ?? process.env.KUMANDA_COOKIE_SECURE !== 'false');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      // no-referrer: tarayıcı kendi sayfamızdan giden POST'ta Origin'i "null" yazar — kumanda.cjs bunu bilir.
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      // Bozmayan CSP alt kümesi (giriş sayfasında satır içi betik var; script-src kısıtı ayrı iş).
      'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
      ...(guvenli ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });
  app.use(kumanda.olustur({
    tvRouter: tvKumanda.olustur({ kanallar: ayar.kanallar, ...tvSecenek }),
    istemciIp,
    bildir: (baslik, mesaj) => bildirim.herkese(`🔐 ${baslik}`, mesaj, 'kumanda-kilit'),
    bildirimler: bildirim,
    ...kumandaSecenek,
  }));
  // Son hata işleyici: Express'in geliştirme sayfası (yığın izi + kurulum yolu) istemciye gitmesin.
  // Gövde ayrıştırıcı hataları (bozuk JSON, büyük gövde, bilinmeyen Content-Encoding) girişsiz de tetiklenebilir.
  app.use((err, req, res, next) => {
    const kod = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (kod >= 500) log(`[sunucu] hata: ${err.stack || err.message}`);
    if (res.headersSent) return next(err);
    const metin = kod === 413 ? 'çok büyük istek' : kod < 500 ? 'geçersiz istek' : 'sunucu hatası';
    return req.originalUrl.startsWith('/api/') ? res.status(kod).json({ error: metin }) : res.status(kod).type('text').send(metin);
  });
  return app;
}

if (require.main === module) {
  const bildirim = push.olustur();
  const app = uygulama({ bildirim });
  // Zamanlanmış görevlerin sonucu (reklam bitti, yayın başladı, yapılamadı), engel ve kilit olayları → bildirim.
  tvKumanda.sonucIzleyici({ bildir: (baslik, mesaj, _konu, tag) => bildirim.herkese(baslik, mesaj, tag || 'tv') });
  const PORT = Number(process.env.PORT || 3060);
  const HOST = process.env.HOST || '127.0.0.1';
  app.listen(PORT, HOST, () => console.log(`[sunucu] LG Remote → http://${HOST}:${PORT}`));
}

module.exports = { uygulama, istemciIp };
