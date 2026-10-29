#!/usr/bin/env node
/**
 * Demo modu — TV'siz, ajansız, girişsiz: kumanda arayüzünü sahte verilerle açar.
 *
 *   npm run demo          → http://127.0.0.1:3061  (telefonla denemek için: HOST=0.0.0.0 npm run demo)
 *
 * Hiçbir gerçek cihaza istek atmaz. Durum bellekte tutulur: kanal değiştirmek, kaynak seçmek, "reklamdan sonra
 * geri dön" kurmak, program eklemek, ses, TV kilidi ve YouTube engelleri arayüzde gerçekmiş gibi çalışır; Detail
 * sayfası uydurma bir izleme geçmişi gösterir. Ekran önizlemesi çizilmiş bir resimdir. Bütün kanal sahibi, video ve
 * program adları uydurmadır. Saat dilimi: KUMANDA_TZ (varsayılan Europe/Istanbul) — geçitteki gibi.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KOK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(KOK, 'web');
const PORT = Number(process.env.PORT || 3061);
const HOST = process.env.HOST || '127.0.0.1';
const { kanallar: AYAR } = JSON.parse(readFileSync(join(KOK, 'config.example.json'), 'utf8'));

const DAKIKA = 60e3;
const SAAT_MS = 3600e3;
const GUN_MS = 24 * SAAT_MS;

// ── saat dilimi (arayüzle aynı bölge; web/saat.js ile aynı hesap) ──────────
const TZ = (() => {
  const tz = process.env.KUMANDA_TZ || 'Europe/Istanbul';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'Europe/Istanbul'; }
})();
const BICIM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const parca = (ms) => { const p = {}; for (const x of BICIM.formatToParts(new Date(ms))) p[x.type] = x.value; return { y: +p.year, ay: +p.month, g: +p.day, sa: +p.hour % 24, dk: +p.minute, sn: +p.second }; };
const ofset = (ms) => { const t = Math.floor(ms / 1000) * 1000; const p = parca(t); return Date.UTC(p.y, p.ay - 1, p.g, p.sa, p.dk, p.sn) - t; };
const yerelAn = (y, ay, g, sa = 0, dk = 0) => { const tahmin = Date.UTC(y, ay - 1, g, sa, dk); const o1 = ofset(tahmin); let an = tahmin - o1; const o2 = ofset(an); if (o2 !== o1) an = tahmin - o2; return an; };
const iki = (n) => String(n).padStart(2, '0');
const saat = (ms) => { const p = parca(ms); return `${iki(p.sa)}:${iki(p.dk)}`; };
const gunOf = (ms) => { const p = parca(ms); return `${p.y}-${iki(p.ay)}-${iki(p.g)}`; };
const gunBasi = (gun) => { const [y, m, d] = gun.split('-').map(Number); return yerelAn(y, m, d); };
const gunEkle = (gun, n) => { const [y, m, d] = gun.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

// ── sahte dünya ──────────────────────────────────────────────────────────
const FAV = AYAR.favoriler;
const DIGER = AYAR.diger;
const no = (ad) => [...FAV, ...DIGER].indexOf(ad) + 1;
// Program adları tarayıcının diline göre (Accept-Language): ekran görüntüleri iki dilde de doğal görünsün.
const PROGRAMLAR = {
  tr: ['Akşam Haberleri', 'Dizi: Sahil Kasabası — Yeni Bölüm', 'Yarışma: Son Soru', 'Belgesel: Okyanusun Derinlikleri',
    'Film: Uzun Bir Yolculuğun Hikâyesi ve Ötesi', 'Spor Ana Haber', 'Gündem Özel', 'Sabah Programı', 'Çizgi Film Kuşağı', 'Müzik Listesi'],
  en: ['Evening News', 'Coastal Town — New Episode', 'Quiz Night: Final Round', 'Documentary: Ocean Depths',
    'Movie: The Long Road Home and Beyond', 'Sports Tonight', 'Current Affairs Special', 'Morning Show', 'Cartoon Hour', 'Music Countdown'],
};
let DIL = 'tr';
const BASLANGIC = Math.floor(Date.now() / (30 * DAKIKA)) * 30 * DAKIKA - 90 * DAKIKA;
/** Her kanal için uydurma akış (kanal adından türeyen sabit desen); `bas` verilirse o andan. */
const akisi = (ad, bas = BASLANGIC, adet = 24, dil = DIL) => {
  const i = no(ad);
  const p = [];
  let b = bas + (i % 4) * 15 * DAKIKA;
  for (let k = 0; k < adet; k++) {
    const sure = (45 + ((k + i) % 4) * 30) * DAKIKA;
    p.push({ ad: PROGRAMLAR[dil][(k + i) % PROGRAMLAR[dil].length], bas: b, bit: b + sure });
    b += sure;
  }
  return p;
};
const simdiSonra = (ad) => {
  const t = Date.now();
  const p = akisi(ad);
  const i = p.findIndex((x) => x.bas <= t && t < x.bit);
  const f = (x) => x && { ad: x.ad, bas: saat(x.bas), bit: saat(x.bit), bitis: x.bit };
  return { simdi: f(p[i]), sonraki: f(p[i + 1]) };
};

