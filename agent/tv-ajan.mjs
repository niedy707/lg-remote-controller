#!/usr/bin/env node
/**
 * TV ajanı — evdeki LG TV'leri (ve bağlı Apple TV'yi) kumandaya açan küçük HTTP servisi.
 *
 * NEDEN AYRI BİR AJAN: TV'ler yalnız ev ağından konuşuyor (`wss://<ip>:3001`). Ajan ev ağında
 * 7/24 açık duran küçük bir bilgisayarda (ör. Raspberry Pi) çalışır; internete açık geçit
 * (server/sunucu.cjs) ona VPN ya da yerel ağ üzerinden, bearer belirteciyle istek atar.
 *
 * YALNIZ İZİNLİ İŞLER: durum, ekran görüntüsü, izinli kumanda tuşları, kanal değiştirme,
 * açma (Wake-on-LAN), kapatma. Ham SSAP geçişi YOK — geçit ele geçirilse bile TV'ye keyfi
 * istek gönderilemez.
 *
 * KALICI BAĞLANTI: her tuşta yeniden TLS + eşleşme yapmak ~0,2-0,4 sn. Bağlantı açık
 * tutulur, koparsa ilk istekte yeniden kurulur. TV bekleme modundayken bağlantıyı kabul
 * edip ilk mesajda kapatıyor (ölçüldü) — bu "kapalı" sayılır. Bağlantı yalnız wss:3001 üzerinden
 * kurulur; düz ws:3000'e düşmek eşleşme anahtarını ağda açık metin gönderir (TV_AJAN_DUZ_WS=1 ile açılır).
 *
 * YAYIN AKIŞI TV'DEN DEĞİL: TV'lerin verdiği akış güvenilmez çıktı (başka kanallar için ertesi günün
 * akışı — ölçüldü). "Şu an ne var" bilgisi rehberden gelir (`net/rehber.mjs`: digiturk, yedek tvplus);
 * ev ağındaki bu ajan çeker çünkü digiturk veri merkezi IP'lerine 403 dönüyor.
 *
 * Ortam:
 *   TV_AJAN_TOKEN       zorunlu, ≥ 32 karakter (geçitte de aynısı)
 *   TV_AJAN_HOST        dinlenecek adres (varsayılan 127.0.0.1; geçit başka makinedeyse VPN/yerel IP)
 *   TV_AJAN_PORT        varsayılan 3027
 *   TV_AJAN_TVLER       TV listesi (varsayılan <kök>/tv-ajan.tvler.json — git'e girmez)
 *   TV_AJAN_ANAHTARLAR  eşleşme anahtarları (varsayılan <kök>/.lgtv-clients.json)
 *   TV_AJAN_DURUM       durum dizini: rehber önbelleği, zamanlayıcı, kilit/engel kayıtları, izleme kaydı,
 *                       Apple TV kimlikleri (varsayılan: systemd STATE_DIRECTORY, yoksa data/)
 *   TV_AJAN_TZ          yerel saat dilimi, IANA adı (varsayılan Europe/Istanbul): zamanlayıcı saatleri, izleme
 *                       kaydının günleri ve saat dağılımı, ekranda gösterilen saatler (bkz. net/saat.mjs)
 *   TV_AJAN_IZLEME      1 → izleme kaydı açık (hangi TV ne zaman açık, ne izlendi; kişisel veri, durum dizininde)
 *   TV_AJAN_PYATV       pyatv kurulu Python (varsayılan /opt/pyatv/bin/python3; yoksa Apple TV özellikleri kapalı)
 *   TV_AJAN_PYTHON      PIL kurulu sistem Python'u, ekran hareketi ölçümü için (varsayılan /usr/bin/python3)
 *   TV_AJAN_BILGISIZ_UYGULAMA  Apple TV'de oynatma bilgisi vermeyen, ekranda hareket olan uygulamanın kayıttaki
 *                       adı (varsayılan "Apple TV" — hangi uygulama olduğu ekrandan anlaşılamıyor)
 *   TV_AJAN_DUZ_WS      1 → wss:3001 olmazsa düz ws:3000'e düşülür (yalnız wss'siz eski modeller için; güvensiz)
 *
 * TV listesi biçimi: [{ "id": "living", "ad": "Living room", "ip": "…", "mac": "aa:bb:…",
 *                       "appletv": { "ip": "…", "id": "…", "giris": "com.webos.app.hdmi2" } }, …]
 * `mac` uzaktan açmak (Wake-on-LAN) için; yoksa kapalı TV açılamaz. `appletv` isteğe bağlı (pyatv eşleştirmesi
 * gerekir); `giris` verilmezse Apple TV'nin bağlı olduğu HDMI girişi TV'nin giriş adından ("Apple…") bulunur.
 *
 * Uçlar (hepsi `Authorization: Bearer <belirteç>` ister; `X-Istemci: panel` başlığı işlem kaydında kaynağı
 * "panel" yapar, yoksa "dogrudan"):
 *   GET  /tvler                     → her TV'nin durumu (+ açık kanalda şu an ne var, kilit) + saatDilimi/ofsetDk
 *   GET  /ekran?tv=<id>             → JPEG
 *   POST /tus      {tv, tus}        → kumanda tuşu
 *   POST /isaretci {tv, dx, dy} | {tv, tikla: true} → Magic Remote imleci (kumandadaki dokunmatik yüzey)
 *   POST /tus      {tv, tus, cihaz: "apple"}  → tuş Apple TV'ye (pyatv, Companion)
 *   POST /metin    {tv, metin}      → Apple TV'de odaktaki yazı alanına metin
 *   POST /kanal    {tv, ad | no}    → kanala geç — TV kapalıysa ÖNCE AÇAR
 *   POST /ac       {tv}             → TV'yi aç (Wake-on-LAN, açılana kadar bekler)
 *   POST /giris    {tv, hedef}      → kaynak menüsü: "canli", "apple" (HDMI girişi), "netflix" / "prime" / "disney" (TV uygulaması)
 *   POST /ekran-guc {tv, kapali}    → ekranı kapat / aç (ses devam eder)
 *   POST /bildirim {tv, mesaj, sureSn, ortada?} → TV ekranına mesaj (sureSn boyunca yenilenerek; ortada: true →
 *                                     ekranın ortasında çok satırlı uyarı penceresi, en çok 5 satır / 300 karakter)
 *   GET  /ses?tv=  · POST /ses {tv, seviye 0-100}  → ses düzeyi
 *   GET  /ekran-akis?tv=&sn=&fps=   → canlı önizleme: art arda JPEG (multipart); TV başına tek çekim, çok izleyici
 *   POST /akis     {adlar[], saat}  → kanalların yayın akışı (şu andan `saat` saat ileri; rehberden)
 *   GET  /zamanlayici               → geri dön sayaçları + program görevleri + geçmiş (+ saatDilimi, ofsetDk)
 *   POST /zamanlayici {islem, …}    → geri-don | ekle | uzat | sil | etkin | hemen (bkz. net/zamanlayici.mjs)
 *   POST /cozumle  {tv, adlar[]}    → adları o TV'deki kanal numaralarına çevir
 *   POST /epg      {tv, adlar[]}    → bu kanallarda şu an ve sonra ne var (rehberden)
 *   POST /kapat    {tv}             → TV'yi kapat
 *   GET  /izleme?tv=&gun=YYYY-AA-GG&gunSayisi=N → izleme geçmişi + özet (TV_AJAN_IZLEME=1 ise); YouTube
 *                                     kesitlerinde bulunabildiyse `youtube` = video kimliği
 *   GET  /kilit  · POST /kilit {tv, dk?, kapsam?}  · DELETE /kilit?tv=  · POST /kilit/ayar {mesaj}
 *                                   → TV kilidi (dk yok → süresiz; kapsam tv | tv+apple) — net/kilit.mjs
 *   GET  /engel  · POST /engel {metin, tur?}  · DELETE /engel?id=  · POST /engel/ayar {acik?, mesaj?, uyari?}
 *                                   → YouTube engelleri (kurallar, son engellenenler, ekran metinleri) — net/engel.mjs
 *   GET  /kanal-sirasi?tv= · GET /kanal-listesi?tv= · POST /kanal-onerisi · /kanal-sirasi-kaydet · /kanal-sirala ·
 *        /kanal-sirala-durdur  → kanal listesi düzenleme (bkz. net/kanal-sirasi.mjs)
 */

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, readdir, unlink, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LgSsap } from './net/lg-ssap.mjs';
import { LgInput } from './net/lg-input.mjs';
import { captureScreen } from './net/lg-screen.mjs';
import { kanalBul } from './net/kanal-bul.mjs';
import { Rehber, trGunu } from './net/rehber.mjs';
import { wolGonder } from './net/wol.mjs';
import { Zamanlayici } from './net/zamanlayici.mjs';
import { AppleTvKopru } from './net/atv-kopru.mjs';
import { KanalSirasi, ANAHTAR as KANAL_ANAHTARI } from './net/kanal-sirasi.mjs';
import { IzlemeKaydi, ozetle, trGun, gunAraligi } from './net/izleme.mjs';
import { YoutubeBulucu, ayir, anahtar as ytAnahtar } from './net/youtube-bul.mjs';
import { EngelListesi, EngelBekcisi } from './net/engel.mjs';
import { TvKilidi, KilitBekcisi } from './net/kilit.mjs';
import { SAAT_DILIMI, saatDk, saatBilgisi } from './net/saat.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');   // depo kökü: yerel ayar dosyaları (git dışı) burada

const TOKEN = process.env.TV_AJAN_TOKEN || '';
const HOST = process.env.TV_AJAN_HOST || '127.0.0.1';
const PORT = Number(process.env.TV_AJAN_PORT || 3027);
const TVLER_YOLU = process.env.TV_AJAN_TVLER || resolve(ROOT, 'tv-ajan.tvler.json');
// Apple TV (pyatv): kurulu Python ve yardımcı betik. Kimlik dosyası DURUM_DIZINI/pyatv.conf (eşleştirme yazar).
const PYATV_PYTHON = process.env.TV_AJAN_PYATV || '/opt/pyatv/bin/python3';
const ATV_YARDIMCI = resolve(HERE, 'atv-yardimci.py');
// Apple TV'de oynatma bilgisi YAYINLAMAYAN uygulama (bazı IPTV oynatıcıları): ekranda hareket varsa bu adla
// kaydedilir. Hangi uygulama olduğu ekrandan bilinemez (bir uygulamanın menüsündeki otomatik fragmanlar da
// hareketli) — bu yüzden varsayılan ad uygulama adı değil "Apple TV".
const SISTEM_PYTHON = process.env.TV_AJAN_PYTHON || '/usr/bin/python3';
const EKRAN_HAREKET = resolve(HERE, 'ekran-hareket.py');
const BILGISIZ_UYGULAMA = process.env.TV_AJAN_BILGISIZ_UYGULAMA || 'Apple TV';
const HAREKET_ESIGI = 4;   // 96×54 gri ortalama fark: oynayan video 30–60, durağan ~0 (ölçüldü)
const ANAHTAR_YOLU = process.env.TV_AJAN_ANAHTARLAR || resolve(ROOT, '.lgtv-clients.json');
const DURUM_DIZINI = process.env.TV_AJAN_DURUM || process.env.STATE_DIRECTORY || resolve(ROOT, 'data');
const DUZ_WS = process.env.TV_AJAN_DUZ_WS === '1';
const execFileP = promisify(execFile);

