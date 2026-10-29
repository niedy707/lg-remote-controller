'use strict';
// ── Geçit: telefon ile evdeki TV ajanı arasındaki dar yol ──
//
// VERİ YOLU: telefon ──HTTPS──► sunucu /api/tv/* ──(VPN/yerel ağ) + belirteç──► ajan ──wss──► LG TV
//
// NEDEN BÖYLE: LG TV'ler yalnız ev ağından konuşuyor (wss://<ip>:3001, özel sertifika). Ajan
// (agent/tv-ajan.mjs) ev ağında çalışır ve internete açık değildir; bu sunucu internete açık
// olabilir. Burası yalnız iletir: girişli kullanıcıdan gelen isteği DOĞRULAR (TV kimliği, izinli
// tuş, kanal biçimi) ve ajana belirteçle aktarır. Ajan da aynı denetimi ayrıca yapar — iki kat.
// Gövdeler süzülerek YENİDEN kurulur: ajana yalnız bilinen alanlar gider.
//
// Ortam: TV_AJAN_URL (ajanın adresi, örn. http://<ajan-ip>:3027) · TV_AJAN_TOKEN (ajandaki ile aynı).
// İkisi de yoksa uçlar 503 döner — "kurmayı unuttum" hali sessizce çalışıyor gibi görünmesin.

const express = require('express');
const { Readable } = require('stream');

// Kanal listeleri ayar dosyasından gelir (config.json → "kanallar"; örnek: config.example.json).
// Ekranda numara değil ad görünür; ad aynı zamanda eşleşme anahtarıdır ("Habertürk" → TV'de "HABERTURK HD").
// Adla tutulur, numarayla DEĞİL — iki TV'de numaralar farklı ve sıralama değiştikçe numara da değişir;
// ajan adı her TV'nin kendi listesinde çözer.
//   favoriler: ana listede satır satır (logo + şu anki program)
//   diger:     altında yalnız logolu ızgara
//   logolar:   { "Kanal D": "kanald" } → /logolar/kanald.png (dosyalar veri dizininde, depoda yok)
function kanalAyari({ favoriler = [], diger = [], logolar = {} } = {}) {
  const FAVORI_KANALLAR = favoriler.map(String);
  const DIGER_KANALLAR = diger.map(String).filter((ad) => !FAVORI_KANALLAR.includes(ad));
  const logoEkle = (k) => ({ ...k, logo: logolar[k.ad] ? `/logolar/${logolar[k.ad]}.png` : null });
  return { FAVORI_KANALLAR, DIGER_KANALLAR, logoEkle };
}

// Zamanlayıcı işlemleri ve doğrulama kalıpları (ajan da ayrıca doğrular — iki kat).
const ZAMAN_ISLEMLERI = new Set(['geri-don', 'ekle', 'uzat', 'sil', 'etkin', 'hemen']);
const GOREV_ID = /^[a-f0-9]{6,24}$/;
const TARIH = /^\d{4}-\d{2}-\d{2}$/;
const SAAT = /^([01]\d|2[0-3]):[0-5]\d$/;

// Kaynak menüsü yalnız bu hedeflere — panelden keyfi uygulama başlatılamaz (ajan da aynı listeyi denetler).
const GIRIS_HEDEFLERI = new Set(['canli', 'apple', 'netflix', 'prime', 'disney']);

const TV_ID = /^[a-z0-9-]{1,20}$/;
const TUSLAR = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'INFO', 'GUIDE', 'LIST',
  'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE',
  'RED', 'GREEN', 'YELLOW', 'BLUE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'PLAY', 'PAUSE', 'REWIND', 'FASTFORWARD',
]);

// YouTube engelleri ve TV kilidi (kurallar ve durum ajanda; geçit yalnız doğrular ve iletir).
const ENGEL_TURLERI = new Set(['video', 'kanal', 'kelime']);
const ENGEL_ID = /^[a-f0-9]{8}$/;
const KILIT_KAPSAMLARI = new Set(['tv', 'tv+apple']);
const KILIT_EN_COK_DK = 30 * 24 * 60;
// TV'de gösterilen çok satırlı metinler (kilit mesajı, engel mesajı ve uyarısı): ajan en çok 5 satır gösterir,
// baştaki/sondaki boş satırları atar, aradaki boş satırı ayırıcı olarak korur. Geçit ham satırları biraz payla
// (7) kabul eder ki kenardaki boş satırlar yüzünden kayıt reddedilmesin; satır sınırı ajanla aynı (80).
const METIN_EN_COK_SATIR = 7;
const METIN_SATIR_UZUNLUGU = 80;
const satirlarGecerli = (x) => Array.isArray(x) && x.length <= METIN_EN_COK_SATIR
  && x.every((s) => typeof s === 'string' && s.length <= METIN_SATIR_UZUNLUGU);