const tvler = [
  { id: 'tv1', ad: 'Living room', acik: true, uygulama: 'com.webos.app.livetv', uygulamaAdi: 'Canlı TV', kaynak: 'canli', cihaz: 'lg', appleTv: true, ekranKapali: false, kanal: { no: 1, ad: FAV[0] } },
  { id: 'tv2', ad: 'Bedroom', acik: false, acilabilir: true, sebep: 'kapalı' },
];
const bul = (id) => tvler.find((x) => x.id === id);
const yeniId = (n = 8) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const ses = { tv1: 18, tv2: 12 };

// Zamanlayıcı: bir TV mesajı görevi de var (Program listesinde 💬 olarak görünür).
/** Bugünün (geçtiyse yarının) SS:DD anı — bölgenin duvar saatiyle. */
const sonraki = (sa, dk, simdi = Date.now()) => {
  const bugun = gunOf(simdi);
  const an = yerelAn(...bugun.split('-').map(Number), sa, dk);
  return an > simdi ? an : yerelAn(...gunEkle(bugun, 1).split('-').map(Number), sa, dk);
};
let gorevler = [
  { id: yeniId(), tur: 'haftalik', tv: 'tv2', kanal: null, mesaj: { metin: 'Yatma vakti' }, saat: '21:30', gunler: [1, 2, 3, 4, 5, 6, 7], an: sonraki(21, 30), etkin: true },
];
const gecmis = [{ id: 'g0', tur: 'geri-don', tv: 'tv1', kanal: { no: 3, ad: FAV[2] }, bitti: Date.now() - 3600e3, sonuc: 'ok', neden: `3 · ${FAV[2]}` }];
/** Vakti gelen görevleri "çalıştırır" (ajanın yaptığı gibi): kanalı açar, geçmişe yazar; haftalık görev sonraki güne. */
function vaktiGelenler() {
  const simdi = Date.now();
  for (const g of gorevler.slice()) {
    if (!g.etkin || !g.an || g.an > simdi - 3000) continue;
    const t = bul(g.tv);
    let sonuc = 'ok';
    if (!g.mesaj && t && g.kanal && g.kanal.ad) {
      if (!t.acik && g.tvKapaliysa === 'atla') sonuc = 'atlandi';
      else Object.assign(t, { acik: true, kaynak: 'canli', cihaz: 'lg', ekranKapali: false, kanal: { no: no(g.kanal.ad) || g.kanal.no, ad: g.kanal.ad } });
    } else if (g.mesaj && !(t && t.acik)) sonuc = 'atlandi';
    gecmis.unshift({ ...g, bitti: simdi, sonuc });
    if (g.tur === 'haftalik') { const [sa, dk] = String(g.saat).split(':').map(Number); g.an = sonraki(sa, dk, simdi + 60000); }
    else gorevler = gorevler.filter((x) => x !== g);
  }
  gecmis.splice(30);
}
const liste = () => { vaktiGelenler(); return { simdi: Date.now(), gorevler, gecmis }; };