/** Kumandadan gönderilebilecek tuşlar. Liste dışı ad reddedilir. */
export const IZINLI_TUSLAR = new Set([
  'UP', 'DOWN', 'LEFT', 'RIGHT', 'ENTER', 'BACK', 'EXIT', 'HOME', 'MENU', 'INFO', 'GUIDE', 'LIST',
  'CHANNELUP', 'CHANNELDOWN', 'VOLUMEUP', 'VOLUMEDOWN', 'MUTE',
  'RED', 'GREEN', 'YELLOW', 'BLUE',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'PLAY', 'PAUSE', 'REWIND', 'FASTFORWARD',   // uygulama kumandası (Netflix vb.)
]);

/**
 * Giriş geçişinin hedefleri — keyfi uygulama başlatılamaz. Kaynak menüsü: canlı yayın, Apple TV girişi ve üç
 * uygulama. LG kimlikleri bir webOS 26 TV'nin listLaunchPoints'inden, Apple TV kimlikleri tvOS app_list'inden.
 * Apple TV eşleştirilmişse (pyatv) uygulama Apple TV'de açılır (uygulamaları TV'ninkinden akıcı); Apple TV'ye
 * ulaşılamazsa TV'nin kendi uygulaması.
 */
export const UYGULAMALAR = {
  netflix: { ad: 'Netflix', lg: 'netflix', atv: 'com.netflix.Netflix' },
  prime: { ad: 'Amazon Prime', lg: 'amazon', atv: 'com.amazon.aiv.AIVApp' },
  disney: { ad: 'Disney+', lg: 'com.disney.disneyplus-prod', atv: 'com.disney.disneyplus' },
};
// Uygulama kumandası Apple TV girişindeyken tuşları Apple TV'ye gönderir (LG adı → pyatv tuşu).
export const ATV_TUSLARI = {
  UP: 'up', DOWN: 'down', LEFT: 'left', RIGHT: 'right', ENTER: 'select', BACK: 'menu', HOME: 'home',
  PLAY: 'play', PAUSE: 'pause', REWIND: 'skip_backward', FASTFORWARD: 'skip_forward',
};
const LG_KAYNAK = Object.fromEntries(Object.entries(UYGULAMALAR).map(([k, u]) => [u.lg, k]));
export const GIRIS_HEDEFLERI = new Set(['canli', 'apple', ...Object.keys(UYGULAMALAR)]);
const CANLI_TV = 'com.webos.app.livetv';

const LISTE_OMRU_MS = 10 * 60 * 1000;
// TV bildirimi (toast) ekranda ~4-5 sn kalıyor (ölçüldü: 3,4 sn'de var, 5,8 sn'de yok) →
// daha uzun gösterim için bu aralıkla yenilenir.
const BILDIRIM_TAZELEME_MS = 4500;
const AKIS_EN_UZUN_SN = 180;
const AKIS_VARSAYILAN_FPS = 1;   // ölçüm: kare ~100-170 KB → 1 kare/sn ~8,5 MB/dk
const UYANMA_MS = 40 * 1000;            // açılış + ağın gelmesi + SSAP'ın hazır olması
const TUS_BAYAT_MS = 3000;              // sırada bundan uzun bekleyen kumanda tuşu basılmaz (birikip topluca gitmesin)
const KANAL_SIRA_GOVDE = 64 * 1024;     // tam kanal listesi (~660 anahtar ≈ 8 KB) sığsın; diğer uçlar 4 KB
const MAC_KALIBI = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

/**
 * TV'nin kumanda portu açık mı? Kapalı (fişte değil / ağda değil) TV'ye bağlanmaya çalışmak
 * zaman aşımlarını tek tek beklemek demek: varsayılan denemelerle ~41 sn sürdü ve geçit
 * 15 sn'de vazgeçti (ölçüldü). Önce kısa bir TCP yoklaması yapılır.
 */
function portAcik(ip, port, ms = 800) {
  return new Promise((ok) => {
    const s = net.connect({ host: ip, port });
    const bitir = (v) => { s.destroy(); ok(v); };
    s.setTimeout(ms, () => bitir(false));
    s.once('connect', () => bitir(true));
    s.once('error', () => bitir(false));
  });
}

