/**
 * Yayın akışı (EPG) — "şu an ne var" bilgisini TV'den değil, yayın rehberinden alır.
 *
 * NEDEN TV'DEN DEĞİL: SM8000 başka kanallar için ertesi günün akışını veriyor, webOS 26'lı
 * bir model canlı yayında değilken hiç vermiyor (ölçüldü). Rehber kanala bağlı; TV kapalıyken de çalışır.
 *
 * KAYNAKLAR (yöntem açık kaynak iptv-org/epg yapılandırmalarından öğrenildi, kod yazıldı):
 *   1. digiturk.com.tr — günün TÜM kanallarını tek HTML sayfasında verir (~3,3 MB). Asıl kaynak.
 *      Türkiye'deki bir ev bağlantısından çalışıyor; veri merkezi IP'lerine 403 dönüyor → ev
 *      ağındaki ajan çeker.
 *   2. tvplus.com.tr — kanal başına JSON. Yedek; her ağdan ulaşılamayabiliyor (bağlantı kurulamayan
 *      ağ görüldü) — ulaşılamazsa 15 dk denenmez.
 *
 * Saatler: kaynaklar Türkiye yayınıdır, sayfalardaki saatler İstanbul saatidir (KAYNAK_TZ — ayrıştırma ve
 * günlük sayfa seçimi buna göre). Kullanıcıya dönen "SS:DD" metinleri yerel saattir (TV_AJAN_TZ, saat.mjs).
 *
 * Önbellek sınırlı: bellekte yalnız dün/bugün/yarın tutulur, diskte 7 günden eski günlük sayfalar silinir
 * (7/24 çalışan küçük bir bilgisayarda bellek ve SD kart yavaş yavaş dolmasın).
 */

import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { anaAd } from './kanal-bul.mjs';
import { KAYNAK_TZ, parcalar, yerelAn, saatDk, gunMetni, gunEkle } from './saat.mjs';

const GUN_MS = 24 * 60 * 60 * 1000;
const TAZELIK_MS = 6 * 60 * 60 * 1000;   // bir günün sayfası en çok 6 saatte bir yeniden çekilir
const HATA_BEKLEME_MS = 15 * 60 * 1000;  // başarısız çekişten sonra 3,3 MB'ı hemen yeniden isteme
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const DISK_SAKLA_GUN = 7;

/**
 * tvplus kanal kimlikleri (iptv-org/epg `sites/tvplus.com.tr/tvplus.com.tr.channels.xml`). Anahtar: anaAd.
 * Liste genişletildi çünkü digiturk'ün sayfasında ATV, TV8, Kanal D gibi kanalların akşam kuşağı
 * (20:00 sonrası) EKSİK geliyor — "şu an ne var" o saatlerde yalnız bu yedekten gelebiliyor.
 */
export const TVPLUS_KIMLIK = {
  KANALD: '88', STAR: '89', SHOW: '130', HABERTURK: '87', CNNTURK: '158',
  ATV: '124', TV8: '134', TV85: '188', NOW: '93', NTV: '81', BLOOMBERGHT: '96', TRT1: '144',
  KANAL7: '90', BEYAZ: '135', HALK: '91', SOZCU: '4294', TRTHABER: '30', AHABER: '160', 360: '86',
};

/** Kaynağın (İstanbul) takvim günü: { y, m, d } ve ISO anahtarı. */
export function trGunu(ms) {
  const p = parcalar(ms, KAYNAK_TZ);
  const g = { y: p.y, m: p.m, d: p.d };
  g.anahtar = gunMetni(g);
  return g;
}

/** Kaynak gününün o saati (İstanbul duvar saati) → ms. */
const trAn = (g, saat, dakika) => yerelAn(g.y, g.m, g.d, saat, dakika, KAYNAK_TZ);

