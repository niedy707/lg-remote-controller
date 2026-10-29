/**
 * YouTube engelleri (ebeveyn denetimi) — listedeki bir video, kanal ya da anahtar kelime Apple TV'deki YouTube'da
 * OYNAMAYA başlayınca TV'nin ortasında engel mesajı çıkar ve oynatma iki kademede durdurulur:
 *   1. oynatma → duraklat + oynatıcıdan çık (geri ×2; tek "geri" yalnız oynatıcı düğmelerini gizliyor — ölçüldü)
 *   2. yine oynatılırsa → YouTube uygulamasını kapat, ardından ekranın ortasında UYARI (10 sn).
 * Kademe aynı video 10 dk içinde yeniden oynatıldıkça artar; başka video ya da 10 dk sessizlik sayacı sıfırlar.
 *
 * Kurallar (`<dizin>/engeller.json`, ajanın durum dizininde — kişisel veri, hiçbir yere gönderilmez):
 *   video  — link verilir (youtube.com/watch?v=, youtu.be/, /shorts/, /live/); başlık+kanal oEmbed'den alınır.
 *            Apple TV video kimliği VERMİYOR (bkz. youtube-bul.mjs) — eşleşme başlık+kanal (ya da çözülmüş kimlik).
 *   kanal  — link (youtube.com/@ad, /channel/UC…, /c/, /user/), kanalın görünen adı ya da tur: 'kanal' ile bir
 *            VİDEO linki (o videonun kanalı). Apple TV kanalı görünen adıyla bildirir; ad kanal sayfasından ya da
 *            videonun oEmbed bilgisinden okunur.
 *   kelime — başlıkta ya da kanal adında bir sözcüğün BAŞINDA geçerse ("deniz" → "Denizler" tutar, "at" → "kat"
 *            tutmaz). Büyük/küçük harf, Türkçe harf ve aksan farkı gözetilmez.
 *
 * Ekrandaki metinler ayarlanabilir (`mesaj`: her engelde, `uyari`: 2. kademede YouTube kapatıldıktan sonra) ve
 * aynı dosyada saklanır; ayar yoksa aşağıdaki nötr varsayılanlar gösterilir. Satır kuralları satirlar.mjs'de.
 *
 * İşlem kaydı (`islemler`): kural eklendi / silindi, engelleme açıldı / kapatıldı, metin değişti — kaynak: panel
 * ya da dogrudan; her işlemi ayrıca sormaya gerek kalmadan sonradan görülebilsin. Kullanıcının isteğiyle yapılan
 * değişiklik diske yazılamazsa istek 500 alır ("kaydedildi" denmez); bekçinin olay kaydı yazılamazsa yalnız günlük.
 *
 * Bekçi yalnız TV açık ve Apple TV girişindeyken Apple TV'ye sorar (soru Apple TV'yi, o da CEC ile TV'yi
 * uyandırabilir — gece kapalı TV'yi açmamak için). Kural yoksa ya da engelleme kapalıysa hiç sormaz.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { satirlariHazirla } from './satirlar.mjs';

/** Her engelde ekranın ortasında (varsayılan; `mesaj` ayarıyla değişir). */
export const MESAJ = ['🚫 Bu video engellendi'];
/** 2. kademede, YouTube kapatıldıktan sonra ekranın ortasında (varsayılan; `uyari` ayarıyla değişir). */
export const UYARI = ['⚠️ Bu içerik engelli.', 'Tekrar açılırsa YouTube kapatılır.'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const EN_COK_KURAL = 500;
const EN_COK_OLAY = 200;
const KADEME_MS = 10 * 60 * 1000;

/** Karşılaştırma için katlama: Türkçe küçük harf, aksan/nokta yok (İ/I/ı/i → i, ş → s …), boşluk tek. */
export const katla = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('tr')
  .replace(/ı/g, 'i').replace(/\s+/g, ' ').trim();

/** Link → { tur: 'video', id } | { tur: 'kanal', yol } | null (link değil). */
export function linkCoz(metin) {
  const s = String(metin || '').trim();
  if (!/^(https?:\/\/)?([a-z0-9-]+\.)*(youtube\.com|youtu\.be)(\/|$)/i.test(s)) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1, 12);
    return VIDEO_ID.test(id) ? { tur: 'video', id } : null;
  }
  if (host !== 'youtube.com') return null;
  const v = u.searchParams.get('v');
  if (v && VIDEO_ID.test(v)) return { tur: 'video', id: v };
  const m = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
  if (m) return { tur: 'video', id: m[1] };
  const k = /^\/(@[^/?#]+|channel\/UC[A-Za-z0-9_-]{22}|c\/[^/?#]+|user\/[^/?#]+)/.exec(u.pathname);
  if (k) {
    try { return { tur: 'kanal', yol: decodeURIComponent(k[1]) }; } catch { return null; }
  }
  return null;
}

const htmlCoz = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const kacir = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Kanal sayfasından görünen ad (og:title ya da channelMetadataRenderer). */
export function kanalAdiAyikla(html) {
  const m = /"channelMetadataRenderer":\{"title":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { /* og:title'a düş */ } }
  const og = /<meta property="og:title" content="([^"]*)"/.exec(html);
  return og ? htmlCoz(og[1]) : null;
}

