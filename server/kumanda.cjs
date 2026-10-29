'use strict';
// ── Kumandanın kapısı: giriş, oturum çerezi, kaba kuvvet kilidi, sayfalar, statik dosyalar, bildirim aboneliği ──
//
// Ortam değişkenleri:
//   KUMANDA_PASSWORD          kalıcı şifre — bir kez girilir; cihaz kullandıkça hatırlanır (kayan ~400 gün)
//   KUMANDA_SESSION_PASSWORD  tek oturumluk şifre — tarayıcı kapanınca düşer (isteğe bağlı; misafir için)
//   KUMANDA_SESSION_SECRET    çerez imza anahtarı (en az 32 karakter) — SABİT olmalı, değişirse girişler düşer
//   KUMANDA_OTURUM_NESLI      isteğe bağlı sayaç: değiştirilince bütün girişler düşer ("her cihazdan çık")
//   KUMANDA_COOKIE_SECURE     varsayılan açık (Secure çerez, HTTPS arkasında); yalnız düz HTTP denemede "false"
//   KUMANDA_TZ                arayüzün saat dilimi (IANA adı, varsayılan Europe/Istanbul) — ajandaki TV_AJAN_TZ ile aynı olmalı
//   KUMANDA_VERI              veri dizini (abonelikler, kanal logoları); yoksa deponun data/ klasörü
//
// Oturum durumsuzdur: çerez = "tür:veriliş:bitiş" + HMAC imza. İmzanın anahtarı o türün şifresinden türetilir:
// şifre değişince o türün bütün eski çerezleri geçersiz olur (kaybolan telefon / geri alınan misafir şifresi).
// Sunucu yeniden başlasa da giriş korunur. Çıkış yalnız o tarayıcının çerezini siler.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE_NAME = 'kumanda_session';
// Tarayıcılar çerez ömrünü en çok 400 güne kırpar (RFC 6265bis): kalıcı giriş kullanıldıkça yenilenir.
const MASTER_TTL = 400 * 24 * 60 * 60;          // saniye
const YENILE_MS = 30 * 24 * 60 * 60 * 1000;     // kalıcı çerez bundan eskiyse yenisi verilir
const SESSION_TTL = 12 * 60 * 60;
// ── Kaba kuvvete karşı ──
//   • IP başına 5 hatalı deneme → o IP 1 saat bekler.
//   • Tüm adreslerden 1 saatte 20 hatalı deneme → yeni giriş herkese 1 saat kapanır (çok adresten
//     deneyeni IP sınırı durdurmaz). Girişli cihazlar (çerezli) etkilenmez.
//   • 24 saatte toplam 60 hatalı deneme → yeni giriş herkese 24 saat kapanır: eşiklerin hemen altında kalan
//     yavaş tarama (saatte 19 deneme, adres başına 4) da durur.
//   • 24 saatte her 10 hatalı denemede bildirim — hiçbir kilit tetiklenmese de sahibi haberdar olur.
//   • Her hatalı denemede 1 sn gecikme; başka siteden gelen POST reddedilir.
//   • Bildirimler konu başına 15 dk'da en çok bir (IP kilidi genel kilidin bildirimini yutmaz).
// Kısa şifre (ör. birkaç haneli PIN) bu sınırlarla bile aylar içinde taranabilir: internete açık kurulumda
// en az 10 karakter kullanın — daha kısaysa başlangıçta uyarı yazılır.
const LOGIN_MAX_FAILS = 5;
const KILIT_MS = 60 * 60 * 1000;
const GENEL_MAX_FAILS = 20;
const GENEL_WINDOW_MS = 60 * 60 * 1000;
const GUNLUK_MAX_FAILS = 60;
const GUN_MS = 24 * 60 * 60 * 1000;
const OZET_ESIGI = 10;
const BILDIRIM_ARALIK_MS = 15 * 60 * 1000;
const KISA_SIFRE = 10;
const VARSAYILAN_TZ = 'Europe/Istanbul';