// Canlı önizleme: girişli tek istemci sınırsız akış açıp geçit↔ajan bağlantılarını tüketmesin.
const AKIS_EN_COK = 6;
const AKIS_ILK_YANIT_MS = 15000;

function olustur({ url = process.env.TV_AJAN_URL, token = process.env.TV_AJAN_TOKEN, fetchFn = globalThis.fetch, log = console.log, kanallar = {} } = {}) {
  const { FAVORI_KANALLAR, DIGER_KANALLAR, logoEkle } = kanalAyari(kanallar);
  const r = express.Router();
  const taban = String(url || '').replace(/\/+$/, '');

  r.use((req, res, next) => {
    if (!taban || !token) return res.status(503).json({ error: 'TV ajanı tanımlı değil (TV_AJAN_URL / TV_AJAN_TOKEN)' });
    next();
  });

  // X-Istemci: ajan kilit/engel işlem kaydına "panel" yazar (ajana doğrudan komutla yapılanlar "dogrudan").
  const basliklar = (govde) => ({ Authorization: `Bearer ${token}`, 'X-Istemci': 'panel', ...(govde ? { 'Content-Type': 'application/json' } : {}) });
  function ajan(yol, { method = 'GET', govde, ms = 8000 } = {}) {
    return fetchFn(taban + yol, {
      method,
      headers: basliklar(govde),
      body: govde ? JSON.stringify(govde) : undefined,
      signal: AbortSignal.timeout(ms),
    });
  }

  const ulasilamadi = (res, e) =>
    res.status(504).json({ error: e && e.name === 'TimeoutError' ? 'TV ajanı yanıt vermedi' : 'TV ajanına ulaşılamadı' });

  // Ajanın 401/403'ü = TV_AJAN_TOKEN uyuşmazlığı (kurulumda en olası hata). Olduğu gibi geçseydi arayüz
  // bunu "oturum düştü" sanıp /login'e gider, /login de geçerli çerezi görüp geri yollardı: sonsuz döngü.
  // Bu yüzden 502'ye çevrilir ve günlüğe (dakikada en çok bir kez) yazılır.
  const belirtecRed = (c) => c.status === 401 || c.status === 403;
  let sonBelirtecLog = 0;
  function belirtecReddetti(res) {
    if (Date.now() - sonBelirtecLog > 60000) {
      sonBelirtecLog = Date.now();
      log('[TV] ⚠️ ajan belirteci reddetti — TV_AJAN_TOKEN iki tarafta aynı mı?');
    }
    return res.status(502).json({ error: 'TV ajanı belirteci reddetti (TV_AJAN_TOKEN)' });
  }

  /** Ajanın JSON yanıtını panelin `{error}` biçimine çevirip iletir. */
  async function ilet(res, istek) {
    try {
      const c = await istek;
      if (belirtecRed(c)) return belirtecReddetti(res);
      const j = await c.json().catch(() => ({}));
      if (j && j.hata) return res.status(c.status).json({ error: j.hata });
      return res.status(c.status).json(j);
    } catch (e) {
      return ulasilamadi(res, e);
    }
  }

  const tvGecerli = (tv) => typeof tv === 'string' && TV_ID.test(tv);
  const hata = (res, m) => res.status(400).json({ error: m });
  const adla = () => ({ kanallar: FAVORI_KANALLAR.map((ad) => logoEkle({ ad, no: null })), diger: DIGER_KANALLAR.map((ad) => logoEkle({ ad, no: null })) });

  r.get('/tvler', (req, res) => ilet(res, ajan('/tvler', { ms: 15000 })));

  r.get('/favoriler', async (req, res) => {
    const tv = req.query.tv;
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    try {
      // Favoriler ve ızgara tek çözümlemede (TV'ye tek istek).
      const c = await ajan('/cozumle', { method: 'POST', govde: { tv, adlar: [...FAVORI_KANALLAR, ...DIGER_KANALLAR] }, ms: 20000 });
      if (belirtecRed(c)) return belirtecReddetti(res);
      const j = await c.json().catch(() => ({}));
      if (c.ok && Array.isArray(j.kanallar)) {
        const fav = new Set(FAVORI_KANALLAR);
        return res.json({
          kanallar: j.kanallar.filter((k) => fav.has(k.ad)).map(logoEkle),
          // Bu TV'de bulunmayan kanal ızgarada gösterilmez (basınca hata vermesin).
          diger: j.kanallar.filter((k) => !fav.has(k.ad) && k.no != null).map(logoEkle),
        });
      }
      // TV kapalıysa numaralar çözülemez; düğmeler yine adla görünsün.
      return res.json({ ...adla(), uyari: j.hata || 'numaralar alınamadı' });
    } catch (e) {
      return res.json({ ...adla(), uyari: 'TV ajanına ulaşılamadı' });
    }
  });

  // Yayın akışı (Program penceresi): favoriler + ızgaradaki kanallar, şu andan 30 saat.
  r.get('/akis', async (req, res) => {
    const tv = req.query.tv;
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    try {
      const c = await ajan('/akis', { method: 'POST', govde: { adlar: [...FAVORI_KANALLAR, ...DIGER_KANALLAR], saat: 30 }, ms: 30000 });
      if (belirtecRed(c)) return belirtecReddetti(res);
      const j = await c.json().catch(() => ({}));
      if (!c.ok) return res.status(c.status).json({ error: j.hata || 'yayın akışı alınamadı' });
      return res.json({ simdi: j.simdi, kanallar: (j.kanallar || []).map(logoEkle) });
    } catch (e) {
      return ulasilamadi(res, e);
    }
  });

  // "Şu an ne var": TV'nin kendi akışı güvenilmez çıktığı için (ertesi günün programını verebiliyor) ajan
  // yayın rehberinden okur. Rehber TV'ye bağlı değil: TV kapalıyken de gelir.
  r.get('/epg', async (req, res) => {
    const tv = req.query.tv;
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    return ilet(res, ajan('/epg', { method: 'POST', govde: { tv, adlar: FAVORI_KANALLAR }, ms: 30000 }));
  });

  r.get('/ekran', async (req, res) => {
    const tv = req.query.tv;
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    try {
      const c = await ajan(`/ekran?tv=${encodeURIComponent(tv)}`, { ms: 15000 });
      if (belirtecRed(c)) return belirtecReddetti(res);
      if (!c.ok) {
        const j = await c.json().catch(() => ({}));
        return res.status(c.status).json({ error: j.hata || 'ekran görüntüsü alınamadı' });
      }
      const jpeg = Buffer.from(await c.arrayBuffer());
      res.set('Cache-Control', 'no-store');
      return res.type('image/jpeg').send(jpeg);
    } catch (e) {
      return ulasilamadi(res, e);
    }
  });

  r.post('/tus', (req, res) => {
    const { tv } = req.body || {};
    const tus = String((req.body || {}).tus || '').toUpperCase();
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (!TUSLAR.has(tus)) return hata(res, 'izinli olmayan tuş');
    // Uygulama kumandası Apple TV girişindeyken tuş Apple TV'ye gider (ajan çevirir; pyatv).
    const apple = (req.body || {}).cihaz === 'apple';
    return ilet(res, ajan('/tus', { method: 'POST', govde: apple ? { tv, tus, cihaz: 'apple' } : { tv, tus }, ms: apple ? 30000 : 8000 }));
  });

  // Apple TV'de odaktaki yazı alanına metin (uygulama kumandası → arama).
  r.post('/metin', (req, res) => {
    const { tv, metin } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (typeof metin !== 'string' || metin.length > 100) return hata(res, 'metin en çok 100 karakter');
    return ilet(res, ajan('/metin', { method: 'POST', govde: { tv, metin }, ms: 30000 }));
  });

  r.post('/kanal', (req, res) => {
    const { tv, ad, no } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    const adGecerli = typeof ad === 'string' && ad.trim().length > 0 && ad.length <= 60;
    const noGecerli = (typeof no === 'number' || typeof no === 'string') && /^\d{1,5}$/.test(String(no));
    if (!adGecerli && !noGecerli) return hata(res, 'kanal adı ya da numarası gerekli');
    log(`[TV] ${tv} kanal → ${adGecerli ? ad : no}`);
    // TV kapalıysa ajan önce açar (≤ 40 sn), sonra kanalı açar: kanal düğmesi her durumda o kanalı açsın.
    // Ters vekilin okuma zaman aşımı bundan uzun olmalı (örnek nginx: 300 sn).
    return ilet(res, ajan('/kanal', { method: 'POST', govde: adGecerli ? { tv, ad: ad.trim() } : { tv, no: Number(no) }, ms: 75000 }));
  });

  // Ses düzeyi (Ch / Vol penceresindeki şerit). Harici ses çıkışında ajan `seviye: null` döner.
  r.get('/ses', (req, res) => {
    const tv = req.query.tv;
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    return ilet(res, ajan(`/ses?tv=${encodeURIComponent(tv)}`));
  });
  r.post('/ses', (req, res) => {
    const { tv, seviye } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (!Number.isInteger(seviye) || seviye < 0 || seviye > 100) return hata(res, 'ses 0-100 arasında tam sayı olmalı');
    return ilet(res, ajan('/ses', { method: 'POST', govde: { tv, seviye } }));
  });

  // Dokunmatik yüzey (Ayarlar penceresi): TV'nin Magic Remote imleci. Sık gelir — günlüğe yazılmaz.
  r.post('/isaretci', (req, res) => {
    const { tv, dx, dy, tikla } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (tikla === true) return ilet(res, ajan('/isaretci', { method: 'POST', govde: { tv, tikla: true }, ms: 6000 }));
    if (![dx, dy].every((v) => Number.isInteger(v) && Math.abs(v) <= 2000) || (!dx && !dy)) return hata(res, 'geçersiz hareket');
    return ilet(res, ajan('/isaretci', { method: 'POST', govde: { tv, dx, dy }, ms: 6000 }));
  });

  // Uzaktan açma (Wake-on-LAN, ajandan). Ajan TV kumandaya hazır olana kadar bekler.
  r.post('/ac', (req, res) => {
    const { tv } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    log(`[TV] ${tv} açılıyor`);
    return ilet(res, ajan('/ac', { method: 'POST', govde: { tv }, ms: 55000 }));
  });

  // Kaynak menüsü: Canlı TV, Apple TV, Netflix / Prime / Disney+. Hangi HDMI'nın Apple TV olduğunu ajan
  // TV'nin kendi giriş adlarından bulur (ör. "Apple TV", "Apple OTT").
  r.post('/giris', (req, res) => {
    const { tv, hedef } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (!GIRIS_HEDEFLERI.has(hedef)) return hata(res, 'geçersiz giriş');
    log(`[TV] ${tv} giriş → ${hedef}`);
    // TV kapalıysa ajan önce açar (≤ 40 sn) — kanal düğmesi gibi.
    return ilet(res, ajan('/giris', { method: 'POST', govde: { tv, hedef }, ms: 75000 }));
  });

  // Canlı önizleme: sayfa açık olduğu sürece akış. Ajanın multipart JPEG akışı olduğu gibi aktarılır; telefon
  // bağlantıyı kapatınca ajana giden istek de kesilir. nginx tamponlamasın diye X-Accel-Buffering: no.
  let akisSayisi = 0;
  r.get('/ekran-akis', async (req, res) => {
    const tv = req.query.tv;
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (akisSayisi >= AKIS_EN_COK) return res.status(429).json({ error: 'çok fazla canlı önizleme' });
    akisSayisi++;
    let birakildi = false;
    const birak = () => { if (!birakildi) { birakildi = true; akisSayisi--; } };
    res.on('close', birak);
    const sn = Math.min(Math.max(parseInt(req.query.sn, 10) || 120, 5), 180);
    // Kare sıklığı istemciden (kumanda 3 sn'de bir ister); en çok 2 kare/sn.
    const fps = Math.round(Math.min(Math.max(Number(req.query.fps) || 1, 0.1), 2) * 100) / 100;
    const kes = new AbortController();
    req.on('close', () => kes.abort());
    // Ajan bağlantıyı kabul edip başlık göndermezse istemci kapanana kadar beklenmesin.
    const ilk = setTimeout(() => kes.abort(), AKIS_ILK_YANIT_MS);
    try {
      const c = await fetchFn(`${taban}/ekran-akis?tv=${encodeURIComponent(tv)}&sn=${sn}&fps=${fps}`, {
        headers: basliklar(false), signal: kes.signal,
      });
      clearTimeout(ilk);
      if (belirtecRed(c)) { birak(); return belirtecReddetti(res); }
      if (!c.ok || !c.body) {
        const j = await c.json().catch(() => ({}));
        birak();
        return res.status(c.status || 502).json({ error: j.hata || 'canlı önizleme başlatılamadı' });
      }
      res.status(200).set({ 'Content-Type': c.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=kare', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const akis = Readable.fromWeb(c.body);
      akis.on('error', () => res.end());
      akis.on('end', birak);
      akis.pipe(res);
    } catch (e) {
      clearTimeout(ilk);
      birak();
      if (!res.headersSent) return ulasilamadi(res, e);
      res.end();
    }
  });

  // Ekranı kapat / aç — ses devam eder.
  r.post('/ekran-guc', (req, res) => {
    const { tv, kapali } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (typeof kapali !== 'boolean') return hata(res, 'kapali true/false olmalı');
    log(`[TV] ${tv} ekran ${kapali ? 'kapat' : 'aç'}`);
    return ilet(res, ajan('/ekran-guc', { method: 'POST', govde: { tv, kapali } }));
  });

  // TV ekranına mesaj: yazılmış ya da hazır mesaj, görünme süresiyle.
  r.post('/bildirim', (req, res) => {
    const { tv } = req.body || {};
    const mesaj = String((req.body || {}).mesaj || '').trim();
    const sureSn = Number((req.body || {}).sureSn);
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (!mesaj || mesaj.length > 160) return hata(res, 'mesaj 1-160 karakter olmalı');
    if (!Number.isInteger(sureSn) || sureSn < 5 || sureSn > 120) return hata(res, 'süre 5-120 sn olmalı');
    log(`[TV] ${tv} mesaj (${sureSn} sn)`);
    return ilet(res, ajan('/bildirim', { method: 'POST', govde: { tv, mesaj, sureSn } }));
  });

  // İzleme kaydı (Detail sayfası). gun = 'YYYY-AA-GG' (ajan kendi saat diliminde — TV_AJAN_TZ — yorumlar;
  // geçitteki KUMANDA_TZ ile aynı olmalı), gunSayisi 1-31 (o güne kadar geriye), tv isteğe bağlı.
  r.get('/izleme', (req, res) => {
    const { tv, gun, gunSayisi } = req.query;
    if (tv != null && !tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (gun != null && !TARIH.test(String(gun))) return hata(res, 'gün YYYY-AA-GG olmalı');
    const n = Math.min(Math.max(parseInt(gunSayisi, 10) || 1, 1), 31);
    const q = new URLSearchParams({ gunSayisi: String(n), ...(gun ? { gun: String(gun) } : {}), ...(tv ? { tv: String(tv) } : {}) });
    return ilet(res, ajan(`/izleme?${q}`, { ms: 20000 }));
  });

  // TV kilidi: kilitli TV kumandadan açılamaz; kendi kumandasıyla açılırsa ajan kilit mesajını gösterip kapatır.
  r.get('/kilit', (req, res) => ilet(res, ajan('/kilit')));
  r.post('/kilit', (req, res) => {
    const { tv, dk, kapsam } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    if (dk != null && !(Number.isInteger(dk) && dk >= 1 && dk <= KILIT_EN_COK_DK)) return hata(res, 'süre 1 dk – 30 gün ya da süresiz olmalı');
    if (kapsam != null && !KILIT_KAPSAMLARI.has(kapsam)) return hata(res, 'kapsam tv ya da tv+apple olmalı');
    log(`[TV] ${tv} kilitleniyor (${dk ? `${dk} dk` : 'süresiz'})`);
    return ilet(res, ajan('/kilit', { method: 'POST', govde: { tv, dk: dk ?? null, ...(kapsam ? { kapsam } : {}) } }));
  });
  r.delete('/kilit/:tv', (req, res) => {
    if (!tvGecerli(req.params.tv)) return hata(res, 'geçersiz TV');
    log(`[TV] ${req.params.tv} kilidi açılıyor`);
    return ilet(res, ajan(`/kilit?tv=${encodeURIComponent(req.params.tv)}`, { method: 'DELETE' }));
  });
  r.post('/kilit/ayar', (req, res) => {
    const { mesaj } = req.body || {};
    if (!satirlarGecerli(mesaj)) return hata(res, 'mesaj en çok 5 satır, satır başına 80 karakter');
    return ilet(res, ajan('/kilit/ayar', { method: 'POST', govde: { mesaj } }));
  });

  // YouTube engelleri: kanal · kelime · video kuralları ajanda; panel yalnız doğrular ve iletir.
  r.get('/engel', (req, res) => ilet(res, ajan('/engel')));
  r.post('/engel', (req, res) => {
    const { metin, tur } = req.body || {};
    if (typeof metin !== 'string' || !metin.trim() || metin.length > 300) return hata(res, 'link, kanal adı ya da kelime gerekli (en çok 300 karakter)');
    if (tur != null && !ENGEL_TURLERI.has(tur)) return hata(res, 'tür video, kanal ya da kelime olmalı');
    return ilet(res, ajan('/engel', { method: 'POST', govde: { metin: metin.trim(), ...(tur ? { tur } : {}) }, ms: 25000 }));
  });
  r.delete('/engel/:id', (req, res) => {
    if (!ENGEL_ID.test(req.params.id)) return hata(res, 'geçersiz kural');
    return ilet(res, ajan(`/engel?id=${req.params.id}`, { method: 'DELETE' }));
  });
  // Engel ayarları: açık/kapalı ve TV'de gösterilen iki metin — `mesaj` (1. kademe: video engellenince) ve
  // `uyari` (2. kademe: aynı video yeniden açılınca, YouTube kapatılmadan önce). Yalnız gelen alanlar iletilir.
  r.post('/engel/ayar', (req, res) => {
    const b = req.body || {};
    const govde = {};
    if (b.acik !== undefined) {
      if (typeof b.acik !== 'boolean') return hata(res, 'acik true/false olmalı');
      govde.acik = b.acik;
    }
    if (b.mesaj !== undefined) {
      if (!satirlarGecerli(b.mesaj)) return hata(res, 'mesaj en çok 5 satır, satır başına 80 karakter');
      govde.mesaj = b.mesaj;
    }
    if (b.uyari !== undefined) {
      if (!satirlarGecerli(b.uyari)) return hata(res, 'uyarı en çok 5 satır, satır başına 80 karakter');
      govde.uyari = b.uyari;
    }
    if (!Object.keys(govde).length) return hata(res, 'engel ayarı: acik, mesaj ya da uyari gerekli');
    return ilet(res, ajan('/engel/ayar', { method: 'POST', govde }));
  });

  // "Geri dön" sayacı + Program görevleri. Program kanalı kumandadaki kanallardan biri olmalı (favori ya da ızgara).
  r.get('/zamanlayici', (req, res) => ilet(res, ajan('/zamanlayici')));
  r.post('/zamanlayici', (req, res) => {
    const b = req.body || {};
    const islem = String(b.islem || '');
    if (!ZAMAN_ISLEMLERI.has(islem)) return hata(res, 'bilinmeyen işlem');
    let govde;
    if (islem === 'geri-don') {
      if (!tvGecerli(b.tv)) return hata(res, 'geçersiz TV');
      const dk = Number(b.dk);
      if (!Number.isInteger(dk) || dk < 1 || dk > 120) return hata(res, 'süre 1-120 dk olmalı');
      govde = { islem, tv: b.tv, dk };
    } else if (islem === 'ekle') {
      if (!tvGecerli(b.tv)) return hata(res, 'geçersiz TV');
      if (!FAVORI_KANALLAR.includes(b.kanal) && !DIGER_KANALLAR.includes(b.kanal)) return hata(res, 'kanal kumandadaki kanallardan seçilmeli');
      const z = b.zaman || {};
      if (!['ac', 'atla'].includes(b.tvKapaliysa)) return hata(res, 'TV kapalıysa: ac ya da atla');
      const etiket = b.etiket == null ? null : String(b.etiket).trim();
      if (etiket != null && etiket.length > 80) return hata(res, 'etiket en çok 80 karakter');
      const ortak = { islem, tv: b.tv, kanal: b.kanal, tvKapaliysa: b.tvKapaliysa };
      if (z.tur === 'tek') {
        if (!TARIH.test(String(z.tarih || '')) || !SAAT.test(String(z.saat || ''))) return hata(res, 'tarih ve saat gerekli');
        govde = { ...ortak, zaman: { tur: 'tek', tarih: String(z.tarih), saat: String(z.saat) }, ...(etiket ? { etiket } : {}) };
      } else if (z.tur === 'sonra') {
        // Kanala basılı tutunca "X dk sonra git": an ajanda, dakikası dakikasına hesaplanır.
        const dk = Number(z.dk);
        if (!Number.isInteger(dk) || dk < 1 || dk > 720) return hata(res, 'süre 1-720 dk olmalı');
        govde = { ...ortak, zaman: { tur: 'sonra', dk }, ...(etiket ? { etiket } : {}) };
      } else if (z.tur === 'haftalik') {
        const gunler = Array.isArray(z.gunler) ? z.gunler.map(Number) : [];
        if (!SAAT.test(String(z.saat || '')) || !gunler.length || gunler.some((g) => !Number.isInteger(g) || g < 1 || g > 7)) return hata(res, 'saat ve günler gerekli');
        govde = { ...ortak, zaman: { tur: 'haftalik', saat: String(z.saat), gunler }, ...(etiket ? { etiket } : {}) };
      } else return hata(res, 'zaman türü tek, sonra ya da haftalik olmalı');
    } else {
      if (!GOREV_ID.test(String(b.id || ''))) return hata(res, 'geçersiz görev');
      govde = { islem, id: String(b.id) };
      if (islem === 'uzat') { const dk = Number(b.dk ?? 1); if (!Number.isInteger(dk) || dk < 1 || dk > 30) return hata(res, 'uzatma 1-30 dk'); govde.dk = dk; }
      if (islem === 'etkin') { if (typeof b.acik !== 'boolean') return hata(res, 'acik true/false olmalı'); govde.acik = b.acik; }
    }
    log(`[TV] zamanlayıcı ${islem}${govde.tv ? ` ${govde.tv}` : ''}`);
    return ilet(res, ajan('/zamanlayici', { method: 'POST', govde, ms: islem === 'hemen' ? 75000 : 15000 }));
  });

  r.post('/kapat', (req, res) => {
    const { tv } = req.body || {};
    if (!tvGecerli(tv)) return hata(res, 'geçersiz TV');
    log(`[TV] ${tv} kapatılıyor`);
    return ilet(res, ajan('/kapat', { method: 'POST', govde: { tv } }));
  });

  return r;
}

/**
 * Ajandaki olayların sonucu insana ulaşsın (günlük tek başına kanal sayılmaz). Ajanın kayıtları okunur,
 * YENİ kayıt telefona bildirilir:
 *   • zamanlanmış görev: hata / kaçırıldı → "tv" konusu; reklam bitti (geri dön) / planlı yayın başladı
 *     (tamam ya da TV kapalı diye atlandı) → "tv-olay". TV'ye mesaj görevi başarıda bildirim göndermez
 *     (mesaj zaten ekranda gösterildi), yalnız hatada.
 *   • YouTube engeli: engellenen her deneme → "tv-olay".
 *   • TV kilidi: yalnız "kilitliyken açıldı, kapatıldı" (kapatildi) → "tv-olay". Kilitleme, açma ve sürenin
 *     dolması yalnız işlem kaydında kalır — kumandadan yapılan işlem telefona geri bildirilmez.
 * Her kaynağın ilk başarılı okuması yalnız mevcut kayıtları "görüldü" sayar (yeniden başlatmada eski olaylar
 * tekrar bildirilmesin). Yoklama dakikada bir; bir görevin vakti yakınsa (−3 dk … +70 sn) 5 sn'de bir —
 * "reklam bitti" bildirimi kanal açıldıktan birkaç saniye sonra gelsin, bir dakika sonra değil.
 * Geçitte tek örnek çalışır (sunucu.cjs) — bildirim bir kez gider.
 */
const tvAdiYap = (id) => { const s = String(id || ''); return s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1); };
const ENGEL_KURAL_ADI = { kanal: 'kanal', kelime: 'kelime', video: 'video' };

function sonucIzleyici({ url = process.env.TV_AJAN_URL, token = process.env.TV_AJAN_TOKEN, fetchFn = globalThis.fetch, bildir, log = console.log, araMs = 60000, yakinMs = 5000, simdi = Date.now } = {}) {
  const taban = String(url || '').replace(/\/+$/, '');
  if (!taban || !token || !bildir) return { durdur() {}, async yokla() {} };
  const gorulen = new Set();
  const ilkOkuma = new Set(['gorev', 'engel', 'kilit']);   // kaynağın ilk başarılı okumasında bildirim yok
  const adlar = new Map();                                    // TV kimliği → ad (ajanın /kilit yanıtından)
  const tvAdi = (id) => adlar.get(id) || tvAdiYap(id);
  let zamanlayici = null;
  let durdu = false;
  // Ajan hatası (401, 5xx, ulaşılamıyor) sessiz kalmasın ama dakikada bir günlüğü de doldurmasın: saatte bir.
  let sonHataLog = 0;
  const hataYaz = (m) => { const t = simdi(); if (t - sonHataLog > 3600e3) { sonHataLog = t; log(`[TV] sonuç izleyici: ${m}`); } };
  const gonder = async (...a) => {
    try { await bildir(...a); } catch (e) { log(`[TV] bildirim gönderilemedi: ${e.message}`); }
  };
  async function oku(yol) {
    const c = await fetchFn(`${taban}${yol}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (!c.ok) { hataYaz(`ajan ${yol} → HTTP ${c.status}`); return null; }
    return c.json();
  }
  /** Kayıtları eskiden yeniye dolaşır; görülmemiş olanlar için `isle` çağrılır (ilk okumada yalnız işaretlenir). */
  async function yeniler(kaynak, liste, anahtar, isle) {
    const ilk = ilkOkuma.has(kaynak);
    for (const o of (Array.isArray(liste) ? liste : []).slice().reverse()) {
      const a = `${kaynak}:${anahtar(o)}`;
      if (gorulen.has(a)) continue;
      gorulen.add(a);
      if (!ilk) await isle(o);
    }
    ilkOkuma.delete(kaynak);
  }

  async function yokla() {
    let yakin = false;
    try {
      const j = await oku('/zamanlayici');
      if (j) {
        const t = simdi();
        yakin = (j.gorevler || []).some((g) => g.etkin !== false && g.an && g.an - t < 70000 && t - g.an < 180000);
      }
      // TV adları bildirim metni için (kilit yanıtı TV listesini taşır); önce okunur.
      let kilit = null;
      try { kilit = await oku('/kilit'); } catch (e) { hataYaz(`kilit: ${e.message}`); }
      for (const tv of (kilit && kilit.tvler) || []) if (tv && tv.id && tv.ad) adlar.set(tv.id, String(tv.ad));

      if (j) {
        await yeniler('gorev', j.gecmis, (g) => `${g.id}:${g.bitti}`, async (g) => {
          const ne = g.mesaj ? 'TV mesajı' : (g.kanal && (g.kanal.ad || g.kanal.no)) || 'kanal';
          const geriDon = g.tur === 'geri-don';
          if (g.sonuc === 'hata' || g.sonuc === 'kacirildi') {
            await gonder(`📺 ${geriDon ? 'Geri dön' : 'Program'}: ${g.sonuc === 'hata' ? 'yapılamadı' : 'kaçırıldı'}`, `${tvAdi(g.tv)} · ${ne}${g.neden ? ` — ${g.neden}` : ''}`, 'tv');
          } else if (g.mesaj) {
            // TV'ye mesaj görevi: ekranda gösterildi ya da TV kapalıydı — telefona bildirim gerekmez.
          } else if (g.sonuc === 'ok' || g.sonuc === 'atlandi') {
            const baslik = geriDon ? '📺 Reklam bitti' : `📺 Başladı: ${g.etiket || ne}`;
            const govde = g.sonuc === 'ok' ? `${tvAdi(g.tv)}: ${ne} açıldı` : `${tvAdi(g.tv)} kapalıydı — kanal açılmadı`;
            await gonder(baslik, govde, 'tv-olay', `tv-${g.id}`);
          }
        });
      }

      try {
        const e = await oku('/engel');
        if (e) {
          await yeniler('engel', e.olaylar, (o) => o.id, async (o) => {
            const kural = o.kural ? `${ENGEL_KURAL_ADI[o.kural.tur] || o.kural.tur}: ${o.kural.tur === 'video' ? 'listedeki video' : o.kural.deger}` : '';
            await gonder('🚫 YouTube engellendi', `${tvAdi(o.tv)}: ${o.baslik || 'video'}${o.kanal ? ` (${o.kanal})` : ''}${kural ? ` — ${kural}` : ''}`, 'tv-olay', `engel-${o.id}`);
          });
        }
      } catch (err) { hataYaz(`engel: ${err.message}`); }

      if (kilit) {
        await yeniler('kilit', kilit.olaylar, (o) => o.id, async (o) => {
          if (o.ne && o.ne !== 'kapatildi') return;   // kilitlendi / açıldı / süresi doldu: yalnız işlem kaydında
          await gonder('🔒 Kilitli TV açıldı', `${tvAdi(o.tv)} kilitliyken açıldı — mesaj gösterilip kapatıldı`, 'tv-olay', `kilit-${o.id}`);
        });
      }
    } catch (e) {
      hataYaz(`${e.name}: ${e.message}`);
    }
    return yakin;
  }
  async function dongu() {
    const yakin = await yokla();
    if (!durdu) { zamanlayici = setTimeout(dongu, Math.min(yakin ? yakinMs : araMs, 2 ** 31 - 1)); zamanlayici.unref?.(); }
  }
  dongu();
  return { durdur: () => { durdu = true; clearTimeout(zamanlayici); }, yokla };
}

module.exports = { olustur, sonucIzleyici, kanalAyari, TUSLAR, GIRIS_HEDEFLERI };