// ── TV kilidi ──
const kilit = {
  kilitler: { tv2: { bitis: Date.now() + 2 * SAAT_MS, kapsam: 'tv' } },
  mesaj: ['🔒 Bu TV şu an kilitli.', '', 'ℹ️ Daha sonra tekrar deneyin.'],
  olaylar: [
    { id: yeniId(), zaman: Date.now() - 40 * DAKIKA, tv: 'tv2', ne: 'kilitlendi', dk: 160, kapsam: 'tv', kaynak: 'panel' },
    { id: yeniId(), zaman: Date.now() - 26 * SAAT_MS, tv: 'tv2', ne: 'kapatildi' },
  ],
};
const kilitYaniti = () => {
  for (const [tv, k] of Object.entries(kilit.kilitler)) {
    if (k.bitis && k.bitis < Date.now()) { delete kilit.kilitler[tv]; kilit.olaylar.unshift({ id: yeniId(), zaman: Date.now(), tv, ne: 'suresi-doldu' }); }
  }
  for (const t of tvler) t.kilit = kilit.kilitler[t.id] ? { ...kilit.kilitler[t.id] } : null;
  return { tvler: tvler.map((t) => ({ id: t.id, ad: t.ad })), kilitler: kilit.kilitler, mesaj: kilit.mesaj, olaylar: kilit.olaylar.slice(0, 50) };
};
/** Ajanın kuralı: satır başı boşluk, baştaki/sondaki boş satır atılır; en çok 5 satır × 80 karakter; boş → varsayılan (null). */
const metinKirp = (x) => {
  const s = (Array.isArray(x) ? x : []).map((v) => String(v).trim().slice(0, 80));
  while (s.length && !s[0]) s.shift();
  while (s.length && !s[s.length - 1]) s.pop();
  return s.length ? s.slice(0, 5) : null;
};

// ── YouTube engelleri (uydurma kanal ve videolar) ──
const engel = {
  acik: true,
  kurallar: [
    { id: yeniId(), tur: 'kanal', deger: 'Örnek Şaka Kanalı', link: 'https://www.youtube.com/@ornek-saka-kanali', ornek: 'Şaka derlemesi #12' },
    { id: yeniId(), tur: 'kelime', deger: 'spoiler' },
    { id: yeniId(), tur: 'kelime', deger: 'prank' },
    { id: yeniId(), tur: 'video', videoId: 'demo0000002', baslik: 'Örnek engelli video', kanal: 'Örnek Kanal 4', link: 'https://www.youtube.com/watch?v=demo0000002' },
  ],
  olaylar: [
    { id: yeniId(), zaman: Date.now() - 95 * DAKIKA, tv: 'tv1', baslik: 'Prank derlemesi — bölüm 3', kanal: 'Örnek Kanal 5', kural: { tur: 'kelime', deger: 'prank' } },
  ],
  islemler: [
    { zaman: Date.now() - 3 * GUN_MS, ne: 'eklendi', tur: 'kelime', deger: 'prank', kaynak: 'panel' },
    { zaman: Date.now() - 3 * GUN_MS - DAKIKA, ne: 'acildi', kaynak: 'dogrudan' },
  ],
  mesaj: ['🚫 Bu videoyu izleme izniniz yok.'],
  uyari: ['⚠️ Aynı video yeniden açıldı.', '', 'YouTube kapatılıyor.'],
};
const engelYaniti = (ek = {}) => ({ acik: engel.acik, kurallar: engel.kurallar, olaylar: engel.olaylar, islemler: engel.islemler.slice(0, 50), mesaj: engel.mesaj, uyari: engel.uyari, ...ek });