const WEB = path.join(__dirname, '..', 'web');
const veriDizini = () => process.env.KUMANDA_VERI || path.join(__dirname, '..', 'data');

/** Sunulan statik dosyalar — gerisi 404 (açık liste: dizin gezintisi yok). */
const STATIK = {
  '/styles.css': path.join(WEB, 'styles.css'),
  '/app.js': path.join(WEB, 'app.js'),
  '/i18n.js': path.join(WEB, 'i18n.js'),
  '/saat.js': path.join(WEB, 'saat.js'),
  '/izleme.js': path.join(WEB, 'izleme.js'),
  '/engel.js': path.join(WEB, 'engel.js'),
  '/manifest.json': path.join(WEB, 'manifest.json'),
  '/icons/icon-192.png': path.join(WEB, 'icons', 'icon-192.png'),
  '/icons/icon-512.png': path.join(WEB, 'icons', 'icon-512.png'),
  '/icons/apple-touch-icon.png': path.join(WEB, 'icons', 'apple-touch-icon.png'),
  '/favicon.ico': path.join(WEB, 'icons', 'icon-192.png'),
  // Yalnız bildirim gösterir, önbelleğe almaz (kumanda her açılışta sunucudan güncel yüklenir).
  '/kumanda-sw.js': path.join(WEB, 'sw.js'),
};

const html = (ad) => () => fs.readFileSync(path.join(WEB, ad), 'utf8');
const kumandaSayfasi = html('index.html');
const girisSayfasi = html('login.html');
const izlemeSayfasi = html('izleme.html');
const engelSayfasi = html('engel.html');