export class EngelListesi {
  constructor({ dizin, getir = fetch, simdi = Date.now, log = () => {} }) {
    Object.assign(this, { dosya: join(dizin, 'engeller.json'), getir, simdi, log });
    this.veri = { acik: true, kurallar: [], olaylar: [], islemler: [], mesaj: null, uyari: null };
    this.yaziliyor = Promise.resolve();
  }

  async yukle() {
    try {
      const j = JSON.parse(await readFile(this.dosya, 'utf8'));
      const satirlar = (x) => (Array.isArray(x) && x.every((s) => typeof s === 'string') && x.length ? x : null);
      this.veri = {
        acik: j.acik !== false,
        kurallar: Array.isArray(j.kurallar) ? j.kurallar : [],
        olaylar: Array.isArray(j.olaylar) ? j.olaylar : [],
        islemler: Array.isArray(j.islemler) ? j.islemler : [],
        mesaj: satirlar(j.mesaj),
        uyari: satirlar(j.uyari),
      };
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[engel] kayıt okunamadı (${e.message}) — boş listeyle başlanıyor`);
    }
  }

  etkinMi() { return this.veri.acik && this.veri.kurallar.length > 0; }

  /** Her engelde gösterilen satırlar (ayar yoksa varsayılan). */
  mesaj() { return this.veri.mesaj?.length ? this.veri.mesaj : MESAJ; }
  /** 2. kademe uyarısının satırları (ayar yoksa varsayılan). */
  uyari() { return this.veri.uyari?.length ? this.veri.uyari : UYARI; }

  durum() {
    return {
      acik: this.veri.acik, kurallar: this.veri.kurallar,
      olaylar: this.veri.olaylar.slice(-50).reverse(), islemler: this.veri.islemler.slice(-50).reverse(),
      mesaj: this.mesaj(), uyari: this.uyari(),
    };
  }

  _islem(kayit) {
    this.veri.islemler.push({ id: randomUUID().slice(0, 8), zaman: this.simdi(), ...kayit });
    if (this.veri.islemler.length > EN_COK_OLAY) this.veri.islemler = this.veri.islemler.slice(-EN_COK_OLAY);
  }

  /**
   * Ayarlar: `acik` (engelleme açık/kapalı), `mesaj` ve `uyari` (ekrandaki satırlar; boş → varsayılan).
   * Verilmeyen alan değişmez. Metinler satirlar.mjs kuralıyla doğrulanır; geçersizse hiçbir alan değişmez.
   */
  async ayarla({ acik, mesaj, uyari } = {}, kaynak = null) {
    if (acik === undefined && mesaj === undefined && uyari === undefined) throw new EngelHata(400, 'acik, mesaj ya da uyari gerekli');
    const yeniMesaj = mesaj === undefined ? undefined : satirlariHazirla(mesaj);
    const yeniUyari = uyari === undefined ? undefined : satirlariHazirla(uyari);
    const k = kaynak ? { kaynak } : {};
    if (acik !== undefined) {
      this.veri.acik = !!acik;
      this._islem({ ne: this.veri.acik ? 'acildi' : 'kapatildi', ...k });
    }
    if (yeniMesaj !== undefined) {
      this.veri.mesaj = yeniMesaj.length ? yeniMesaj : null;
      this._islem({ ne: 'mesaj-degisti', ...k });
    }
    if (yeniUyari !== undefined) {
      this.veri.uyari = yeniUyari.length ? yeniUyari : null;
      this._islem({ ne: 'uyari-degisti', ...k });
    }
    await this._kaydetIstek();
    return this.durum();
  }

  /**
   * Kural ekler. `tur` verilmezse: video/kanal linki kendisi belirler, düz metin anahtar kelimedir;
   * düz metni kanal adı olarak eklemek için tur: 'kanal'.
   */
  async ekle({ metin, tur = null }, kaynak = null) {
    const s = String(metin || '').trim();
    if (!s || s.length > 300) throw new EngelHata(400, 'link, kanal adı ya da kelime gerekli (en çok 300 karakter)');
    if (tur && !['video', 'kanal', 'kelime'].includes(tur)) throw new EngelHata(400, 'tür video, kanal ya da kelime olmalı');
    if (this.veri.kurallar.length >= EN_COK_KURAL) throw new EngelHata(400, `en çok ${EN_COK_KURAL} kural`);
    const link = linkCoz(s);
    let kural;
    if (link?.tur === 'video' && tur === 'kanal') {
      const v = await this._videoBilgisi(link.id);
      if (!v.kanal) throw new EngelHata(502, 'videonun kanalı okunamadı — kanal linkini ya da adını verin');
      kural = { tur: 'kanal', deger: v.kanal, link: v.kanalLink || `https://www.youtube.com/watch?v=${link.id}`, ornek: v.baslik };
    } else if (link?.tur === 'video') {
      const { baslik, kanal } = await this._videoBilgisi(link.id);
      kural = { tur: 'video', videoId: link.id, deger: link.id, link: `https://www.youtube.com/watch?v=${link.id}`, baslik, kanal };
    } else if (link?.tur === 'kanal') {
      const ad = await this._kanalAdi(link.yol);
      if (!ad) throw new EngelHata(502, 'kanalın adı okunamadı — kanal adını yazıp "kanal" olarak ekleyin');
      kural = { tur: 'kanal', deger: ad, link: `https://www.youtube.com/${link.yol}` };
    } else if (tur === 'video') {
      throw new EngelHata(400, 'video için YouTube linki gerekli');
    } else {
      kural = { tur: tur === 'kanal' ? 'kanal' : 'kelime', deger: s };
    }
    const ayni = this.veri.kurallar.find((r) => r.tur === kural.tur && katla(r.deger) === katla(kural.deger));
    if (ayni) return { kural: ayni, varmis: true };
    kural = { id: randomUUID().slice(0, 8), ...kural, eklendi: this.simdi() };
    this.veri.kurallar.push(kural);
    this._islem({ ne: 'eklendi', tur: kural.tur, deger: kural.tur === 'video' ? (kural.baslik || kural.videoId) : kural.deger, ...(kaynak ? { kaynak } : {}) });
    await this._kaydetIstek();
    return { kural, varmis: false };
  }