// ── İzleme geçmişi: gün başına sabit (gün dizgesinden türeyen) uydurma kesitler ──
const YT = [
  { baslik: 'Kâğıttan turna nasıl katlanır', kanal: 'Örnek Atölye', id: 'demo0000001' },
  { baslik: 'Gezegenler on dakikada', kanal: 'Örnek Bilim Kanalı', id: null },
  { baslik: 'Pratik sebzeli makarna', kanal: 'Örnek Mutfak', id: null },
  { baslik: 'Kutup ayıları belgeseli — kısa', kanal: 'Örnek Doğa', id: null },
];
const tohum = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
function gunKesitleri(gun) {
  const b = gunBasi(gun);
  const t = tohum(gun);
  const an = (sa, dk = 0) => b + sa * SAAT_MS + dk * DAKIKA;
  const k = [];
  const canli = (tv, kanal, bas, bit, ekranKapali = false) => {
    for (const p of akisi(kanal, bas - 3 * SAAT_MS, 12, 'tr')) {
      const s = Math.max(bas, p.bas); const e = Math.min(bit, p.bit);
      if (e > s) k.push({ tv, bas: s, bit: e, kaynak: 'canli', kanal: { no: no(kanal), ad: kanal }, program: p.ad, ekranKapali });
    }
  };
  const yt = (tv, v, bas, bit, pasif = false) => k.push({ tv, bas, bit, kaynak: 'apple', uygulama: 'YouTube', program: `${v.baslik} (${v.kanal})`, ...(v.id ? { youtube: v.id } : {}), ...(pasif ? { pasif: true } : {}) });
  canli('tv1', FAV[3 % FAV.length], an(7, 20), an(8, 5 + (t % 20)));
  canli('tv1', FAV[t % FAV.length], an(19, 0), an(20, 30));
  yt('tv1', YT[t % YT.length], an(20, 32), an(20, 51));
  yt('tv1', YT[t % YT.length], an(20, 51), an(21, 2), true);
  yt('tv1', YT[(t + 1) % YT.length], an(21, 3), an(21, 20));
  k.push({ tv: 'tv1', bas: an(21, 25), bit: an(22, 40), kaynak: 'netflix' });
  canli('tv1', DIGER[t % DIGER.length], an(22, 40), an(23, 10), true);
  if (t % 3 !== 0) {
    canli('tv2', FAV[(t + 2) % FAV.length], an(18, 10), an(19, 0));
    k.push({ tv: 'tv2', bas: an(19, 0), bit: an(19, 35), kaynak: 'apple' });   // uygulaması tanımlanamayan Apple TV
    yt('tv2', YT[(t + 2) % YT.length], an(19, 35), an(20, 5));
  }
  return k;
}
function izleme(u) {
  const bugun = gunOf(Date.now());
  const son = /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get('gun') || '') ? u.searchParams.get('gun') : bugun;
  const n = Math.min(Math.max(parseInt(u.searchParams.get('gunSayisi'), 10) || 1, 1), 31);
  const tv = u.searchParams.get('tv');
  const ilk = gunEkle(son, -(n - 1));
  const simdi = Date.now();
  const kesitler = [];
  for (let g = ilk; g <= son && g <= bugun; g = gunEkle(g, 1)) {
    for (const x of gunKesitleri(g)) {
      if (x.bas >= simdi) continue;
      kesitler.push(x.bit > simdi ? { ...x, bit: simdi, acik: true } : x);
    }
  }
  // Şu an açık olan TV'nin süren kesiti (bugün): son kesitten şimdiye canlı yayın.
  if (son >= bugun) {
    const t1 = bul('tv1');
    if (t1.acik && t1.kaynak === 'canli' && t1.kanal) kesitler.push({ tv: 'tv1', bas: simdi - 12 * DAKIKA, bit: simdi, acik: true, kaynak: 'canli', kanal: t1.kanal, program: simdiSonra(t1.kanal.ad).simdi?.ad || null });
  }
  return { bas: gunBasi(ilk), bit: gunBasi(gunEkle(son, 1)), kesitler: kesitler.filter((x) => !tv || x.tv === tv).sort((a, b) => a.bas - b.bas) };
}