/** Geçerli IANA saat dilimi mi (Intl kabul ediyor mu). */
function saatDilimiGecerli(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function olustur({
  sifre = process.env.KUMANDA_PASSWORD,
  oturumSifresi = process.env.KUMANDA_SESSION_PASSWORD,
  imzaAnahtari = process.env.KUMANDA_SESSION_SECRET,
  oturumNesli = process.env.KUMANDA_OTURUM_NESLI || '0',
  // İnternete açık kurulum HTTPS arkasında olmalı: çerez varsayılan olarak Secure. Kapatmak: KUMANDA_COOKIE_SECURE=false.
  guvenliCerez = process.env.KUMANDA_COOKIE_SECURE !== 'false',
  saatDilimi = process.env.KUMANDA_TZ,
  tvRouter,
  istemciIp = (req) => req.socket.remoteAddress,
  log = console.log,
  bildir = null,            // (baslik, mesaj) → telefona bildirim; yoksa yalnız günlük
  // Bildirim aboneliği (👋🏻 → Bildirimler): { anahtar(), ekle(sub), sil(endpoint), varMi(endpoint),
  // dene(endpoint) } — bkz. push.cjs. Yoksa /api/bildirim/* 503.
  bildirimler = null,
  logoDizini = path.join(veriDizini(), 'logolar'),
  hataGecikmesiMs = 1000,   // testler 0 verir
  simdi = Date.now,         // testler zamanı ileri sarar
} = {}) {
  if (!tvRouter) throw new Error('kumanda: tvRouter gerekli');
  // Zayıf anahtarla imzalanmış çerez, hız sınırı olmayan çerez denetiminde tahminle üretilebilirdi.
  if (imzaAnahtari && String(imzaAnahtari).length < 32) throw new Error('KUMANDA_SESSION_SECRET en az 32 karakter olmalı (openssl rand -hex 32)');
  // Anahtar yoksa rastgele: güvenli taraf (kimse sahte çerez üretemez) ama her yeniden başlatmada
  // kalıcı girişler düşer — günlüğe yazılır ki "neden hep şifre soruyor" sorusunun cevabı orada olsun.
  const ANAHTAR = imzaAnahtari || crypto.randomBytes(32).toString('hex');
  if (!imzaAnahtari) log('[KUMANDA] KUMANDA_SESSION_SECRET yok — rastgele üretildi; yeniden başlatmada girişler düşer');
  if (!sifre) log('[KUMANDA] KUMANDA_PASSWORD yok — kimse giriş yapamaz');
  else if (String(sifre).length < KISA_SIFRE) log(`[KUMANDA] ⚠️ KUMANDA_PASSWORD ${KISA_SIFRE} karakterden kısa — internete açıkken kaba kuvvetle bulunabilir; daha uzun bir şifre kullanın`);
  const TZ = saatDilimi == null || saatDilimi === '' ? VARSAYILAN_TZ : String(saatDilimi);
  const saatDilimiSon = saatDilimiGecerli(TZ) ? TZ : VARSAYILAN_TZ;
  if (saatDilimiSon !== TZ) log(`[KUMANDA] KUMANDA_TZ geçersiz ("${TZ}") — ${VARSAYILAN_TZ} kullanılıyor`);

  // İmza anahtarı türe ve o türün şifresine bağlı: şifre değişince eski çerezler düşer.
  const ozet = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');
  const turAnahtari = {
    master: crypto.createHmac('sha256', ANAHTAR).update(`${oturumNesli}:master:${ozet(sifre)}`).digest(),
    session: crypto.createHmac('sha256', ANAHTAR).update(`${oturumNesli}:session:${ozet(oturumSifresi)}`).digest(),
  };
  const mac = (yuk) => {
    const k = Object.prototype.hasOwnProperty.call(turAnahtari, yuk.split(':')[0]) ? turAnahtari[yuk.split(':')[0]] : null;
    return k ? crypto.createHmac('sha256', k).update(yuk).digest('hex') : null;
  };
  const imzala = (yuk) => `${yuk}.${mac(yuk)}`;
  function dogrula(token) {
    if (!token || typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i <= 0) return null;
    const yuk = token.slice(0, i);
    const beklenen = mac(yuk);
    if (!beklenen) return null;
    const a = Buffer.from(token.slice(i + 1));
    const b = Buffer.from(beklenen);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const [tip, verilis, bitis] = yuk.split(':');
    if (!bitis || !(Number(bitis) > simdi())) return null;
    return { tip, verilis: Number(verilis), bitis: Number(bitis) };
  }
  function cerez(req) {
    for (const p of String(req.headers.cookie || '').split(';')) {
      const i = p.indexOf('=');
      if (i !== -1 && p.slice(0, i).trim() === COOKIE_NAME) {
        const v = p.slice(i + 1).trim();
        try { return decodeURIComponent(v); } catch { return v; }
      }
    }
    return null;
  }
  const cerezSecenek = () => ({ httpOnly: true, sameSite: 'lax', secure: guvenliCerez, path: '/' });
  function cerezVer(res, tip) {
    const t = simdi();
    const ttl = tip === 'master' ? MASTER_TTL : SESSION_TTL;
    const ops = cerezSecenek();
    if (tip === 'master') ops.maxAge = ttl * 1000; // tek oturumluk: maxAge yok → tarayıcı kapanınca silinir
    res.cookie(COOKIE_NAME, imzala(`${tip}:${t}:${t + ttl * 1000}`), ops);
  }
  const esit = (a, b) => {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
    return crypto.timingSafeEqual(ab, bb);
  };

  // Bildirim kısıtlaması konu başına: aynı konuda 15 dk'da en çok bir bildirim; farklı konular birbirini yutmaz.
  const sonBildirim = new Map();
  const uyar = (konu, baslik, mesaj) => {
    log(`[KUMANDA] ⚠️ ${baslik} — ${mesaj}`);
    const t = simdi();
    if (!bildir || t - (sonBildirim.get(konu) || -Infinity) < BILDIRIM_ARALIK_MS) return;
    sonBildirim.set(konu, t);
    Promise.resolve().then(() => bildir(baslik, mesaj)).catch((e) => log(`[KUMANDA] bildirim gönderilemedi: ${e.message}`));
  };
  const saat = (ms) => new Date(ms).toLocaleTimeString('tr-TR', { timeZone: saatDilimiSon, hour: '2-digit', minute: '2-digit' });

  const hatalar = new Map(); // ip -> { sayi, sifirlanma }
  const kilitli = (ip) => {
    const e = hatalar.get(ip);
    if (!e) return false;
    if (simdi() > e.sifirlanma) { hatalar.delete(ip); return false; }
    return e.sayi >= LOGIN_MAX_FAILS;
  };
  const genel = { sayi: 0, pencere: 0, kilitBitis: 0 };
  const gunluk = { sayi: 0, pencere: 0 };
  const genelKilitli = () => simdi() < genel.kilitBitis;
  const hataYaz = (ip) => {
    const t = simdi();
    const e = hatalar.get(ip);
    if (!e || t > e.sifirlanma) hatalar.set(ip, { sayi: 1, sifirlanma: t + KILIT_MS });
    else if (++e.sayi === LOGIN_MAX_FAILS) {
      e.sifirlanma = t + KILIT_MS;   // 5. hatadan itibaren tam 1 saat
      uyar('ip', 'Kumanda: giriş denemesi kilitlendi', `${ip} adresinden ${LOGIN_MAX_FAILS} hatalı şifre — bu adres ${saat(e.sifirlanma)}'e kadar bekleyecek.`);
    }
    if (t > genel.pencere) { genel.sayi = 0; genel.pencere = t + GENEL_WINDOW_MS; }
    if (++genel.sayi === GENEL_MAX_FAILS) {
      genel.kilitBitis = Math.max(genel.kilitBitis, t + KILIT_MS);
      uyar('genel', 'Kumanda: GENEL GİRİŞ KİLİDİ', `1 saatte ${GENEL_MAX_FAILS} hatalı şifre (birden çok adres) — yeni girişler ${saat(genel.kilitBitis)}'e kadar kapalı. Girişli cihazlar etkilenmez.`);
    }
    if (t > gunluk.pencere) { gunluk.sayi = 0; gunluk.pencere = t + GUN_MS; }
    if (++gunluk.sayi === GUNLUK_MAX_FAILS) {
      genel.kilitBitis = Math.max(genel.kilitBitis, t + GUN_MS);
      uyar('gunluk', 'Kumanda: GÜNLÜK GİRİŞ KİLİDİ', `24 saatte ${GUNLUK_MAX_FAILS} hatalı şifre — yeni girişler 24 saat (${saat(genel.kilitBitis)}'e kadar) kapalı. Girişli cihazlar etkilenmez.`);
    } else if (gunluk.sayi % OZET_ESIGI === 0) {
      uyar('ozet', 'Kumanda: şüpheli giriş denemeleri', `24 saatte ${gunluk.sayi} hatalı şifre.`);
    }
  };

  function girisGerekli(req, res, next) {
    const o = dogrula(cerez(req));
    if (o) {
      // Kayan süre: kalıcı giriş 30 günden eskiyse yenilenir — tarayıcının 400 gün sınırına takılmasın.
      if (o.tip === 'master' && simdi() - o.verilis > YENILE_MS) cerezVer(res, 'master');
      return next();
    }
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Giriş yapılmamış' });
    return res.redirect('/login');
  }

  const r = express.Router();
  r.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  // Başka siteden gelen yazma isteği (form, fetch) reddedilir. SameSite=Lax çerezi zaten taşımaz;
  // bu ikinci kat — tarayıcının gönderdiği Sec-Fetch-Site / Origin başlıklarına bakar.
  // ⚠️ `Origin: null` YABANCI DEMEK DEĞİL: sunucu `Referrer-Policy: no-referrer` gönderiyor ve bu
  // politikada tarayıcı kendi sayfamızdan giden POST'ta bile Origin'i "null" yazıyor (Fetch standardı,
  // "serializing a request origin"). Bunu reddetmek giriş formunu "Yasak"a düşürür. Karar Sec-Fetch-Site'a;
  // Origin yalnız gerçek bir adresse karşılaştırılır.
  r.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    let yabanci = site === 'cross-site' || site === 'same-site';
    if (origin && origin !== 'null') {
      try { yabanci = yabanci || new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase(); } catch { yabanci = true; }
    }
    if (yabanci) { log(`[KUMANDA] başka siteden istek reddedildi · origin=${origin || '-'} · site=${site || '-'}`); return res.status(403).type('text').send('Yasak'); }
    next();
  });

  r.get('/login', (req, res) => {
    if (dogrula(cerez(req))) return res.redirect('/');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(girisSayfasi());
  });

  r.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const ip = istemciIp(req) || 'bilinmiyor';
    if (kilitli(ip) || genelKilitli()) return res.redirect('/login?error=lock');
    const pw = String((req.body && req.body.password) || '').trim();
    let tip = null;
    if (sifre && esit(pw, sifre)) tip = 'master';
    else if (oturumSifresi && esit(pw, oturumSifresi)) tip = 'session';
    if (!tip) {
      hataYaz(ip);
      log(`[KUMANDA] hatalı şifre · ip=${ip}`);
      // Yavaşlatma: betikle art arda denemeyi pahalılaştırır, insan için fark edilmez.
      return setTimeout(() => res.redirect(kilitli(ip) || genelKilitli() ? '/login?error=lock' : '/login?error=1'), hataGecikmesiMs);
    }
    hatalar.delete(ip);
    cerezVer(res, tip);
    log(`[KUMANDA] giriş (${tip}) · ip=${ip}`);
    res.redirect('/');
  });

  // Çıkış yalnız POST ile (CSRF katmanından geçer): GET olsaydı başka bir site kullanıcıyı /logout'a yönlendirip
  // girişini düşürebilirdi. Eski bağlantılar için GET kumandaya döner, çıkış yapmaz.
  r.post('/logout', (req, res) => {
    res.clearCookie(COOKIE_NAME, cerezSecenek());
    res.redirect(303, '/login');
  });
  r.get('/logout', (req, res) => res.redirect('/'));

  const sayfa = (oku) => (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(oku());
  };
  r.get('/', girisGerekli, sayfa(kumandaSayfasi));
  // İzleme ayrıntıları: hangi TV ne zaman açık, ne izlendi — gün / hafta / ay.
  r.get('/detail', girisGerekli, sayfa(izlemeSayfasi));
  // YouTube engelleri (kanal · kelime · video) ve TV kilidi.
  r.get('/engel', girisGerekli, sayfa(engelSayfasi));

  for (const [yol, dosya] of Object.entries(STATIK)) {
    r.get(yol, (req, res) => {
      if (yol === '/manifest.json') res.type('application/manifest+json');
      if (yol === '/kumanda-sw.js') res.set('Cache-Control', 'no-cache');   // güncellemesi gecikmesin
      res.sendFile(dosya);
    });
  }

  // Kanal logoları (config.json → kanallar.logolar); yalnız düz dosya adı. Logolar yayıncıların markası —
  // depoda yok, kurulumda logoDizini'ne konur (README).
  r.get('/logolar/:ad', (req, res) => {
    if (!/^[a-z0-9]{1,30}\.png$/.test(req.params.ad)) return res.status(404).type('text').send('Bulunamadı');
    res.sendFile(path.join(logoDizini, req.params.ad), (e) => { if (e && !res.headersSent) res.status(404).type('text').send('Bulunamadı'); });
  });

  // Arayüzün ayarları: saat dilimi (bütün sayfalar saatleri bu bölgenin duvar saatiyle gösterir).
  r.get('/api/ayar', girisGerekli, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ saatDilimi: saatDilimiSon });
  });

  r.use('/api/tv', girisGerekli, express.json({ limit: '10kb' }), tvRouter);

  // ── Bildirimler: planlı yayın başlayınca / reklam bitince telefona web push (düğme 👋🏻 içinde). ──
  const bil = express.Router();
  bil.use((req, res, next) => (bildirimler ? next() : res.status(503).json({ error: 'bildirim altyapısı yok' })));
  // Sunucu her bildirimde bu adrese istek atar: yalnız tarayıcıların gerçek push servisleri kabul
  // edilir (kumanda şifresi ev halkına verilebilir; keyfi https adresi sunucuyu istek aracı yapardı).
  const PUSH_SERVISI = /^(web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
  const endpointGecerli = (e) => {
    if (typeof e !== 'string' || e.length > 1000) return false;
    try { const u = new URL(e); return u.protocol === 'https:' && !u.port && PUSH_SERVISI.test(u.hostname); } catch { return false; }
  };
  // Abonelik anahtarları: p256dh = 65 baytlık P-256 açık anahtarı, auth = 16 bayt; base64url. Biçimi bozuk
  // anahtar web-push'ta ağa çıkmadan hata verir ve kayıt hiç silinmezdi.
  const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
  const bayt = (s) => Buffer.from(s, 'base64url').length;
  const anahtarGecerli = (k) => typeof k.p256dh === 'string' && typeof k.auth === 'string'
    && k.p256dh.length <= 200 && k.auth.length <= 100 && B64URL.test(k.p256dh) && B64URL.test(k.auth)
    && bayt(k.p256dh) === 65 && bayt(k.auth) === 16;
  bil.get('/anahtar', (req, res) => {
    const key = bildirimler.anahtar();
    res.json({ key: key || null, configured: !!key });
  });
  bil.get('/durum', (req, res) => {
    const e = String(req.query.endpoint || '');
    if (!endpointGecerli(e)) return res.status(400).json({ error: 'geçersiz abonelik' });
    try { res.json({ abone: !!bildirimler.varMi(e) }); } catch (h) { res.status(500).json({ error: 'abonelikler okunamadı' }); }
  });
  bil.post('/abone', async (req, res) => {
    const sub = req.body && req.body.subscription;
    if (!sub || !endpointGecerli(sub.endpoint)) return res.status(400).json({ error: 'geçersiz abonelik' });
    const k = sub.keys || {};
    if (!anahtarGecerli(k)) return res.status(400).json({ error: 'abonelik anahtarları eksik' });
    // Yazılamayan veri dizini (salt okunur kurulum, izin) geçidi düşürmesin: 500 JSON + günlük.
    try { bildirimler.ekle({ endpoint: sub.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } }); } catch (e) {
      log(`[KUMANDA] abonelik kaydedilemedi: ${e.code || e.message} — veri dizini yazılabilir mi (KUMANDA_VERI)?`);
      return res.status(500).json({ error: 'abonelik kaydedilemedi' });
    }
    log(`[KUMANDA] bildirim aboneliği açıldı · ${new URL(sub.endpoint).host}`);
    // "Açıldı" demeden önce gerçekten gidiyor mu: aynı cihaza bir deneme bildirimi.
    const deneme = await Promise.resolve().then(() => bildirimler.dene(sub.endpoint)).catch(() => 'hata');
    res.json({ ok: true, deneme });
  });
  bil.post('/birak', (req, res) => {
    const e = req.body && req.body.endpoint;
    if (!endpointGecerli(e)) return res.status(400).json({ error: 'geçersiz abonelik' });
    try { bildirimler.sil(e); } catch (h) {
      log(`[KUMANDA] abonelik silinemedi: ${h.code || h.message}`);
      return res.status(500).json({ error: 'abonelik silinemedi' });
    }
    log('[KUMANDA] bildirim aboneliği kapatıldı');
    res.json({ ok: true });
  });
  r.use('/api/bildirim', girisGerekli, express.json({ limit: '4kb' }), bil);

  // Başka hiçbir şey yok.
  r.use((req, res) => res.status(404).type('text').send('Bulunamadı'));
  return r;
}

module.exports = { olustur, COOKIE_NAME, kumandaSayfasi, girisSayfasi, izlemeSayfasi, engelSayfasi, saatDilimiGecerli };