function zamanAsimi(soz, ms, ne) {
  let t;
  return Promise.race([
    soz,
    new Promise((_, red) => { t = setTimeout(() => red(new Error(`${ne}: ${ms / 1000} sn içinde yanıt yok`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/**
 * LG güç durumları: kapatılan TV ağ bağlantısını açık tutan beklemeye geçer ("Active Standby"; webOS 26'da
 * ölçüldü). O hâldeyken AÇIK KALAN SSAP oturumu yanıt vermeyi sürdürür (ön planda hâlâ "livetv" der), yeni
 * oturumu ise TV kapatır. Yalnız "Screen Off"a bakan ilk sürüm bekleyen TV'yi açık sandı: kanal düğmesi
 * uyandırmadan kanal değiştirdi, ekran kapalı kaldı. "Screen Off" (ekran kapalı, ses açık — bizim düğmemiz)
 * ve "Screen Saver" AÇIK sayılır.
 */
const KAPALI_GUC = /standby|suspend|power ?off/i;
export const gucKapaliMi = (r) => !!r && (KAPALI_GUC.test(String(r.state || '')) || KAPALI_GUC.test(String(r.processing || '')));

/**
 * Kapalı TV'yi uyandırma döngüsü (TV'den bağımsız, test edilebilir).
 * Hazırsa hiç paket göndermez. Değilse sihirli paketi gönderir, `araMs`'de bir hazır mı diye
 * bakar, `wolAraMs`'de bir paketi yineler (Wi-Fi uykusundaki kart ilk paketi kaçırabilir).
 */
export async function uyandir({ hazirMi, wol, sureMs = UYANMA_MS, araMs = 1500, wolAraMs = 5000, bekle = sleep, simdi = () => Date.now() }) {
  if (await hazirMi()) return { uyandirildi: false, wolSayisi: 0 };
  const bitis = simdi() + sureMs;
  let sonWol = -Infinity;
  let wolSayisi = 0;
  while (simdi() < bitis) {
    if (simdi() - sonWol >= wolAraMs) { await wol(); sonWol = simdi(); wolSayisi++; }
    await bekle(araMs);
    if (await hazirMi()) return { uyandirildi: true, wolSayisi };
  }
  return { uyandirildi: false, zamanAsimi: true, wolSayisi };
}

export class Tv {
  constructor({ id, ad, ip, mac, appletv }, anahtar, { rehber = null, wol = wolGonder, uyanma = {}, teshisDizini = null, log = () => {}, atv = null, hareketOlc = null } = {}) {
    this.id = id;
    this.ad = ad;
    this.ip = ip;
    this.mac = mac || null;
    this.appletv = appletv || null;  // { ip, id, giris? } — bu TV'ye bağlı Apple TV (pyatv)
    this.atv = atv;                  // AppleTvKopru (tüm TV'ler için tek)
    this.kilit = null;               // TvKilidi (net/kilit.mjs) — ana akışta bağlanır
    this.hareketOlc = appletv ? hareketOlc : null;   // (jpegA, jpegB) → fark; bilgi vermeyen uygulama için
    this._bilgisiz = null;
    this.hareketAraMs = 5000;        // iki ekran görüntüsü arası
    this.appleSon = null;            // Apple TV'de en son açtırılan uygulama (netflix…), girişten çıkınca silinir
    this.anahtar = anahtar;
    this.rehber = rehber;
    this.wol = wol;
    this.uyanma = uyanma;           // testler için: { sureMs, araMs, wolAraMs, bekle, simdi }
    this.teshisDizini = teshisDizini; // uyanmada kanal tutmazsa ekran görüntüsü buraya
    this.log = log;
    this.ssap = null;
    this.input = null;
    this._baglaniyor = null;
    this.kuyruk = Promise.resolve();
    this.liste = null;
    this.listeZamani = 0;
    this.uygulamaAdlari = null;
    this.duzenleniyor = false;      // kanal listesi düzenleme işi sürüyor (net/kanal-sirasi.mjs)
    this._sonDurum = null;
    // Apple TV'nin bağlı olduğu HDMI girişinin uygulama kimliği. Yapılandırmada `appletv.giris` verilmişse o;
    // yoksa LG'nin giriş adından ("Apple TV", "Apple OTT") bulunur.
    this.appleUygulama = (appletv && appletv.giris) || null;
  }

  /** Aynı TV'ye işler sırayla gider: iki tuş birbirinin ortasına girmez. */
  sirayla(is) {
    const soz = this.kuyruk.then(is, is);
    this.kuyruk = soz.catch(() => {});
    return soz;
  }

  birak() {
    try { this.input?.close(); } catch { /* yok say */ }
    try { this.ssap?.close(); } catch { /* yok say */ }
    this.input = null;
    this.ssap = null;
  }

  /** Eşzamanlı çağrılar tek bağlantı kurar (durum sorgusu sıraya girmiyor, uyandırmayla yarışabilir). */
  baglan() {
    if (this.ssap?.ws && !this.ssap.ws.closed) return Promise.resolve(this.ssap);
    if (!this._baglaniyor) this._baglaniyor = this._baglan().finally(() => { this._baglaniyor = null; });
    return this._baglaniyor;
  }

  async _baglan() {
    this.birak();
    if (!this.anahtar) throw new HttpHata(409, `${this.ad}: eşleşme anahtarı yok`);
    if (!(await portAcik(this.ip, 3001))) throw new HttpHata(503, `${this.ad}: TV kapalı ya da ağda değil`);
    const s = new LgSsap(this.ip);
    // Düz ws'ye düşülmüyorsa wss el sıkışmasına biraz daha süre tanınır (yeni uyanan TV yavaş yanıt veriyor).
    await s.connect({ timeoutMs: DUZ_WS ? 3000 : 5000, retries: 0, duzIzin: DUZ_WS });
    // Anahtar varken TV onay sormaz. Sorarsa (anahtar geçersiz) beklemeyiz: zaman aşımı.
    await zamanAsimi(s.register(this.anahtar, { timeoutMs: 6000 }), 7000, 'eşleşme');
    s.ws.on('close', () => { if (this.ssap === s) this.birak(); });
    this.ssap = s;
    return s;
  }

  async iste(uri, payload, ms = 5000) {
    const s = await this.baglan();
    return s.request(uri, payload, { timeoutMs: ms });
  }

  async kumanda() {
    if (this.input && !this.input.conn.closed) return this.input;
    const s = await this.baglan();
    this.input = await zamanAsimi(LgInput.open(s, { timeoutMs: 4000 }), 5000, 'kumanda soketi');
    return this.input;
  }

  async hazirMi() {
    try { await this.baglan(); } catch (e) {
      if (e instanceof HttpHata && e.kod === 409) throw e;   // anahtar yok: uyandırmak çözmez
      return false;
    }
    // Bağlantı kurulu olabilir ama TV beklemede (yukarıdaki not): o zaman hazır değil, bağlantı bırakılır.
    if (gucKapaliMi(await this.gucDurumu())) { if (!this.duzenleniyor) this.birak(); return false; }
    return true;
  }

  /** getPowerState yanıtı; uç yoksa (eski webOS) ya da hata olursa null — o zaman güç bilinmiyor sayılır. */
  async gucDurumu() {
    try { return await this.iste('ssap://com.webos.service.tvpower/power/getPowerState', null, 2000); } catch { return null; }
  }

  /**
   * TV kilitliyse (ebeveyn denetimi, net/kilit.mjs) açmaya yol açabilecek her komut burada durur: 423.
   * Kumandanın kanal/giriş/açma uçları ve zamanlayıcı `uyan()`dan, Apple TV komutları buradan geçer.
   */
  kilitDenetle() {
    const k = this.kilit?.bilgi(this.id);
    if (!k) return;
    const saat = k.bitis ? saatDk(k.bitis) : null;
    throw new HttpHata(423, `${this.ad} kilitli${saat ? ` (${saat}'e kadar)` : ''} — açılamaz. Kilidi "Engeller" sayfasından açabilirsiniz.`);
  }

  /** Kilit bekçisi için: TV şu an açık mı. Beklemede ya da ulaşılamıyorsa false. Güç durumu ucu olmayan TV'de ön uygulamaya bakılır. */
  async acikMi() {
    const g = await this.gucDurumu();
    if (g) return !gucKapaliMi(g);
    try { return !!(await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo', null, 2000)).appId; } catch { return false; }
  }

  /** TV kapalıysa açar ve kumandaya hazır olana kadar bekler; açıksa hemen döner. */
  async uyan() {
    this.kilitDenetle();
    const r = await uyandir({
      ...this.uyanma,
      hazirMi: () => this.hazirMi(),
      wol: () => {
        if (!this.mac) throw new HttpHata(409, `${this.ad}: MAC adresi tanımlı değil — uzaktan açılamaz`);
        return this.wol(this.mac, this.ip);
      },
    });
    if (r.zamanAsimi) {
      throw new HttpHata(504, `${this.ad} açılmadı (${r.wolSayisi} uyandırma paketi gönderildi). TV ayarlarında "Mobil TV Açık / Wi-Fi ile aç" açık olmalı.`);
    }
    return r;
  }

  /**
   * Uygulama ve giriş adları (TV başına bir kez). İsteklerden biri başarısızsa (yeni uyanan TV ilk sorulara
   * zaman aşımıyla düşebiliyor) eksik harita önbelleğe ALINMAZ: yoksa Apple TV girişi süreç ömrü boyunca
   * "bulunamadı" kalırdı. Eksik harita yine döner — çağıran adsız da çalışır.
   */
  async adlar() {
    if (this.uygulamaAdlari) return this.uygulamaAdlari;
    const m = new Map();
    let eksik = false;
    try {
      const r = await this.iste('ssap://com.webos.applicationManager/listLaunchPoints');
      for (const lp of r.launchPoints || []) if (lp.id && lp.title) m.set(lp.id, lp.title);
    } catch { eksik = true; }
    try {
      // HDMI girişlerinin TV'de verilen adı ("Apple TV 1") burada.
      const r = await this.iste('ssap://tv/getExternalInputList');
      for (const d of r.devices || []) {
        if (d.appId && d.label) m.set(d.appId, d.label);
        // Apple TV hangi HDMI'da: girişe verilen ad ("Apple OTT", "Apple TV 1").
        if (!this.appleUygulama && d.appId && /apple/i.test(d.label || '')) this.appleUygulama = d.appId;
      }
    } catch { eksik = true; }
    if (!eksik) this.uygulamaAdlari = m;
    return m;
  }

  async durum() {
    const d = await this._durum();
    this._sonDurum = { zaman: Date.now(), acik: !!d.acik, cihaz: d.cihaz || null };   // engel bekçisi okur
    return d;
  }

  async _durum() {
    try {
      const guc = await this.gucDurumu();
      if (gucKapaliMi(guc)) {   // kapatılmış ama ağda bekliyor: kapalı göster, açmak uyandırma ister
        if (!this.duzenleniyor) this.birak();
        return { id: this.id, ad: this.ad, acik: false, acilabilir: !!this.mac, sebep: `${this.ad}: beklemede (${guc.state || guc.processing})` };
      }
      const on = await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo');
      const adlar = await this.adlar();
      let kanal = null;
      if (on.appId === CANLI_TV) {
        try {
          const c = await this.iste('ssap://tv/getCurrentChannel');
          kanal = { no: Number(c.channelNumber), ad: c.channelName, program: null };
          if (this.rehber && kanal.ad) {
            try { kanal.program = (await zamanAsimi(this.rehber.kanal(kanal.ad), 5000, 'rehber'))?.simdi || null; } catch { /* rehber yok */ }
          }
        } catch { /* kanal okunamadı */ }
      }
      const appleda = !!on.appId && on.appId === this.appleUygulama;
      if (!appleda) this.appleSon = null;
      const kaynak = on.appId === CANLI_TV ? 'canli' : (appleda ? (this.appleSon || 'apple') : (LG_KAYNAK[on.appId] || 'diger'));
      const cihaz = appleda ? 'apple' : 'lg';
      const oynayan = appleda ? await this.appleOynayan() : null;
      const ekranKapali = guc ? guc.state === 'Screen Off' : null;
      return { id: this.id, ad: this.ad, acik: true, uygulama: on.appId || null, uygulamaAdi: adlar.get(on.appId) || null, kaynak, cihaz, appleTv: this.appleTvVar(), ...(oynayan ? { oynayan } : {}), kanal, ekranKapali };
    } catch (e) {
      // Kanal listesi düzenlenirken bağlantı işin bağlantısıdır: tek bir yavaş yanıt işi yarıda kesmesin.
      if (!this._baglaniyor && !this.duzenleniyor) this.birak();
      return { id: this.id, ad: this.ad, acik: false, acilabilir: !!this.mac, sebep: String(e.message || e).split('\n')[0].slice(0, 120) };
    }
  }

  /** Uydu TV kanalları (radyo hariç), numara sırasıyla. 10 dk önbellekli. */
  async kanallar({ taze = false } = {}) {
    if (!taze && this.liste && Date.now() - this.listeZamani < LISTE_OMRU_MS) return this.liste;
    const r = await this.iste('ssap://tv/getChannelList', null, 15000);
    this.liste = (r.channelList || [])
      .filter((c) => !c.Radio)
      .map((c) => ({ no: Number(c.channelNumber), ad: c.channelName, channelId: c.channelId }))
      .sort((a, b) => a.no - b.no);
    this.listeZamani = Date.now();
    return this.liste;
  }

  /** TV canlı yayında mı (ön planda livetv). Okunamazsa true: bilinmeyen durumda görev engellenmez. */
  async canliMi() {
    try { return (await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo', null, 3000)).appId === CANLI_TV; } catch { return true; }
  }

  /**
   * Kanal düğmesi: TV kapalıysa önce açılır. Açılan TV son girişte (HDMI) başlayabilir — openChannel
   * canlı yayına zaten geçirir. Yeni açılmış TV'de canlı yayın birkaç saniye hazır olmayabilir, bu
   * yüzden birkaç deneme.
   */
  async kanalAc({ ad, no, dogrula = false }) {
    const uyanma = await this.uyan();
    const bekle = this.uyanma.bekle || sleep;
    const deneme = uyanma.uyandirildi ? 5 : 2;
    const bul = (liste) => (no != null ? liste.find((k) => k.no === Number(no)) : kanalBul(liste, ad));
    let liste = null;
    let son;
    for (let i = 0; i < deneme && !liste; i++) {
      try { liste = await this.kanallar(); } catch (e) { son = e; if (i < deneme - 1) await bekle(2000); }
    }
    if (!liste) throw son;
    let k = bul(liste);
    if (!k) throw new HttpHata(404, `${this.ad}: "${ad ?? no}" kanalı bulunamadı`);
    for (let i = 0; i < deneme; i++) {
      try {
        await this.iste('ssap://tv/openChannel', { channelId: k.channelId });
        // Zamanlanmış geçişte (dogrula) kimse ekrana bakmıyor: kanalın tuttuğu her durumda denetlenir.
        if (!uyanma.uyandirildi && !dogrula) return { no: k.no, ad: k.ad, acildi: false };
        const d = await this.kanalTuttuMu(k);
        this.log(`[tv] ${this.id} uyanma sonrası kanal ${d.tuttu ? 'tuttu' : 'TUTMADI'} · iz ${d.iz} · yineleme ${d.yineleme}${d.goruntu ? ` · görüntü ${d.goruntu}` : ''}`);
        if (!d.tuttu) throw new HttpHata(502, `${this.ad}: ${k.ad} ekrana gelmedi (TV'de: ${d.son || 'bilinmiyor'}). Bir kez daha basın.`);
        return { no: k.no, ad: k.ad, acildi: uyanma.uyandirildi, yineleme: d.yineleme };
      } catch (e) {
        if (e instanceof HttpHata) throw e;
        son = e;
        // Kanal kimliği numarayı içerir; sıralamadan sonra önbellek bayatlamış olabilir.
        if (i === 0) { const t = bul(await this.kanallar({ taze: true }).catch(() => [])); if (t) k = t; }
        if (i < deneme - 1) await bekle(2000);
      }
    }
    throw son;
  }

  /**
   * Yeni uyanmış TV kanal komutunu kabul edip ekrana getirmeyebiliyor: saatlerce kapalı kalan bir TV
   * "açıldı" yanıtına rağmen kanala geçmedi, ekranda bir pencere vardı ve ikinci kez basmak gerekti;
   * kısa süre kapalı kalan TV'de sorun çıkmadı (yarı uyku, 4 sn'de açıldı). Ajan yanıtla yetinmez: kanal
   * `kararliMs` boyunca ekranda kalana kadar TV'ye sorar, başka kanaldaysa komutu en çok 3 kez yineler.
   * Tutmazsa ekran görüntüsünü saklar — pencerenin ne olduğu sonradan görülebilsin.
   */
  async kanalTuttuMu(k, { sureMs = 20000, araMs = 1500, kararliMs = 4000 } = {}) {
    const bekle = this.uyanma.bekle || sleep;
    const simdi = this.uyanma.simdi || Date.now;
    const bitis = simdi() + sureMs;
    const iz = [];
    let tutmaBasi = null;
    let yineleme = 0;
    let son = null;
    while (simdi() < bitis) {
      await bekle(araMs);
      let c = null;
      let on = null;
      try { c = await this.iste('ssap://tv/getCurrentChannel', null, 3000); } catch { /* henüz yok */ }
      try { on = (await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo', null, 3000)).appId || null; } catch { /* yok */ }
      const tuttu = !!c && (on == null || on === 'com.webos.app.livetv') && (c.channelId === k.channelId || Number(c.channelNumber) === k.no);
      son = `${c ? `${Number(c.channelNumber)} ${c.channelName}` : 'kanal yok'}${on && on !== 'com.webos.app.livetv' ? ` · ön planda ${on}` : ''}`;
      const imi = `${c ? Number(c.channelNumber) : '-'}${on && on !== 'com.webos.app.livetv' ? `@${on}` : ''}`;
      if (iz.at(-1) !== imi) iz.push(imi);
      if (tuttu) {
        if (tutmaBasi == null) tutmaBasi = simdi();
        if (simdi() - tutmaBasi >= kararliMs) return { tuttu: true, yineleme, iz: iz.join('→'), son };
      } else {
        tutmaBasi = null;
        // Başka kanal ya da başka giriş (TV son HDMI girişinde açılmış olabilir): openChannel ikisini de düzeltir.
        if (yineleme < 3) {
          yineleme++;
          await this.iste('ssap://tv/openChannel', { channelId: k.channelId }).catch(() => {});
        }
      }
    }
    const goruntu = await this.teshisGoruntusu().catch(() => null);
    return { tuttu: tutmaBasi != null, yineleme, iz: iz.join('→'), son, goruntu };
  }

  /** Uyanma sorununu sonradan görebilmek için ekran görüntüsü (son 10'u tutulur). */
  async teshisGoruntusu() {
    if (!this.teshisDizini) return null;
    const jpeg = await this.ekran();
    await mkdir(this.teshisDizini, { recursive: true });
    const ad = `uyanma-${this.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    await writeFile(join(this.teshisDizini, ad), jpeg);
    const eski = (await readdir(this.teshisDizini)).filter((f) => f.startsWith(`uyanma-${this.id}-`)).sort().slice(0, -10);
    for (const f of eski) await unlink(join(this.teshisDizini, f)).catch(() => {});
    return ad;
  }

  /** Kaynak menüsü: canlı yayın, Apple TV ya da bir uygulama. TV kapalıysa önce açılır. */
  async girisDegistir(hedef) {
    if (!GIRIS_HEDEFLERI.has(hedef)) throw new HttpHata(400, `geçersiz giriş: ${hedef}`);
    await this.uyan();
    let uygulama = CANLI_TV;
    let not = null;
    this.appleSon = null;
    if (UYGULAMALAR[hedef]?.atv && this.appleTvVar()) {
      const u = UYGULAMALAR[hedef];
      let girisYok = false;
      try {
        await this.atv.iste(this.appletv, 'uygulama', { uygulama: u.atv });   // Apple TV uykudaysa uyanır
        await this.adlar();
        // Uygulama Apple TV'de açıldı ama TV o girişe geçirilemiyorsa ekranda bir şey değişmez: "açıldı" denmez.
        if (!this.appleUygulama) { girisYok = true; throw new Error('Apple TV girişi bulunamadı (TV\'nin giriş adlarında "Apple" yok)'); }
        await this.iste('ssap://system.launcher/launch', { id: this.appleUygulama });
        this.appleSon = hedef;
        return { kaynak: hedef, cihaz: 'apple', uygulama: u.atv };
      } catch (e) {
        this.log(`[tv] ${this.id}: Apple TV'de ${u.ad} açılamadı (${e.message}) — TV'nin uygulamasıyla açılıyor`);
        not = girisYok ? `Apple TV girişi bulunamadı — TV'nin ${u.ad} uygulaması açıldı` : `Apple TV'ye ulaşılamadı — TV'nin ${u.ad} uygulaması açıldı`;
      }
    }
    if (hedef === 'apple') {
      await this.adlar();
      uygulama = this.appleUygulama;
      if (!uygulama) throw new HttpHata(404, `${this.ad}: Apple TV girişi bulunamadı (TV'nin giriş adlarında "Apple" yok)`);
    } else if (UYGULAMALAR[hedef]) {
      const u = UYGULAMALAR[hedef];
      const adlar = await this.adlar();
      if (adlar.size && !adlar.has(u.lg)) throw new HttpHata(404, `${this.ad}: ${u.ad} bu TV'de yüklü değil`);
      uygulama = u.lg;
    }
    await this.iste('ssap://system.launcher/launch', { id: uygulama });
    return { kaynak: hedef, uygulama, ...(UYGULAMALAR[hedef] ? { cihaz: 'lg' } : {}), ...(not ? { not } : {}) };
  }

  /**
   * Apple TV'de şu an oynayan (uygulama, başlık, kanal/sanatçı, dizi-sezon-bölüm, konum). AirPlay eşleşmesi
   * gerekir. Yalnız TV Apple TV girişindeyken sorulur — her soru Apple TV'yi uyandırır. 10 sn önbellek.
   */
  async appleOynayan() {
    if (!this.appleTvVar()) return null;
    const simdi = Date.now();
    if (this._oynayan && simdi - this._oynayan.zaman < 10000) return this._bilgisizIsle(this._oynayan.veri);
    let veri = null;
    try {
      const { no, ok, ...v } = await this.atv.iste(this.appletv, 'oynayan', {}, 6000);
      veri = v;
    } catch { /* eşleşme yok ya da Apple TV yanıt vermedi */ }
    this._oynayan = { zaman: simdi, veri };
    return this._bilgisizIsle(veri);
  }

  /**
   * Oynatma bilgisi YAYINLAMAYAN uygulama (bazı IPTV oynatıcıları — ölçüldü: durum idle, başlık yok ve uygulama
   * en son bilgi veren uygulama, ör. YouTube olarak KALIYOR). Apple TV "oynuyor" demiyorsa ve uyanıksa (ekran
   * koruyucu değil — onun manzaraları da hareketli) 5 sn arayla iki ekran görüntüsü karşılaştırılır: farklıysa
   * oynayan BILGISIZ_UYGULAMA sayılır (aktif); aynıysa ya da ekran koruyucudaysa TV açık ama izlenmiyor (pasif).
   * Ölçüm ilk gerektiğinde hemen, sonra en çok 60 sn'de bir, arka planda (durum sorgusu beklemez); karar 90 sn
   * geçerli.
   */
  _bilgisizIsle(v) {
    if (!this.hareketOlc || !this.appleTvVar()) return v;
    if (v && ['playing', 'loading', 'seeking'].includes(v.durum)) { this._bilgisiz = null; return v; }
    // Netflix ön plandayken de "boşta" bildirir (menü, otomatik fragmanlar hareketli): tanınan uygulama kendi
    // adıyla kalır, menü/fragman o uygulamanın beklemesi sayılır.
    if (v && /netflix/i.test(v.uygulama || '')) { this._bilgisiz = null; return v; }
    const simdi = Date.now();
    if (!this._bilgisizCalisiyor && (!this._bilgisiz || simdi - this._bilgisiz.zaman > 60000)) this._bilgisizOlc().catch(() => {});
    const k = this._bilgisiz;
    if (!k || !k.oynuyor || simdi - k.zaman > 90000) return v;
    return { uygulama: BILGISIZ_UYGULAMA, uygulamaId: null, baslik: null, sanatci: null, album: null, dizi: null, sezon: null, bolum: null, durum: 'playing', tur: 'unknown', konum: null, sure: null, tahmin: 'ekran-hareketi' };
  }

  async _bilgisizOlc() {
    this._bilgisizCalisiyor = true;
    try {
      const { sistem } = await this.atv.iste(this.appletv, 'sistem', {}, 8000);
      if (sistem !== 'awake' && sistem !== 'unknown') { this._bilgisiz = { zaman: Date.now(), oynuyor: false, sistem }; return; }
      const a = await this.sirayla(() => this.ekran());
      await sleep(this.hareketAraMs);
      const b = await this.sirayla(() => this.ekran());
      const fark = await this.hareketOlc(a, b);
      this._bilgisiz = { zaman: Date.now(), oynuyor: fark >= HAREKET_ESIGI, fark, sistem };
    } catch {
      this._bilgisiz = { zaman: Date.now(), oynuyor: false };
    } finally {
      this._bilgisizCalisiyor = false;
    }
  }

  /**
   * Engel bekçisi için: TV açık ve Apple TV girişindeyse Apple TV'de oynayan (önbelleksiz), değilse null.
   * Apple TV'ye ancak LG "açık, Apple TV girişinde" derse sorulur — kapalı TV'nin Apple TV'sine giden soru
   * Apple TV'yi, o da CEC ile TV'yi uyandırabilir. LG durumu açıkken 8 sn, kapalıyken 30 sn'de bir tazelenir.
   */
  async appledaOynayan() {
    if (!this.appleTvVar()) return null;
    const son = this._sonDurum;
    if (!son || Date.now() - son.zaman > (son.acik ? 8000 : 30000)) await this.durum();
    if (!this._sonDurum?.acik || this._sonDurum.cihaz !== 'apple') return null;
    const on = await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo');
    if (!on.appId || on.appId !== this.appleUygulama) return null;
    this._oynayan = null;
    return this.appleOynayan();
  }

  /** Apple TV'de öndeki uygulamayı kapatır (YouTube engeli, 2. kademe). */
  async appleUygulamaKapat() {
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    await this.atv.iste(this.appletv, 'uygulama-kapat', {}, 15000);
  }

  /** Apple TV'yi uyutur (kilit bekçisi, kapsam "TV + Apple TV"). */
  async appleUyut() {
    if (!this.appleTvVar()) return;
    await this.atv.iste(this.appletv, 'uyku', {}, 10000);
  }

  /**
   * Ekranın ortasında uyarı penceresi (LG createAlert — köşedeki bildirim satır sonunu yutuyor, bu göstermiyor):
   * `satirlar` alt alta, `sureMs` sonra kapatılır. Pencere açılamazsa köşe bildirimine düşer; o da olmazsa hata.
   * `bekle: false` → pencere açılınca döner, kapatma arka planda (HTTP yanıtı beklemesin).
   */
  async uyariGoster(satirlar, sureMs = 5000, { bekle = true } = {}) {
    const kacir = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let alertId = null;
    try {
      // Satır başı girintisi bölünmez boşlukla korunur (HTML boşlukları birleştirir) — ör. imza satırı.
      const html = satirlar.map((x) => kacir(x).replace(/^ +/, (m) => ' '.repeat(m.length))).join('<br>').slice(0, 400);
      alertId = (await this.iste('ssap://system.notifications/createAlert', { message: html, buttons: [{ label: 'Tamam' }] })).alertId || null;
    } catch {
      await this.toast(satirlar.filter(Boolean).join(' — '));
    }
    const kapat = async () => { if (alertId) await this.iste('ssap://system.notifications/closeAlert', { alertId }).catch(() => {}); };
    if (!bekle) { setTimeout(() => { kapat(); }, sureMs).unref?.(); return; }
    await sleep(sureMs);
    await kapat();
  }

  /** Apple TV'ye pyatv tuşu ('pause', 'menu' …) — engel bekçisi kullanır. */
  async appleKomut(tus) {
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    await this.atv.iste(this.appletv, 'tus', { tus });
  }

  appleTvVar() {
    return !!(this.appletv && this.atv && this.atv.hazirMi());
  }

  /** Uygulama kumandası Apple TV girişindeyken: tuş Apple TV'ye (Companion). */
  async appleTus(ad) {
    const tus = ATV_TUSLARI[ad];
    if (!tus) throw new HttpHata(400, `Apple TV'de karşılığı olmayan tuş: ${ad}`);
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    this.kilitDenetle();   // Apple TV tuşu Apple TV'yi, o da CEC ile TV'yi uyandırır
    await this.atv.iste(this.appletv, 'tus', { tus });
  }

  /** Apple TV'de odaktaki yazı alanına metin (arama kutusu). */
  async appleMetin(metin) {
    if (!this.appleTvVar()) throw new HttpHata(409, `${this.ad}: Apple TV bağlı değil`);
    this.kilitDenetle();
    await this.atv.iste(this.appletv, 'metin', { metin });
  }

  async cozumle(adlar) {
    const liste = await this.kanallar();
    return adlar.map((ad) => {
      const k = kanalBul(liste, ad);
      return { ad, no: k ? k.no : null, kanalAdi: k ? k.ad : null };
    });
  }

  /** Dokunmatik yüzey (kumanda arayüzü): imleci oynat ya da tıkla. */
  async isaretci({ dx = 0, dy = 0, tikla = false }) {
    const gonder = async () => {
      const k = await this.kumanda();
      if (tikla) k.click(); else k.move(dx, dy);
    };
    try { await gonder(); } catch { this.birak(); await gonder(); }   // soket sessizce düşmüş olabilir
  }

  async tus(ad) {
    if (!IZINLI_TUSLAR.has(ad)) throw new HttpHata(400, `izinli olmayan tuş: ${ad}`);
    try {
      await (await this.kumanda()).button(ad, { settleMs: 0 });
    } catch {
      // Kumanda soketi sessizce düşmüş olabilir: bir kez baştan kur.
      this.birak();
      await (await this.kumanda()).button(ad, { settleMs: 0 });
    }
  }

  /** Canlı yayında açık kanal — "geri dön" sayacının varsayılan hedefi. */
  async simdikiKanal() {
    const on = await this.iste('ssap://com.webos.applicationManager/getForegroundAppInfo');
    if (on.appId !== CANLI_TV) throw new HttpHata(409, `${this.ad} canlı yayında değil — geri dönülecek kanal yok`);
    const c = await this.iste('ssap://tv/getCurrentChannel');
    return { no: Number(c.channelNumber), ad: c.channelName };
  }

  /**
   * Ses düzeyi. webOS'ta yanıt iki biçimde gelebiliyor: düz { volume, muted } ya da
   * { volumeStatus: { volume, muteStatus, soundOutput } }. Harici ses çıkışında (soundbar/ARC) düzey -1
   * döner — o zaman seviye null (arayüz şeridi göstermez).
   */
  async sesOku() {
    const r = await this.iste('ssap://audio/getVolume');
    const v = r.volumeStatus || r;
    const seviye = Number(v.volume);
    return {
      seviye: Number.isFinite(seviye) && seviye >= 0 ? seviye : null,
      sessiz: !!(v.muteStatus ?? v.muted ?? r.mute),
      cikis: v.soundOutput || r.scenario || null,
    };
  }

  async sesAyarla(seviye) {
    const n = Number(seviye);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new HttpHata(400, 'ses 0-100 arasında tam sayı olmalı');
    await this.iste('ssap://audio/setVolume', { volume: n });
    return { seviye: n };
  }

  /** Ekranı kapat / aç, ses devam eder (webOS 26'da ölçüldü: ~40 ms). webOS < 4.5 eski uç. */
  async ekranAyarla(kapali) {
    const u = kapali ? 'turnOffScreen' : 'turnOnScreen';
    try {
      await this.iste(`ssap://com.webos.service.tvpower/power/${u}`);
    } catch (e) {
      if (!/404|no such/i.test(String(e.message))) throw e;
      await this.iste(`ssap://com.webos.service.tv.power/${u}`);
    }
    return { ekranKapali: !!kapali };
  }

  async toast(mesaj) {
    await this.iste('ssap://system.notifications/createToast', { message: String(mesaj).slice(0, 160) });
  }

  /** Mesajı `sureSn` boyunca ekranda tutar (TV bildirimi ~5 sn'de kapatıyor → yenilenir). Yenisi eskisini keser. */
  async bildirimGoster(mesaj, sureSn) {
    clearInterval(this._bildirimT);
    await this.toast(mesaj);                       // ilki beklenir: TV kapalıysa hata çağırana döner
    const bitis = Date.now() + sureSn * 1000;
    if (sureSn * 1000 <= BILDIRIM_TAZELEME_MS + 500) return;
    this._bildirimT = setInterval(() => {
      if (Date.now() + 1000 >= bitis) { clearInterval(this._bildirimT); return; }
      this.toast(mesaj).catch(() => clearInterval(this._bildirimT));
    }, BILDIRIM_TAZELEME_MS);
    this._bildirimT.unref?.();
  }

  async ekran() {
    return captureScreen(await this.baglan(), { timeoutMs: 8000 });
  }

  async kapat() {
    await this.iste('ssap://system/turnOff');
    await sleep(300);
    this.birak();
  }
}

// ───────────────────────────────────────────────────────────── zamanlayıcı görevleri

/**
 * Zamanlayıcının görev yürütücüsü (TV'ye giden kısım). Ana akış kullanır; testler sahte TV'lerle sınar.
 *  - Kanal listesi düzenlenen TV'de görev atlanır (menüye kanal komutu gitmesin) — sıraya girerken VE
 *    sıradan çıkıp çalışırken bakılır.
 *  - Mesaj görevi TV kapalıysa atlanır (TV'yi açmaz).
 *  - "Geri dön" TV kapatıldıysa ya da canlı yayından başka bir uygulamaya/girişe geçildiyse atlanır.
 */
export function gorevYurutucu({ tvBul, kanalSirasi = null }) {
  const duzenleniyor = (t) => !!kanalSirasi?.mesgul(t.id);
  const ATLA_DUZENLEME = { sonuc: 'atlandi', neden: 'kanal listesi düzenleniyordu' };
  return {
    calistir: async (g) => {
      const t = tvBul(g.tv);
      if (!t) return { sonuc: 'hata', neden: 'bilinmeyen TV' };
      if (duzenleniyor(t)) return ATLA_DUZENLEME;
      if (g.mesaj) {   // ekranda mesaj (ör. her akşam bir hatırlatma) — TV kapalıysa atla, asla açma
        if (!(await t.hazirMi())) return { sonuc: 'atlandi', neden: 'TV kapalıydı' };
        if (g.mesaj.ortada) await t.uyariGoster(g.mesaj.metin.split('\n'), g.mesaj.sureSn * 1000);
        else await t.bildirimGoster(g.mesaj.metin, g.mesaj.sureSn);
        if (g.mesaj.sonraKapat) {
          await t.sirayla(() => t.kapat());
          return { sonuc: 'ok', neden: 'mesaj gösterildi, TV kapatıldı' };
        }
        return { sonuc: 'ok', neden: 'mesaj gösterildi' };
      }
      if (g.tvKapaliysa === 'atla' && !(await t.hazirMi())) return { sonuc: 'atlandi', neden: 'TV kapalıydı' };
      if (g.tur === 'geri-don' && !(await t.canliMi())) return { sonuc: 'atlandi', neden: 'TV canlı yayında değildi (başka uygulama ya da giriş)' };
      const hedef = g.kanal.no != null ? { no: g.kanal.no } : { ad: g.kanal.ad };
      const k = await t.sirayla(() => (duzenleniyor(t) ? null : t.kanalAc({ ...hedef, dogrula: true })));
      if (!k) return ATLA_DUZENLEME;
      return { sonuc: 'ok', neden: `${k.no} · ${k.ad}${k.acildi ? ' (TV açılarak)' : ''}` };
    },
    // Kanal geçişinden 1 dk ve 10 sn önce TV'de bildirim. TV kapalıysa gösterilecek ekran yok; geri dön
    // atlanacaksa (canlı yayında değil) yanlış uyarı gösterilmez.
    uyar: async (g, sn) => {
      const t = tvBul(g.tv);
      if (!t || g.mesaj || duzenleniyor(t) || !(await t.hazirMi())) return;
      if (g.tur === 'geri-don' && !(await t.canliMi())) return;
      const ne = g.kanal.ad || `Kanal ${g.kanal.no}`;
      await t.toast(`${sn >= 60 ? `${Math.round(sn / 60)} dk` : `${sn} sn`} sonra ${ne} açılacak${g.tur === 'geri-don' ? ' (geri dön)' : ''}`);
    },
  };
}

// ───────────────────────────────────────────────────────────── HTTP

export function yetkili(req, token) {
  const h = String(req.headers.authorization || '');
  if (!token || !h.startsWith('Bearer ')) return false;
  const a = Buffer.from(h.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res, kod, govde) {
  const s = JSON.stringify(govde);
  res.writeHead(kod, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

async function govdeOku(req, sinir = 4096) {
  const parcalar = [];
  let n = 0;
  for await (const p of req) {
    n += p.length;
    if (n > sinir) throw new HttpHata(413, 'istek gövdesi çok büyük');
    parcalar.push(p);
  }
  if (!parcalar.length) return {};
  let g;
  try { g = JSON.parse(Buffer.concat(parcalar).toString('utf8')); } catch { throw new HttpHata(400, 'gövde JSON değil'); }
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new HttpHata(400, 'gövde JSON nesnesi olmalı');
  return g;
}

const adListesi = (g, en) => (Array.isArray(g.adlar) ? g.adlar.slice(0, en).map((a) => String(a).slice(0, 60)) : []);

/**
 * YouTube kesitlerine video kimliği ekler (`k.youtube`). Önbellekte olan hemen; yeniler en çok `butceMs`
 * beklenir, yetişmeyenler arka planda çözülür ve sonraki istekte gelir. Bulunamayan kesit kimliksiz kalır.
 */
export async function youtubeEkle(kesitler, youtube, butceMs = 6000) {
  if (!youtube) return;
  const yt = kesitler.filter((k) => /youtube/i.test(k.uygulama || '') && k.program);
  const sorulacak = new Map();
  for (const k of yt) {
    const v = ayir(k.program);
    const id = youtube.onbellekte(v.baslik, v.kanal);
    if (id) k.youtube = id;
    else if (id === undefined) sorulacak.set(ytAnahtar(v.baslik, v.kanal), v);
  }
  if (!sorulacak.size) return;
  const bulunan = new Map();
  const isler = [...sorulacak].map(([a, v]) => youtube.bul(v).then((id) => { if (id) bulunan.set(a, id); }));
  let zaman;
  await Promise.race([Promise.allSettled(isler), new Promise((r) => { zaman = setTimeout(r, butceMs); })]);
  clearTimeout(zaman);
  for (const k of yt) {
    if (k.youtube) continue;
    const v = ayir(k.program);
    const id = bulunan.get(ytAnahtar(v.baslik, v.kanal));
    if (id) k.youtube = id;
  }
}

/** İşlem kaydı için isteğin kaynağı: panel (kumanda arayüzü, `X-Istemci: panel`) ya da dogrudan (betik/komut). */
const istemci = (req) => (req.headers['x-istemci'] === 'panel' ? 'panel' : 'dogrudan');

export function sunucuKur(tvler, { token = TOKEN, log = console.log, rehber = null, zamanlayici = null, kanalSirasi = null, izleme = null, youtube = null, engel = null, kilit = null } = {}) {
  const byId = new Map(tvler.map((t) => [t.id, t]));
  const tvAl = (id) => {
    const t = byId.get(String(id || ''));
    if (!t) throw new HttpHata(404, 'bilinmeyen TV');
    return t;
  };
  // Kanal listesi düzenlenirken TV'nin menüsünü kumanda sürüyor: başka komut araya girmesin. İstek gelirken
  // VE sıradan çıkıp çalışırken bakılır (iş, sırada bekleyen bir tuştan sonra başlamış olabilir).
  const kanalKilidi = (t) => {
    if (kanalSirasi?.mesgul(t.id)) throw new HttpHata(409, `${t.ad}: kanal listesi düzenleniyor — bitene kadar bekleyin ya da durdurun`);
  };
  const sirada = (t, is) => t.sirayla(() => { kanalKilidi(t); return is(); });

  async function isle(req, res) {
    if (!yetkili(req, token)) { json(res, 401, { hata: 'yetkisiz' }); return; }
    let url;
    try { url = new URL(req.url, 'http://ajan'); } catch { json(res, 400, { hata: 'geçersiz istek adresi' }); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/tvler') {
        // Sıraya GİRMEZ: bir TV uyandırılırken (≤40 sn) arayüzün durum sorgusu beklememeli.
        const durumlar = await Promise.all(tvler.map((t) => t.durum()));
        json(res, 200, { tvler: durumlar.map((d) => ({ ...d, kilit: kilit?.bilgi(d.id) || null })), ...saatBilgisi() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ekran-akis') {
        // Canlı önizleme (ekran açık olduğu süre boyunca, varsayılan 1 kare/sn).
        // TV başına TEK kare çekim döngüsü; kareler o TV'yi izleyen BÜTÜN bağlantılara dağıtılır. (İlk sürüm
        // "TV başına tek akış" diyordu: iki ekran açıkken akışlar birbirini kesip duruyordu — ölçüldü.)
        // Her izleyici kendi hızını ister (fps); döngü en hızlı isteğe göre çeker, TV'nin sınırı ~2,5 kare/sn.
        const t = tvAl(url.searchParams.get('tv'));
        const sureMs = Math.min(Math.max(Number(url.searchParams.get('sn')) || 120, 5), AKIS_EN_UZUN_SN) * 1000;
        const fps = Math.min(Math.max(Number(url.searchParams.get('fps')) || AKIS_VARSAYILAN_FPS, 0.1), 3);
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=kare', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        const izleyici = { res, aralikMs: 1000 / fps, son: 0, bekliyor: false, bitis: Date.now() + sureMs, kare: 0, bayt: 0, bas: Date.now() };
        t.izleyiciler ||= new Set();
        t.izleyiciler.add(izleyici);
        const ayril = () => {
          if (!t.izleyiciler.delete(izleyici)) return;
          const sn = (Date.now() - izleyici.bas) / 1000;
          log(`[tv] ${t.id} canlı önizleme: ${izleyici.kare} kare / ${sn.toFixed(0)} sn (${(izleyici.kare / Math.max(sn, 1)).toFixed(1)} kare/sn), ${(izleyici.bayt / 1e6).toFixed(1)} MB · kalan izleyici ${t.izleyiciler.size}`);
        };
        izleyici.ayril = ayril;
        req.on('close', ayril);
        if (!t.akisDongusu) {
          t.akisDongusu = (async () => {
            while (t.izleyiciler.size) {
              const simdi = Date.now();
              for (const z of [...t.izleyiciler]) if (simdi >= z.bitis) { z.res.end(); z.ayril(); }
              const vadeli = [...t.izleyiciler].filter((z) => simdi - z.son >= z.aralikMs - 50 && !z.bekliyor);
              if (!vadeli.length) {
                const bekle = Math.min(...[...t.izleyiciler].map((z) => Math.max(z.son + z.aralikMs - simdi, 50)), 1000);
                await sleep(Number.isFinite(bekle) ? bekle : 200);
                continue;
              }
              let jpeg;
              try { jpeg = await t.ekran(); } catch { await sleep(1000); continue; }
              const bas = `--kare\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
              for (const z of vadeli) {
                if (!t.izleyiciler.has(z)) continue;
                const yazildi = z.res.write(bas) & z.res.write(jpeg) & z.res.write('\r\n');
                z.son = Date.now();
                z.kare++;
                z.bayt += jpeg.length;
                // Yavaş istemci: tampon boşalana kadar ona kare gönderilmez (okunmayan kare birikmez).
                if (!yazildi) { z.bekliyor = true; z.res.once('drain', () => { z.bekliyor = false; }); }
              }
            }
            t.akisDongusu = null;
          })();
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/akis') {
        if (!rehber) throw new HttpHata(503, 'rehber yok');
        const g = await govdeOku(req);
        const saat = Math.min(Math.max(Number(g.saat) || 30, 1), 48);
        const kanallar = await Promise.all(adListesi(g, 20).map(async (ad) => {
          let programlar = [];
          try { programlar = await zamanAsimi(rehber.akis(ad, { saat }), 25000, 'rehber'); } catch { /* yok */ }
          return { ad, programlar };
        }));
        json(res, 200, { simdi: Date.now(), kanallar });
        return;
      }
      // ── Kanal listesi düzenleme (bkz. net/kanal-sirasi.mjs) ──
      if (req.method === 'GET' && (url.pathname === '/kanal-sirasi' || url.pathname === '/kanal-listesi')) {
        if (!kanalSirasi) throw new HttpHata(503, 'kanal listesi düzenleme kurulu değil');
        const t = tvAl(url.searchParams.get('tv'));
        if (url.pathname === '/kanal-sirasi') { json(res, 200, { kayitli: await kanalSirasi.kayitli(t.id), is: kanalSirasi.durum(t.id) }); return; }
        if (kanalSirasi.mesgul(t.id)) throw new HttpHata(409, `${t.ad}: kanal listesi düzenleniyor`);
        json(res, 200, { kanallar: await t.sirayla(() => kanalSirasi.liste(t)) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ses') {
        const t = tvAl(url.searchParams.get('tv'));
        json(res, 200, await t.sirayla(() => t.sesOku()));
        return;
      }
      // İzleme geçmişi (kişisel veri: yalnız belirteçle). gun = yerel gün (YYYY-AA-GG), gunSayisi 1-31.
      if (req.method === 'GET' && url.pathname === '/izleme') {
        if (!izleme) throw new HttpHata(503, 'izleme kaydı kapalı (TV_AJAN_IZLEME=1)');
        const gun = url.searchParams.get('gun') || trGun(Date.now());
        const gunSayisi = Math.min(Math.max(Number(url.searchParams.get('gunSayisi')) || 1, 1), 31);
        const aralik = gunAraligi(gun, gunSayisi);
        if (!aralik) throw new HttpHata(400, 'gün YYYY-AA-GG olmalı');
        const tv = url.searchParams.get('tv') || null;
        if (tv) tvAl(tv);
        const kesitler = await izleme.kesitler({ ...aralik, tv });
        await youtubeEkle(kesitler, youtube);
        json(res, 200, { bas: aralik.bas, bit: aralik.bit, kesitler, ozet: ozetle(kesitler, aralik) });
        return;
      }
      // TV kilidi (ebeveyn denetimi): kilitli TV açılamaz, açılırsa kapatılır. dk yoksa/null → süresiz.
      if (url.pathname === '/kilit' || url.pathname === '/kilit/ayar') {
        if (!kilit) throw new HttpHata(503, 'kilit kurulu değil');
        const kilitYaniti = () => ({ ...kilit.durum(), tvler: tvler.map((t) => ({ id: t.id, ad: t.ad })) });
        if (req.method === 'GET') { json(res, 200, kilitYaniti()); return; }
        if (req.method === 'POST' && url.pathname === '/kilit/ayar') {
          await kilit.mesajAyarla((await govdeOku(req)).mesaj);
          log('[kilit] mesaj değişti');
          json(res, 200, { ok: true, ...kilitYaniti() });
          return;
        }
        if (req.method === 'POST') {
          const g = await govdeOku(req);
          const t = tvAl(g.tv);
          await kilit.kilitle(t.id, g.dk ?? null, g.kapsam || (t.appletv ? 'tv+apple' : 'tv'), istemci(req));
          log(`[kilit] ${t.id} kilitlendi (${g.dk ? `${g.dk} dk` : 'süresiz'})`);
          json(res, 200, { ok: true, ...kilitYaniti() });
          return;
        }
        if (req.method === 'DELETE' && url.pathname === '/kilit') {
          const t = tvAl(url.searchParams.get('tv'));
          await kilit.ac(t.id, istemci(req));
          log(`[kilit] ${t.id} kilidi açıldı`);
          json(res, 200, { ok: true, ...kilitYaniti() });
          return;
        }
        throw new HttpHata(405, 'yöntem desteklenmiyor');
      }
      // YouTube engelleri (ebeveyn denetimi): kurallar + son engellenenler + ekran metinleri; ekle/sil/ayarla.
      if (url.pathname === '/engel' || url.pathname === '/engel/ayar') {
        if (!engel) throw new HttpHata(503, 'engelleme kurulu değil (Apple TV yok)');
        if (req.method === 'GET' && url.pathname === '/engel') { json(res, 200, engel.durum()); return; }
        if (req.method === 'DELETE' && url.pathname === '/engel') {
          await engel.sil(String(url.searchParams.get('id') || ''), istemci(req));
          log('[engel] kural silindi');
          json(res, 200, { ok: true, ...engel.durum() });
          return;
        }
        if (req.method === 'POST') {
          const g = await govdeOku(req);
          if (url.pathname === '/engel/ayar') {
            json(res, 200, { ok: true, ...(await engel.ayarla({ acik: g.acik, mesaj: g.mesaj, uyari: g.uyari }, istemci(req))) });
            return;
          }
          const { kural, varmis } = await engel.ekle({ metin: g.metin, tur: g.tur || null }, istemci(req));
          log(`[engel] kural ${varmis ? 'zaten vardı' : 'eklendi'}: ${kural.tur}`);
          json(res, varmis ? 200 : 201, { ok: true, kural, varmis, ...engel.durum() });
          return;
        }
        throw new HttpHata(405, 'yöntem desteklenmiyor');
      }
      if (req.method === 'GET' && url.pathname === '/zamanlayici') {
        if (!zamanlayici) throw new HttpHata(503, 'zamanlayıcı kurulu değil');
        json(res, 200, zamanlayici.liste());
        return;
      }
      if (req.method === 'POST' && url.pathname === '/zamanlayici') {
        if (!zamanlayici) throw new HttpHata(503, 'zamanlayıcı kurulu değil');
        const g = await govdeOku(req);
        const islem = String(g.islem || '');
        let sonuc;
        if (islem === 'geri-don') {
          const t = tvAl(g.tv);
          const kanal = await t.sirayla(() => t.simdikiKanal());
          sonuc = await zamanlayici.geriDon({ tv: t.id, dk: g.dk, kanal });
        } else if (islem === 'ekle') {
          const t = tvAl(g.tv);
          sonuc = await zamanlayici.ekle({ tv: t.id, kanal: g.kanal, mesaj: g.mesaj ?? null, zaman: g.zaman, tvKapaliysa: g.tvKapaliysa, etiket: g.etiket ?? null });
        } else if (islem === 'uzat') sonuc = await zamanlayici.uzat(g.id, g.dk ?? 1);
        else if (islem === 'sil') sonuc = await zamanlayici.sil(g.id);
        else if (islem === 'etkin') sonuc = await zamanlayici.etkin(g.id, g.acik);
        else if (islem === 'hemen') sonuc = await zamanlayici.hemen(g.id);
        else throw new HttpHata(400, 'bilinmeyen işlem');
        log(`[tv] zamanlayıcı ${islem}${g.tv ? ` ${g.tv}` : ''}${g.id ? ` ${g.id}` : ''}`);
        json(res, 200, { ok: true, sonuc, ...zamanlayici.liste() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/ekran') {
        const t = tvAl(url.searchParams.get('tv'));
        const jpeg = await t.sirayla(() => t.ekran());
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
        res.end(jpeg);
        return;
      }
      if (req.method === 'POST') {
        const g = await govdeOku(req, url.pathname.startsWith('/kanal-sira') ? KANAL_SIRA_GOVDE : 4096);
        const t = tvAl(g.tv);
        if (url.pathname.startsWith('/kanal-sira') || url.pathname === '/kanal-onerisi') {
          if (!kanalSirasi) throw new HttpHata(503, 'kanal listesi düzenleme kurulu değil');
          const siraAl = () => {
            const sira = g.sira;
            if (!Array.isArray(sira) || !sira.length || sira.length > 2000 || !sira.every((k) => typeof k === 'string' && KANAL_ANAHTARI.test(k)) || new Set(sira).size !== sira.length) {
              throw new HttpHata(400, 'geçersiz kanal sırası');
            }
            return sira;
          };
          if (url.pathname === '/kanal-onerisi') {
            if (kanalSirasi.mesgul(t.id)) throw new HttpHata(409, `${t.ad}: kanal listesi düzenleniyor`);
            json(res, 200, await t.sirayla(() => kanalSirasi.oneri(t, g.ad ? String(g.ad) : 'vibecoder')));
          } else if (url.pathname === '/kanal-sirasi-kaydet') {
            json(res, 200, { ok: true, kayitli: await kanalSirasi.kaydet(t.id, siraAl()) });
          } else if (url.pathname === '/kanal-sirala') {
            const sira = siraAl();
            // 409 kayıtlı sıra ezilmeden önce; sonra hemen rezerve: uyanma + liste okuma + yedek sırasında gelen
            // komutlar da 409 alsın (iş başladıktan sonra menüye tuş gitmesin).
            if (kanalSirasi.mesgul(t.id)) throw new HttpHata(409, `${t.ad}: kanal listesi düzenleniyor`);
            kanalSirasi.rezerveEt(t.id);
            try {
              await kanalSirasi.kaydet(t.id, sira);
              json(res, 200, { ok: true, is: await t.sirayla(async () => { await t.uyan(); return kanalSirasi.baslat(t, sira); }) });
            } finally {
              kanalSirasi.rezervKaldir(t.id);
            }
            log(`[tv] ${t.id} kanal listesi uygulanıyor (${sira.length} kanal)`);
          } else if (url.pathname === '/kanal-sirala-durdur') {
            json(res, 200, { ok: kanalSirasi.durdur(t.id), is: kanalSirasi.durum(t.id) });
          } else throw new HttpHata(404, 'bilinmeyen uç');
          return;
        }
        kanalKilidi(t);
        if (url.pathname === '/tus') {
          const tus = String(g.tus || '').toUpperCase();
          if (g.cihaz === 'apple') {   // uygulama kumandası, Apple TV girişi
            await t.appleTus(tus);
            json(res, 200, { ok: true });
            return;
          }
          // Sırada uzun bekleyen tuş basılmaz: TV bir an takılınca biriken (ör. basılı tutulan ses) tuşlar
          // takılma bitince topluca gitmesin. İstemci vazgeçtiyse de basılmaz.
          const giris = Date.now();
          await sirada(t, () => {
            if (req.socket?.destroyed) throw new HttpHata(503, 'istemci vazgeçti — tuş basılmadı');
            if (Date.now() - giris > TUS_BAYAT_MS) throw new HttpHata(503, `${t.ad} meşguldü — tuş ${((Date.now() - giris) / 1000).toFixed(0)} sn sırada bekledi, basılmadı`);
            return t.tus(tus);
          });
          log(`[tv] ${t.id} tuş ${tus}`);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/metin') {
          const metin = typeof g.metin === 'string' ? g.metin : '';
          if (metin.length > 100) throw new HttpHata(400, 'metin en çok 100 karakter');
          await t.appleMetin(metin);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/isaretci') {
          const tikla = g.tikla === true;
          const dx = Number(g.dx ?? 0), dy = Number(g.dy ?? 0);
          if (!tikla && (![dx, dy].every((v) => Number.isInteger(v) && Math.abs(v) <= 2000) || (!dx && !dy))) throw new HttpHata(400, 'dx/dy tam sayı olmalı (en çok ±2000)');
          await sirada(t, () => t.isaretci({ dx, dy, tikla }));
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/kanal') {
          if (g.no == null && !g.ad) throw new HttpHata(400, 'ad ya da no gerekli');
          if (g.no != null && !/^\d{1,5}$/.test(String(g.no))) throw new HttpHata(400, 'geçersiz kanal numarası');
          if (g.ad != null && String(g.ad).length > 60) throw new HttpHata(400, 'kanal adı çok uzun');
          const k = await sirada(t, () => t.kanalAc({ ad: g.ad, no: g.no }));
          log(`[tv] ${t.id} kanal ${k.no} ${k.ad}${k.acildi ? ' (TV açılarak)' : ''}`);
          json(res, 200, { ok: true, kanal: k });
          return;
        }
        if (url.pathname === '/ac') {
          const r = await sirada(t, () => t.uyan());
          log(`[tv] ${t.id} ${r.uyandirildi ? `açıldı (${r.wolSayisi} paket)` : 'zaten açık'}`);
          json(res, 200, { ok: true, uyandirildi: r.uyandirildi });
          return;
        }
        if (url.pathname === '/giris') {
          const hedef = String(g.hedef || '');
          if (!GIRIS_HEDEFLERI.has(hedef)) throw new HttpHata(400, 'geçersiz giriş');
          const r = await sirada(t, () => t.girisDegistir(hedef));
          log(`[tv] ${t.id} giriş → ${hedef} (${r.uygulama})`);
          json(res, 200, { ok: true, ...r });
          return;
        }
        if (url.pathname === '/ses') {
          json(res, 200, { ok: true, ...(await sirada(t, () => t.sesAyarla(g.seviye))) });
          return;
        }
        if (url.pathname === '/ekran-guc') {
          const r = await sirada(t, () => t.ekranAyarla(!!g.kapali));
          log(`[tv] ${t.id} ekran ${r.ekranKapali ? 'kapatıldı' : 'açıldı'}`);
          json(res, 200, { ok: true, ...r });
          return;
        }
        if (url.pathname === '/bildirim') {
          // ortada: true → ekranın ortasında çok satırlı uyarı penceresi (satır başı girintisi korunur); pencere
          // açılınca yanıt döner, kapanış arka planda.
          const ortada = g.ortada === true;
          const mesaj = ortada ? String(g.mesaj || '').replace(/^(\s*\n)+/, '').trimEnd() : String(g.mesaj || '').trim();
          const sureSn = Number(g.sureSn ?? 5);
          if (!mesaj.trim() || mesaj.length > (ortada ? 300 : 160)) throw new HttpHata(400, `mesaj 1-${ortada ? 300 : 160} karakter olmalı`);
          if (ortada && mesaj.split('\n').length > 5) throw new HttpHata(400, 'mesaj en çok 5 satır');
          if (!Number.isInteger(sureSn) || sureSn < 5 || sureSn > 120) throw new HttpHata(400, 'süre 5-120 sn olmalı');
          if (ortada) await t.uyariGoster(mesaj.split('\n'), sureSn * 1000, { bekle: false });
          else await t.bildirimGoster(mesaj, sureSn);
          log(`[tv] ${t.id} bildirim (${sureSn} sn${ortada ? ', ortada' : ''})`);
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === '/cozumle') {
          json(res, 200, { kanallar: await t.sirayla(() => t.cozumle(adListesi(g, 30))) });
          return;
        }
        if (url.pathname === '/epg') {
          // Rehber TV'den bağımsız: TV kapalıyken de çalışır. Numara yalnız önbellekteki listeden
          // (TV'ye bağlanılmaz — kapalı TV'yi bu yüzden uyandırmayız).
          // Kanallar paralel: hepsi aynı günlük sayfayı bekler (tek indirme), geçit 30 sn'de vazgeçer.
          const sonuc = await Promise.all(adListesi(g, 20).map(async (ad) => {
            const k = t.liste ? kanalBul(t.liste, ad) : null;
            let p = null;
            if (rehber) { try { p = await zamanAsimi(rehber.kanal(ad), 25000, 'rehber'); } catch { /* yok */ } }
            return { ad, no: k ? k.no : null, simdi: p?.simdi || null, sonraki: p?.sonraki || null, kaynak: p?.kaynak || null };
          }));
          json(res, 200, { kanallar: sonuc });
          return;
        }
        if (url.pathname === '/kapat') {
          await sirada(t, () => t.kapat());
          log(`[tv] ${t.id} kapatıldı`);
          json(res, 200, { ok: true });
          return;
        }
      }
      json(res, 404, { hata: 'bilinmeyen uç' });
    } catch (e) {
      const kod = Number.isInteger(e?.kod) ? e.kod : 502;   // HttpHata, ZamanlayiciHata, KilitHata, EngelHata…
      if (res.headersSent) { res.end(); return; }
      json(res, kod, { hata: String(e.message || e).slice(0, 200) });
    }
  }

  return http.createServer((req, res) => {
    // Son güvence: işleyicide yakalanmayan bir hata süreci düşürmesin (async işleyicide ret = çıkış).
    isle(req, res).catch((e) => {
      log(`[tv-ajan] işlenmeyen hata: ${e?.message || e}`);
      try { if (!res.headersSent) json(res, 500, { hata: 'iç hata' }); else res.end(); } catch { /* yok say */ }
    });
  });
}

/** İki JPEG arasındaki hareket (agent/ekran-hareket.py, PIL): geçici dosyalar ajanın özel geçici dizininde. */
async function ekranHareketi(a, b) {
  const dizin = await mkdtemp(join(tmpdir(), 'hareket-'));
  try {
    await Promise.all([writeFile(join(dizin, 'a.jpg'), a), writeFile(join(dizin, 'b.jpg'), b)]);
    const { stdout } = await execFileP(SISTEM_PYTHON, ['-I', EKRAN_HAREKET, join(dizin, 'a.jpg'), join(dizin, 'b.jpg')], { timeout: 20000 });
    const fark = Number(stdout.trim());
    if (!Number.isFinite(fark)) throw new Error('ekran-hareket.py anlaşılmayan çıktı');
    return fark;
  } finally {
    await rm(dizin, { recursive: true, force: true });
  }
}

/** Ekran hareketi ölçümü kurulu mu (sistem Python'u + PIL): değilse null — her ölçümde boşuna iki ekran görüntüsü alınmasın. */
async function hareketOlcucu(log) {
  if (!existsSync(SISTEM_PYTHON)) { log(`[apple-tv] ekran hareketi ölçümü kapalı: ${SISTEM_PYTHON} yok`); return null; }
  try {
    await execFileP(SISTEM_PYTHON, ['-I', '-c', 'import PIL'], { timeout: 15000 });
    return ekranHareketi;
  } catch {
    log('[apple-tv] ekran hareketi ölçümü kapalı: PIL kurulu değil (python3-pil)');
    return null;
  }
}

function tvleriYukle(rehber, teshisDizini, atv = null, hareketOlc = null) {
  if (!existsSync(TVLER_YOLU)) throw new Error(`TV listesi yok: ${TVLER_YOLU}`);
  const liste = JSON.parse(readFileSync(TVLER_YOLU, 'utf8'));
  const anahtarlar = existsSync(ANAHTAR_YOLU) ? JSON.parse(readFileSync(ANAHTAR_YOLU, 'utf8')) : {};
  return liste.map((t) => {
    if (!/^[a-z0-9-]{1,20}$/.test(t.id || '') || !t.ip) throw new Error(`geçersiz TV kaydı: ${JSON.stringify(t)}`);
    if (t.mac && !MAC_KALIBI.test(t.mac)) throw new Error(`geçersiz MAC (${t.id}): ${t.mac}`);
    if (t.appletv && (!/^[\d.]{7,15}$/.test(t.appletv.ip || '') || !/^[A-Za-z0-9:-]{6,40}$/.test(t.appletv.id || ''))) {
      throw new Error(`geçersiz Apple TV kaydı (${t.id})`);
    }
    if (t.appletv?.giris && !/^com\.webos\.app\.hdmi\d$/.test(t.appletv.giris)) throw new Error(`geçersiz Apple TV girişi (${t.id}): ${t.appletv.giris}`);
    return new Tv(t, anahtarlar[t.ip] || null, { rehber, teshisDizini, log: console.log, atv, hareketOlc });
  });
}

// Doğrudan çalıştırıldığında sunucuyu başlat (testler içe aktarınca başlatmaz).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (TOKEN.length < 32) {
    console.error('TV_AJAN_TOKEN tanımlı değil ya da kısa (≥ 32 karakter). Üretmek için: openssl rand -hex 32');
    process.exit(1);
  }
  const rehber = new Rehber({ dizin: DURUM_DIZINI, log: console.log });
  const kanalSirasi = new KanalSirasi({ dizin: DURUM_DIZINI, oneriDizini: join(HERE, 'oneriler'), log: console.log });
  const atv = new AppleTvKopru({ python: PYATV_PYTHON, betik: ATV_YARDIMCI, depo: join(DURUM_DIZINI, 'pyatv.conf'), log: console.log });
  const tvListesi = existsSync(TVLER_YOLU) ? JSON.parse(readFileSync(TVLER_YOLU, 'utf8')) : [];
  const hareketOlc = tvListesi.some((t) => t.appletv) ? await hareketOlcucu(console.log) : null;
  const tvler = tvleriYukle(rehber, join(DURUM_DIZINI, 'teshis'), atv, hareketOlc);
  const tvBul = (id) => tvler.find((t) => t.id === id);
  // "Geri dön" + Program görevleri. Görev kanalın gerçekten ekrana geldiğini doğrular (dogrula); "geri dön"
  // TV o arada kapatıldıysa ya da başka bir şeye geçildiyse açmaz (bkz. gorevYurutucu).
  const zamanlayici = new Zamanlayici({ dosya: join(DURUM_DIZINI, 'zamanlayici.json'), log: console.log, ...gorevYurutucu({ tvBul, kanalSirasi }) });
  await zamanlayici.yukle();
  zamanlayici.baslat();
  // Önceki çalışmadan yarım kalmış kanal sıralama işi: TV hâlâ kanal düzenleyicisindeyse bir kez EXIT (başka bir
  // şey izleniyorsa dokunulmaz — EXIT bir uygulamayı da kapatabilir).
  for (const id of await kanalSirasi.yukle()) {
    const t = tvBul(id);
    if (!t) continue;
    t.sirayla(async () => {
      const on = await t.iste('ssap://com.webos.applicationManager/getForegroundAppInfo', null, 3000);
      if (on.appId !== 'com.webos.app.channeledit') return 'TV düzenleyicide değil, dokunulmadı';
      await t.tus('EXIT');
      return 'TV düzenleyiciden çıkarıldı (EXIT)';
    }).then((ne) => console.log(`[kanal-sirasi] ${id}: yarım iş — ${ne}`), (e) => console.log(`[kanal-sirasi] ${id}: yarım iş — TV'ye ulaşılamadı (${e.message})`));
  }
  // İzleme kaydı (kumanda → İzleme geçmişi): yalnız açıkça istenirse — kişisel veri, ajanın durum dizininde kalır.
  let izleme = null;
  let youtube = null;
  if (process.env.TV_AJAN_IZLEME === '1') {
    // İzlenen YouTube videosunun bağlantısı için (Apple TV video kimliği vermiyor) — önbellek izleme dizininde.
    youtube = new YoutubeBulucu({ dizin: join(DURUM_DIZINI, 'izleme'), log: console.log });
    await youtube.yukle();
    izleme = new IzlemeKaydi({ dizin: join(DURUM_DIZINI, 'izleme'), tvler, log: console.log, atla: (id) => kanalSirasi.mesgul(id) });
    await izleme.yukle();
    izleme.baslat();
    console.log('[izleme] kayıt açık (30 sn\'de bir, 365 gün saklanır)');
  }
  // YouTube engelleri: kurallar durum dizininde; bekçi yalnız kural varken ve TV Apple TV girişindeyken sorar.
  let engel = null;
  let engelBekcisi = null;
  if (tvler.some((t) => t.appletv)) {
    engel = new EngelListesi({ dizin: DURUM_DIZINI, log: console.log });
    await engel.yukle();
    engelBekcisi = new EngelBekcisi({ tvler, liste: engel, youtube, log: console.log });
    engelBekcisi.baslat();
    console.log(`[engel] bekçi açık (${engel.durum().kurallar.length} kural${engel.veri.acik ? '' : ', engelleme KAPALI'})`);
  }
  // TV kilidi: kilitli TV'ye açma komutu gitmez (Tv.kilitDenetle); kendi kumandasıyla açılırsa bekçi kapatır.
  const kilit = new TvKilidi({ dizin: DURUM_DIZINI, log: console.log });
  await kilit.yukle();
  for (const t of tvler) t.kilit = kilit;
  const kilitBekcisi = new KilitBekcisi({ tvler, kilit, log: console.log });
  kilitBekcisi.baslat();
  const kilitli = Object.keys(kilit.durum().kilitler);
  console.log(`[kilit] bekçi açık${kilitli.length ? ` · kilitli: ${kilitli.join(', ')}` : ''}`);
  const sunucu = sunucuKur(tvler, { rehber, zamanlayici, kanalSirasi, izleme, youtube, engel, kilit });
  sunucu.listen(PORT, HOST, () => {
    const ozet = tvler.map((t) => `${t.id}${t.anahtar ? '' : ' (anahtarsız!)'}${t.mac ? '' : ' (MAC yok — açılamaz)'}`).join(', ');
    console.log(`[tv-ajan] ${HOST}:${PORT} dinleniyor · TV'ler: ${ozet} · durum: ${DURUM_DIZINI} · saat dilimi: ${SAAT_DILIMI}${DUZ_WS ? ' · ⚠️ düz ws:3000 izinli' : ''}`);
  });
  // Rehberi önceden ısıt: arayüzün ilk isteği 3,3 MB'lık sayfayı beklemesin. 3 saatte bir tazele.
  const isit = () => rehber.gun(trGunu(Date.now())).catch(() => {});
  isit();
  setInterval(isit, 3 * 60 * 60 * 1000).unref();
  let kapaniyor = false;
  const kapan = async () => {
    if (kapaniyor) return;
    kapaniyor = true;
    zamanlayici.durdur();
    izleme?.durdur();
    engelBekcisi?.durdur();
    kilitBekcisi.durdur();
    // Süren kanal sıralama işi taşımanın ortasında kesilmesin: dur denir, en çok 20 sn beklenir.
    if (tvler.some((t) => kanalSirasi.calisiyor(t.id))) console.log('[kanal-sirasi] kapanış: süren iş durduruluyor…');
    await kanalSirasi.hepsiniDurdur(20000);
    for (const t of tvler) t.birak();
    atv.kapat();
    sunucu.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', kapan);
  process.on('SIGINT', kapan);
}