  async sil(id, kaynak = null) {
    const r = this.veri.kurallar.find((x) => x.id === id);
    if (!r) throw new EngelHata(404, 'kural yok');
    this.veri.kurallar = this.veri.kurallar.filter((x) => x.id !== id);
    this._islem({ ne: 'silindi', tur: r.tur, deger: r.tur === 'video' ? (r.baslik || r.videoId) : r.deger, ...(kaynak ? { kaynak } : {}) });
    await this._kaydetIstek();
  }

  /** Oynayan içerik bir kurala uyuyorsa o kural, yoksa null. */
  eslesen({ baslik, kanal, videoId = null }) {
    const b = katla(baslik);
    const k = katla(kanal);
    for (const r of this.veri.kurallar) {
      if (r.tur === 'video') {
        if (videoId && r.videoId === videoId) return r;
        if (r.baslik && katla(r.baslik) === b && (!r.kanal || katla(r.kanal) === k)) return r;
      } else if (r.tur === 'kanal') {
        if (k && katla(r.deger) === k) return r;
      } else if (r.tur === 'kelime') {
        const w = katla(r.deger);
        if (w && new RegExp(`(^|[^\\p{L}\\p{N}])${kacir(w)}`, 'u').test(`${b} ${k}`)) return r;
      }
    }
    return null;
  }