/** "Ekran görüntüsü": o anki kanal ve programla çizilmiş bir resim. */
function ekran(tv) {
  const kaynak = tv.kaynak || 'canli';
  const baslik = kaynak === 'canli' ? (simdiSonra(tv.kanal?.ad || FAV[0]).simdi?.ad || '') : ({ apple: 'Apple TV', netflix: 'Netflix', prime: 'Prime Video', disney: 'Disney+' }[kaynak] || '');
  const kanal = kaynak === 'canli' ? (tv.kanal?.ad || '') : '';
  const esc = (s) => String(s).replace(/[<&>"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;', '"': '&quot;' }[c]));
  const renk = ['#3b2a6b', '#0f4c5c', '#5c2a3e', '#2a4d2f', '#4a3b12'][(no(tv.kanal?.ad) || 1) % 5];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <defs><radialGradient id="a" cx="30%" cy="25%" r="90%"><stop offset="0" stop-color="#ffffff" stop-opacity=".35"/><stop offset="1" stop-color="${renk}"/></radialGradient>
  <linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".75"/></linearGradient></defs>
  <rect width="960" height="540" fill="${renk}"/><rect width="960" height="540" fill="url(#a)"/>
  <circle cx="700" cy="230" r="150" fill="#fff" fill-opacity=".08"/><circle cx="250" cy="330" r="220" fill="#fff" fill-opacity=".05"/>
  <rect width="960" height="540" fill="url(#b)" transform="rotate(180 480 270)"/>
  <text x="48" y="92" font-family="Helvetica, Arial, sans-serif" font-size="46" font-weight="700" fill="#fff">${esc(baslik)}</text>
  <text x="48" y="134" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#ffffffcc">${esc(kanal)}</text>
  <rect x="820" y="30" rx="10" width="110" height="44" fill="#000" fill-opacity=".45"/>
  <text x="875" y="60" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="#fff">DEMO</text>
</svg>`;
}

/** Demo kanal rozeti: adın baş harfleri, addan türeyen renk. */
function rozet(ad) {
  const harf = String(ad).replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).map((w) => (/^\d/.test(w) ? w : w[0])).join('').slice(0, 4).toUpperCase();
  let h = 0;
  for (const c of String(ad)) h = (h * 31 + c.codePointAt(0)) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
  <rect x="2" y="6" width="116" height="48" rx="12" fill="hsl(${h},70%,48%)"/>
  <text x="60" y="40" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${harf.length > 3 ? 20 : 26}" font-weight="800" fill="#fff">${harf}</text>
</svg>`;
}

// ── HTTP ─────────────────────────────────────────────────────────────────
const TIPLER = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const json = (res, j, kod = 200) => { res.writeHead(kod, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(j)); };
const govde = async (req) => { let b = ''; for await (const p of req) b += p; try { return b ? JSON.parse(b) : {}; } catch { return {}; } };
const STATIK = {
  '/': 'index.html', '/detail': 'izleme.html', '/engel': 'engel.html', '/login': 'login.html',
  '/app.js': 'app.js', '/i18n.js': 'i18n.js', '/saat.js': 'saat.js', '/izleme.js': 'izleme.js', '/engel.js': 'engel.js',
  '/styles.css': 'styles.css', '/manifest.json': 'manifest.json',
};

/** Engel ekleme: metinden kural türünü çıkarır (ajanın "otomatik"i gibi, basitleştirilmiş). */
function kuralEkle({ metin, tur }) {
  const m = String(metin || '').trim();
  const video = /[?&]v=([A-Za-z0-9_-]{11})/.exec(m) || /youtu\.be\/([A-Za-z0-9_-]{11})/.exec(m);
  const kanalLink = /youtube\.com\/@([\w.-]+)/.exec(m);
  let kural;
  if (tur === 'kelime' || (!tur && !video && !kanalLink && !/^https?:/.test(m))) kural = { tur: 'kelime', deger: m.toLocaleLowerCase('tr') };
  else if (tur === 'kanal' || kanalLink) kural = { tur: 'kanal', deger: kanalLink ? kanalLink[1] : video ? `Örnek Kanal (${video[1].slice(0, 4)})` : m, ...(kanalLink ? { link: `https://www.youtube.com/@${kanalLink[1]}` } : {}) };
  else kural = { tur: 'video', videoId: video[1], baslik: `Örnek video (${video[1]})`, kanal: 'Örnek Kanal', link: `https://www.youtube.com/watch?v=${video[1]}` };
  const varmis = engel.kurallar.find((k) => k.tur === kural.tur && (k.tur === 'video' ? k.videoId === kural.videoId : k.deger === kural.deger));
  if (varmis) return engelYaniti({ kural: varmis, varmis: true });
  const yeni = { id: yeniId(), ...kural };
  engel.kurallar.push(yeni);
  engel.islemler.unshift({ zaman: Date.now(), ne: 'eklendi', tur: yeni.tur, deger: yeni.deger || yeni.baslik, kaynak: 'panel' });
  return engelYaniti({ kural: yeni, varmis: false });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://demo');
  const p = u.pathname;
  try {
    DIL = /^tr\b/i.test(String(req.headers['accept-language'] || '')) ? 'tr' : 'en';
    if (p === '/logout') { res.writeHead(req.method === 'POST' ? 303 : 302, { Location: '/' }); return res.end(); }
    if (p.startsWith('/logolar/')) {   // gerçek logolar yayıncıların markası — demoda adından üretilmiş rozet
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(rozet(decodeURIComponent(p.slice('/logolar/'.length).replace(/\.svg$/, ''))));
    }
    if (STATIK[p] || p.startsWith('/icons/')) {
      const dosya = STATIK[p] ? join(WEB, STATIK[p]) : join(WEB, 'icons', p.slice('/icons/'.length).replace(/[^a-z0-9.-]/gi, ''));
      res.writeHead(200, { 'Content-Type': TIPLER[extname(dosya)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(await readFile(dosya));
    }
    if (p === '/api/ayar') return json(res, { saatDilimi: TZ });
    if (p.startsWith('/api/bildirim/')) return json(res, { error: 'demo' }, 404);   // bildirim düğmesi gizli kalır
    if (!p.startsWith('/api/tv/')) { res.writeHead(404); return res.end('Bulunamadı'); }

    const yol = p.slice('/api/tv'.length);
    const tv = bul(u.searchParams.get('tv'));
    if (req.method === 'GET') {
      if (yol === '/tvler') { vaktiGelenler(); kilitYaniti(); return json(res, { tvler }); }
      if (yol === '/favoriler') {
        const k = (ad) => ({ ad, no: no(ad), logo: `/logolar/${encodeURIComponent(ad)}.svg` });
        return json(res, { kanallar: FAV.map(k), diger: DIGER.map(k) });
      }
      if (yol === '/epg') return json(res, { kanallar: FAV.map((ad) => ({ ad, no: no(ad), ...simdiSonra(ad), kaynak: 'demo' })) });
      if (yol === '/akis') return json(res, { simdi: Date.now(), kanallar: [...FAV, ...DIGER].map((ad) => ({ ad, logo: `/logolar/${encodeURIComponent(ad)}.svg`, programlar: akisi(ad).filter((x) => x.bit > Date.now()) })) });
      if (yol === '/zamanlayici') return json(res, liste());
      if (yol === '/ses') return json(res, tv && tv.acik ? { seviye: ses[tv.id], sessiz: false } : { seviye: null });
      if (yol === '/izleme') return json(res, izleme(u));
      if (yol === '/kilit') return json(res, kilitYaniti());
      if (yol === '/engel') return json(res, engelYaniti());
      if (yol === '/ekran' || yol === '/ekran-akis') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        return res.end(ekran(tv || tvler[0]));
      }
      return json(res, { error: 'demo: yok' }, 404);
    }
    if (req.method === 'DELETE') {
      const e = /^\/engel\/([a-f0-9]{8})$/.exec(yol);
      if (e) {
        const k = engel.kurallar.find((x) => x.id === e[1]);
        if (!k) return json(res, { error: 'kural bulunamadı' }, 404);
        engel.kurallar = engel.kurallar.filter((x) => x !== k);
        engel.islemler.unshift({ zaman: Date.now(), ne: 'silindi', tur: k.tur, deger: k.deger || k.baslik, kaynak: 'panel' });
        return json(res, engelYaniti());
      }
      const k = /^\/kilit\/([a-z0-9-]{1,20})$/.exec(yol);
      if (k && bul(k[1])) {
        delete kilit.kilitler[k[1]];
        kilit.olaylar.unshift({ id: yeniId(), zaman: Date.now(), tv: k[1], ne: 'acildi', kaynak: 'panel' });
        return json(res, kilitYaniti());
      }
      return json(res, { error: 'demo: yok' }, 404);
    }
    const g = await govde(req);
    const t = bul(g.tv);
    if (['/kanal', '/giris', '/ac'].includes(yol) && t && kilit.kilitler[t.id] && !t.acik) return json(res, { error: `${t.ad} kilitli — Engeller ve kilit sayfasından açın` }, 423);
    if (yol === '/kanal' && t) {
      Object.assign(t, { acik: true, kaynak: 'canli', cihaz: 'lg', ekranKapali: false, uygulama: 'com.webos.app.livetv', kanal: { no: no(g.ad), ad: g.ad } });
      return json(res, { ok: true, kanal: { no: no(g.ad), ad: g.ad, acildi: false } });
    }
    if (yol === '/giris' && t) {
      Object.assign(t, { acik: true, kaynak: g.hedef, cihaz: g.hedef === 'canli' ? 'lg' : 'apple' });
      return json(res, { ok: true, kaynak: g.hedef, cihaz: t.cihaz });
    }
    if (yol === '/ac' && t) { Object.assign(t, { acik: true, kaynak: 'canli', cihaz: 'lg', kanal: { no: 1, ad: FAV[0] } }); return json(res, { ok: true, uyandirildi: true }); }
    if (yol === '/kapat' && t) { t.acik = false; return json(res, { ok: true }); }
    if (yol === '/ekran-guc' && t) { t.ekranKapali = !!g.kapali; return json(res, { ok: true, ekranKapali: t.ekranKapali }); }
    if (yol === '/ses' && t) { ses[t.id] = Math.min(100, Math.max(0, Number(g.seviye) || 0)); return json(res, { ok: true, seviye: ses[t.id] }); }
    if (yol === '/kilit' && t) {
      kilit.kilitler[t.id] = { bitis: g.dk ? Date.now() + g.dk * DAKIKA : null, kapsam: g.kapsam || 'tv+apple' };
      kilit.olaylar.unshift({ id: yeniId(), zaman: Date.now(), tv: t.id, ne: 'kilitlendi', dk: g.dk || null, kapsam: kilit.kilitler[t.id].kapsam, kaynak: 'panel' });
      if (t.acik) t.acik = false;   // ajan açık TV'de kilit mesajını gösterip kapatır
      return json(res, kilitYaniti());
    }
    if (yol === '/kilit/ayar') { kilit.mesaj = metinKirp(g.mesaj); return json(res, kilitYaniti()); }
    if (yol === '/engel') return json(res, kuralEkle(g));
    if (yol === '/engel/ayar') {
      if (typeof g.acik === 'boolean' && g.acik !== engel.acik) { engel.acik = g.acik; engel.islemler.unshift({ zaman: Date.now(), ne: g.acik ? 'acildi' : 'kapatildi', kaynak: 'panel' }); }
      if (Array.isArray(g.mesaj)) { engel.mesaj = metinKirp(g.mesaj); engel.islemler.unshift({ zaman: Date.now(), ne: 'mesaj-degisti', kaynak: 'panel' }); }
      if (Array.isArray(g.uyari)) { engel.uyari = metinKirp(g.uyari); engel.islemler.unshift({ zaman: Date.now(), ne: 'uyari-degisti', kaynak: 'panel' }); }
      return json(res, engelYaniti());
    }
    if (yol === '/zamanlayici') {
      const id = yeniId();
      if (g.islem === 'geri-don') {
        gorevler = gorevler.filter((x) => !(x.tur === 'geri-don' && x.tv === g.tv));
        gorevler.push({ id, tur: 'geri-don', tv: g.tv, kanal: bul(g.tv)?.kanal, dk: g.dk, an: Date.now() + g.dk * DAKIKA, etkin: true });
      } else if (g.islem === 'ekle') {
        const [y, m, d] = String(g.zaman.tarih || gunOf(Date.now())).split('-').map(Number);
        const [sa, dk] = String(g.zaman.saat || '00:00').split(':').map(Number);
        const an = g.zaman.tur === 'sonra' ? Date.now() + g.zaman.dk * DAKIKA
          : g.zaman.tur === 'tek' ? yerelAn(y, m, d, sa, dk) : sonraki(sa, dk);
        gorevler.push({ id, tur: g.zaman.tur === 'haftalik' ? 'haftalik' : 'tek', tv: g.tv, kanal: { ad: g.kanal }, an, saat: g.zaman.saat, gunler: g.zaman.gunler, tvKapaliysa: g.tvKapaliysa, etiket: g.etiket || null, etkin: true });
      } else {
        const x = gorevler.find((y) => y.id === g.id);
        if (g.islem === 'uzat' && x) x.an += (g.dk || 1) * DAKIKA;
        if (g.islem === 'etkin' && x) x.etkin = !!g.acik;
        if ((g.islem === 'sil' || g.islem === 'hemen') && x) {
          gorevler = gorevler.filter((y) => y.id !== g.id);
          gecmis.unshift({ ...x, bitti: Date.now(), sonuc: g.islem === 'sil' ? 'iptal' : 'ok' });
        }
      }
      return json(res, { ok: true, ...liste() });
    }
    return json(res, { ok: true });   // tuşlar, mesaj, imleç…: demoda etkisiz
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}).listen(PORT, HOST, () => console.log(`LG Remote demo → http://${HOST}:${PORT}  (sahte veriler; gerçek TV'ye bağlanmaz · saat dilimi ${TZ})`));