function varlikCoz(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * digiturk günlük rehber sayfası → Map(anaAd → { ad, programlar: [{ ad, bas, bit }] }).
 * Sayfa sırası zaman sırasıdır; bir program öncekinden erken saatte başlıyorsa gece yarısı geçilmiştir.
 */
export function digiturkAyristir(html, gun) {
  const sonuc = new Map();
  const bloklar = String(html).split(/class="[^"]*\bchannelContent\b[^"]*"/).slice(1);
  for (const b of bloklar) {
    const adM = /id="channelID"[^>]*value="([^"]*)"/.exec(b) || /value="([^"]*)"[^>]*id="channelID"/.exec(b);
    if (!adM) continue;
    const kanalAdi = varlikCoz(adM[1]);
    const programlar = [];
    let gunEk = 0;
    let onceki = -1;
    for (const p of b.split(/class="[^"]*\bchannelDetail\b[^"]*"/).slice(1)) {
      const saat = /time-hour">\s*(\d{1,2}):(\d{2})\s*</.exec(p);
      const sure = /totalMinute">[^<\d]*(\d+)\s*dk/i.exec(p);
      const baslik = /wholeDates-title"[^>]*title="([^"]*)"/.exec(p) || /wholeDates-title"[^>]*>([^<]*)</.exec(p);
      if (!saat || !sure || !baslik) continue;
      const dk = Number(saat[1]) * 60 + Number(saat[2]);
      if (dk < onceki) gunEk++;
      onceki = dk;
      const bas = trAn(gun, 0, 0) + gunEk * GUN_MS + dk * 60000;
      programlar.push({ ad: varlikCoz(baslik[1]), bas, bit: bas + Number(sure[1]) * 60000 });
    }
    if (!programlar.length) continue;
    const anahtar = anaAd(kanalAdi);
    if (!sonuc.has(anahtar)) sonuc.set(anahtar, { ad: kanalAdi, programlar });
  }
  return sonuc;
}

/** tvplus PlayBillList yanıtı → [{ ad, bas, bit }]. Saat biçimi: "2026-10-16 20:00:00 UTC+03:00". */
export function tvplusAyristir(json) {
  const liste = (json && Array.isArray(json.playbilllist)) ? json.playbilllist : [];
  const zaman = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC([+-])(\d{2}):?(\d{2})$/.exec(String(s || '').trim());
    if (!m) return null;
    const ofset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60000;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - ofset;
  };
  return liste
    .map((p) => ({ ad: varlikCoz(p.name || ''), bas: zaman(p.starttime), bit: zaman(p.endtime) }))
    .filter((p) => p.ad && p.bas != null && p.bit != null && p.bit > p.bas)
    .sort((a, b) => a.bas - b.bas);
}

/** Şu an süren program ve sonraki. Saatler ekran için yerel saatle (TV_AJAN_TZ) biçimlenir. */
export function simdiSonraki(programlar, an = Date.now()) {
  const p = [...(programlar || [])].sort((a, b) => a.bas - b.bas);
  const saat = (ms) => saatDk(ms);
  const bicim = (x) => (x ? { ad: x.ad, bas: saat(x.bas), bit: saat(x.bit), bitis: x.bit } : null);
  const i = p.findIndex((x) => x.bas <= an && an < x.bit);
  if (i >= 0) return { simdi: bicim(p[i]), sonraki: bicim(p[i + 1]) };
  return { simdi: null, sonraki: bicim(p.find((x) => x.bas > an)) };
}

/**
 * Rehber: günlük digiturk sayfalarını çeker, ayrıştırılmış hâlini diskte saklar (yeniden
 * başlatmada 3,3 MB'ı tekrar indirmemek için), kanal adıyla sorgulanır.
 */
export class Rehber {
  constructor({ dizin, fetchFn = globalThis.fetch, log = () => {}, simdi = () => Date.now() } = {}) {
    this.dizin = dizin;
    this.fetchFn = fetchFn;
    this.log = log;
    this.simdi = simdi;
    this.gunler = new Map();      // anahtar → { zaman, kanallar: Map }
    this.suren = new Map();       // anahtar → yükleme sözü (aynı gün iki kez çekilmesin)
    this.hatalar = new Map();     // anahtar → { zaman, hata } — kısa süre yeniden denenmez
    this.tvplusOnbellek = new Map();
    this.tvplusHata = -Infinity;  // tvplus ulaşılamazsa 15 dk denenmez (her istekte 10 sn beklenmesin)
    this.sonDiskBudama = null;
  }

  /** Bellekte dün/bugün/yarın dışını, diskte DISK_SAKLA_GUN günden eski günlük sayfaları siler. */
  async _buda() {
    const bugun = trGunu(this.simdi());
    const tut = new Set([-1, 0, 1].map((k) => gunMetni(gunEkle(bugun, k))));
    for (const k of [...this.gunler.keys()]) if (!tut.has(k)) this.gunler.delete(k);
    for (const k of [...this.hatalar.keys()]) if (!tut.has(k)) this.hatalar.delete(k);
    for (const k of [...this.tvplusOnbellek.keys()]) if (!tut.has(k.split(':')[1])) this.tvplusOnbellek.delete(k);
    if (!this.dizin || this.sonDiskBudama === bugun.anahtar) return;
    this.sonDiskBudama = bugun.anahtar;
    const sinir = gunMetni(gunEkle(bugun, -DISK_SAKLA_GUN));
    let dosyalar = [];
    try { dosyalar = await readdir(this.dizin); } catch { return; }
    for (const f of dosyalar) {
      const m = /^digiturk-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m && m[1] < sinir) await unlink(join(this.dizin, f)).catch(() => {});
    }
  }

  async _diskOku(g) {
    if (!this.dizin) return null;
    try {
      const j = JSON.parse(await readFile(join(this.dizin, `digiturk-${g.anahtar}.json`), 'utf8'));
      return { zaman: j.zaman, kanallar: new Map(j.kanallar) };
    } catch { return null; }
  }

  async _diskYaz(g, kayit) {
    if (!this.dizin) return;
    try {
      await mkdir(this.dizin, { recursive: true });
      const yol = join(this.dizin, `digiturk-${g.anahtar}.json`);
      await writeFile(yol + '.tmp', JSON.stringify({ zaman: kayit.zaman, kanallar: [...kayit.kanallar] }));
      await rename(yol + '.tmp', yol);
    } catch (e) { this.log(`[rehber] diske yazılamadı: ${e.message}`); }
  }

  async _digiturkCek(g) {
    const gunStr = `${String(g.m).padStart(2, '0')}/${String(g.d).padStart(2, '0')}/${g.y}`;
    const url = `https://www.digiturk.com.tr/Ajax/GetTvGuideFromDigiturk?Day=${encodeURIComponent(gunStr)}+00%3A00%3A00`;
    const r = await this.fetchFn(url, { headers: { 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`digiturk HTTP ${r.status}`);
    const kanallar = digiturkAyristir(await r.text(), g);
    // Sözleşme: sayfa geldi ama hiç kanal çıkmadıysa biçim değişmiştir — sessizce boş dönme.
    if (kanallar.size < 10) throw new Error(`digiturk sayfasından yalnız ${kanallar.size} kanal çıktı (biçim değişmiş olabilir)`);
    return kanallar;
  }

  /**
   * Bir günün digiturk verisi (bellek → disk → ağ).
   * `agdan: false` — yalnız önbellek. digiturk GEÇMİŞ günler için boş sayfa döndürüyor (ölçüldü:
   * dünün sayfası 0 kanal); dün ancak dün çekilip diske yazılmışsa vardır.
   */
  async gun(g, { agdan = true } = {}) {
    const simdi = this.simdi();
    let bellek = this.gunler.get(g.anahtar);
    if (!bellek) {
      const disk = await this._diskOku(g);
      if (disk) { this.gunler.set(g.anahtar, disk); bellek = disk; }
    }
    if (bellek && (simdi - bellek.zaman < TAZELIK_MS || !agdan)) return bellek.kanallar;
    if (!agdan) return new Map();
    const h = this.hatalar.get(g.anahtar);
    if (h && simdi - h.zaman < HATA_BEKLEME_MS) {
      if (bellek) return bellek.kanallar;
      throw h.hata;
    }
    if (!this.suren.has(g.anahtar)) {
      const soz = this._digiturkCek(g)
        .then(async (kanallar) => {
          this.hatalar.delete(g.anahtar);
          const kayit = { zaman: this.simdi(), kanallar };
          this.gunler.set(g.anahtar, kayit);
          await this._diskYaz(g, kayit);
          await this._buda();
          this.log(`[rehber] digiturk ${g.anahtar}: ${kanallar.size} kanal`);
          return kanallar;
        })
        .finally(() => this.suren.delete(g.anahtar));
      this.suren.set(g.anahtar, soz);
    }
    try {
      return await this.suren.get(g.anahtar);
    } catch (e) {
      if (!this.hatalar.has(g.anahtar)) this.log(`[rehber] ${g.anahtar}: ${e.message}`);
      this.hatalar.set(g.anahtar, { zaman: this.simdi(), hata: e });
      // Ağ hatasında bayat veri boş veriden iyidir.
      const eski = this.gunler.get(g.anahtar);
      if (eski) return eski.kanallar;
      throw e;
    }
  }

  async _tvplus(anahtar, g) {
    const kimlik = TVPLUS_KIMLIK[anahtar];
    if (!kimlik) return [];
    const ok = `${kimlik}:${g.anahtar}`;
    const o = this.tvplusOnbellek.get(ok);
    if (o && this.simdi() - o.zaman < TAZELIK_MS) return o.programlar;
    const taban = 'https://izmaottvsc14.tvplus.com.tr:33207/EPG/JSON';
    const kimlikR = await this.fetchFn(`${taban}/Authenticate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ terminaltype: 'webtv', terminalvendor: UA, osversion: 'Win32', userType: '3', utcEnable: '1', timezone: 'Europe/Istanbul' }),
    });
    const cerez = (kimlikR.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const z = (ms) => { const t = parcalar(ms, KAYNAK_TZ); const p = (n) => String(n).padStart(2, '0'); return `${t.y}${p(t.m)}${p(t.d)}${p(t.saat)}${p(t.dk)}00`; };
    const bas = trAn(g, 0, 0);
    const r = await this.fetchFn(`${taban}/PlayBillList`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cerez }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ type: '2', channelid: kimlik, begintime: z(bas), endtime: z(bas + GUN_MS), isFillProgram: 1 }),
    });
    if (!r.ok) throw new Error(`tvplus HTTP ${r.status}`);
    const programlar = tvplusAyristir(await r.json());
    this.tvplusOnbellek.set(ok, { zaman: this.simdi(), programlar });
    await this._buda();
    return programlar;
  }

  /**
   * Bir kanalın yayın akışı: şu andan `saat` saat ileriye kadar (Program penceresi: favori kanalların
   * akışı listelenir, program başladığında kanalı açan görev kurulabilir).
   * tvplus önce: günün TAMAMINI veriyor; digiturk'te bazı kanalların akşam kuşağı eksik (ölçüldü).
   * tvplus kimliği yoksa ya da tvplus yanıt vermezse digiturk (dün yalnız önbellekten).
   * @returns {Promise<Array<{ad:string, bas:number, bit:number}>>}
   */
  async akis(ad, { saat = 30 } = {}) {
    const anahtar = anaAd(ad);
    if (!anahtar) return [];
    const an = this.simdi();
    const son = an + saat * 3600e3;
    const bugun = trGunu(an);
    const yarin = trGunu(an + GUN_MS);
    let programlar = [];
    if (TVPLUS_KIMLIK[anahtar] && an - this.tvplusHata >= HATA_BEKLEME_MS) {
      try {
        for (const g of [trGunu(an - GUN_MS), bugun, yarin]) programlar = programlar.concat(await this._tvplus(anahtar, g));
      } catch (e) {
        this.tvplusHata = an;
        this.log(`[rehber] tvplus akış: ${e.message}`);
        programlar = [];
      }
    }
    if (!programlar.some((p) => p.bit > an)) {
      programlar = [];
      for (const [g, agdan] of [[trGunu(an - GUN_MS), false], [bugun, true], [yarin, true]]) {
        try {
          const k = (await this.gun(g, { agdan })).get(anahtar);
          if (k) programlar = programlar.concat(k.programlar);
        } catch { /* o gün yok */ }
      }
    }
    const gorulen = new Set();
    return programlar
      .filter((p) => p.bit > an && p.bas < son && !gorulen.has(p.bas) && gorulen.add(p.bas))
      .sort((a, b) => a.bas - b.bas)
      .map((p) => ({ ad: p.ad, bas: p.bas, bit: p.bit }));
  }

  /**
   * Kanal adına göre şu an/sonraki. Dün de istenir: gece yarısından sonra hâlâ süren program
   * dünün sayfasındadır.
   * @returns {{ simdi, sonraki, kaynak } | null}
   */
  async kanal(ad) {
    const anahtar = anaAd(ad);
    if (!anahtar) return null;
    const an = this.simdi();
    const bugun = trGunu(an);
    const dun = trGunu(an - GUN_MS);
    let programlar = [];
    // Her gün ayrı: dünün eksikliği bugünü engellemesin. Dün yalnız önbellekten (yukarıya bkz.).
    for (const [g, agdan] of [[dun, false], [bugun, true]]) {
      try {
        const k = (await this.gun(g, { agdan })).get(anahtar);
        if (k) programlar = programlar.concat(k.programlar);
      } catch { /* digiturk yok → tvplus denenir */ }
    }
    let sec = simdiSonraki(programlar, an);
    if (sec.simdi) return { ...sec, kaynak: 'digiturk' };
    if (TVPLUS_KIMLIK[anahtar] && an - this.tvplusHata >= HATA_BEKLEME_MS) {
      try {
        const tp = await this._tvplus(anahtar, bugun);
        const s2 = simdiSonraki(tp, an);
        if (s2.simdi) return { ...s2, kaynak: 'tvplus' };
      } catch (e) {
        this.tvplusHata = an;
        this.log(`[rehber] tvplus: ${e.message}`);
      }
    }
    return sec.sonraki ? { ...sec, kaynak: 'digiturk' } : null;
  }
}