  /** Başlığı alınamamış video kuralı var mı (o zaman oynayanın kimliği çözülmeli). */
  kimlikGerekli() { return this.veri.kurallar.some((r) => r.tur === 'video' && !r.baslik); }

  async olayEkle(olay) {
    this.veri.olaylar.push({ id: randomUUID().slice(0, 8), zaman: this.simdi(), ...olay });
    if (this.veri.olaylar.length > EN_COK_OLAY) this.veri.olaylar = this.veri.olaylar.slice(-EN_COK_OLAY);
    await this._kaydet().catch(() => {});   // bekçinin kaydı: hata günlükte
  }

  async _videoBilgisi(id) {
    try {
      const r = await this.getir(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const kanalLink = /^https:\/\/www\.youtube\.com\//.test(j.author_url || '') ? j.author_url : null;
      return { baslik: j.title || null, kanal: j.author_name || null, kanalLink };
    } catch (e) {
      // Özel/silinmiş video: kural yine eklenir, eşleşme oynayanın çözülen kimliğiyle olur.
      this.log(`[engel] video bilgisi alınamadı (${id}): ${e.message}`);
      return { baslik: null, kanal: null };
    }
  }

  async _kanalAdi(yol) {
    try {
      const r = await this.getir(`https://www.youtube.com/${yol.split('/').map((x) => encodeURIComponent(x).replace(/^%40/, '@')).join('/')}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9' }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return kanalAdiAyikla(await r.text());
    } catch (e) {
      this.log(`[engel] kanal adı alınamadı (${yol}): ${e.message}`);
      return null;
    }
  }

  /** Yazımlar sırayla; dizin yoksa oluşturulur. Dönen söz hata verirse çağıran görür (günlüğe de yazılır). */
  _kaydet() {
    const metin = JSON.stringify(this.veri);
    const is = this.yaziliyor.catch(() => {}).then(async () => {
      await mkdir(dirname(this.dosya), { recursive: true });
      await writeFile(`${this.dosya}.tmp`, metin);
      await rename(`${this.dosya}.tmp`, this.dosya);
    });
    this.yaziliyor = is.catch((e) => this.log(`[engel] yazılamadı: ${e.message}`));
    return is;
  }

  /** Kullanıcı isteği yolunda: yazılamazsa 500. */
  async _kaydetIstek() {
    try { await this._kaydet(); } catch (e) {
      throw new EngelHata(500, `engel listesi diske kaydedilemedi (${e.code || e.message}) — değişiklik şimdilik geçerli, ajan yeniden başlarsa kaybolur`);
    }
  }
}

export class EngelHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

/**
 * Bekçi: her `aralikMs`'de Apple TV'si olan, açık ve Apple TV girişindeki TV'lere "ne oynuyor" diye sorar.
 * TV nesnesinden beklenen: `appledaOynayan()` (TV kapalı/başka girişte → null), `appleKomut(tus)`,
 * `appleUygulamaKapat()`, `uyariGoster(satirlar, ms)`. Ekrandaki satırlar listenin ayarından okunur.
 */
export class EngelBekcisi {
  constructor({ tvler, liste, youtube = null, aralikMs = 4000, bekle = (ms) => new Promise((r) => setTimeout(r, ms)), simdi = Date.now, log = () => {} }) {
    Object.assign(this, { tvler: tvler.filter((t) => t.appletv), liste, youtube, aralikMs, bekle, simdi, log });
    this.mesgul = new Set();
    this.kademe = new Map();   // tv → { anahtar, seviye, zaman }
    this.zamanlayici = null;
  }

  baslat() {
    if (this.zamanlayici || !this.tvler.length) return;
    const dongu = async () => {
      if (this.liste.etkinMi()) await Promise.all(this.tvler.map((tv) => this.denetle(tv).catch(() => {})));
      this.zamanlayici = setTimeout(dongu, this.aralikMs);
      this.zamanlayici.unref?.();
    };
    dongu();
  }

  durdur() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  async denetle(tv) {
    if (this.mesgul.has(tv.id)) return null;
    const o = await tv.appledaOynayan();
    if (!o || !/youtube/i.test(o.uygulama || '') || !o.baslik) return null;
    if (!['playing', 'loading', 'seeking'].includes(o.durum)) return null;   // duraklatılmışa dokunma
    let videoId = this.youtube?.onbellekte?.(o.baslik, o.sanatci) || null;
    if (!videoId && this.youtube && this.liste.kimlikGerekli()) this.youtube.bul({ baslik: o.baslik, kanal: o.sanatci, sure: o.sure }).catch(() => {});
    const kural = this.liste.eslesen({ baslik: o.baslik, kanal: o.sanatci, videoId });
    if (!kural) return null;
    const anahtar = `${o.baslik}\u0000${o.sanatci || ''}`;
    const once = this.kademe.get(tv.id);
    const simdi = this.simdi();
    const seviye = once && once.anahtar === anahtar && simdi - once.zaman < KADEME_MS ? Math.min(once.seviye + 1, 2) : 1;
    this.kademe.set(tv.id, { anahtar, seviye, zaman: simdi });
    this.mesgul.add(tv.id);
    try {
      await this.uygula(tv, o, kural, seviye);
    } finally {
      this.mesgul.delete(tv.id);
    }
    return kural;
  }

  async uygula(tv, o, kural, seviye = 1) {
    const ne = ['', 'duraklatılıp oynatıcıdan çıkıldı', 'YouTube kapatıldı'][seviye];
    this.log(`[engel] ${tv.id}: "${o.baslik}" (${o.sanatci || '?'}) ${ne} — kural ${kural.tur}: ${kural.deger} (kademe ${seviye})`);
    await tv.appleKomut('pause').catch((e) => this.log(`[engel] durdurulamadı: ${e.message}`));
    // Ortadaki pencere: 1. kademede 8 sn; 2. kademede YouTube kapatılırken 4 sn, ardından uyarı (beklenmez — tuşlar sürer).
    tv.uyariGoster(this.liste.mesaj(), seviye === 1 ? 8000 : 4000).catch(() => {});
    if (seviye === 1) {
      await this.bekle(800);
      await tv.appleKomut('menu').catch(() => {});   // ilk "geri" oynatıcı düğmelerini gizler,
      await this.bekle(700);
      await tv.appleKomut('menu').catch(() => {});   // ikincisi oynatıcıdan çıkar
    } else {
      await this.bekle(1500);                        // mesaj görünsün
      await tv.appleUygulamaKapat().catch((e) => this.log(`[engel] YouTube kapatılamadı: ${e.message}`));
      await this.bekle(1000);
      await tv.uyariGoster(this.liste.uyari(), 10000).catch(() => {});   // pencere 10 sn ekranda kalır
    }
    await this.liste.olayEkle({ tv: tv.id, baslik: o.baslik, kanal: o.sanatci || null, kural: { id: kural.id, tur: kural.tur, deger: kural.deger }, seviye });
    // Duraklatma tuşu kaçtıysa (hâlâ aynı video oynuyorsa) bir kez daha duraklat — kademe artmaz.
    await this.bekle(2500);
    const s = await tv.appledaOynayan().catch(() => null);
    if (s && s.durum === 'playing' && s.baslik === o.baslik && seviye < 2) await tv.appleKomut('pause').catch(() => {});
  }
}
