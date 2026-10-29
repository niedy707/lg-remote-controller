/**
 * TV kilidi (ebeveyn denetimi): kilitli TV açılamaz.
 *  - Kumandanın ve zamanlayıcının açma komutları hiç uygulanmaz (Tv.kilitDenetle → 423).
 *  - TV kendi kumandasıyla (ya da Apple TV'nin CEC'iyle) açılırsa bekçi birkaç saniye içinde görür: ekranın
 *    ortasında kilit mesajı (5 sn), kapsam "TV + Apple TV" ise Apple TV uyutulur, sonra TV kapatılır. Her deneme
 *    olay olarak kaydedilir (kumanda arayüzü bunu telefona bildirebilir).
 * Kilit süreli (`bitis`, ms) ya da süresiz (`bitis: null`); süre dolunca kendiliğinden kalkar.
 * Mesaj satırları `mesaj` ayarında (kişiye özel metin koda değil ajanın durum dizinine yazılır).
 * Olay kaydı (`olaylar`): kilitlendi / acildi / suresi-doldu (kaynak: panel ya da dogrudan) ve kapatildi (kilitli TV
 * açılıp kapatıldı) — her işlemi ayrıca sormaya gerek kalmadan sonradan kimin neyi ne zaman yaptığı görülebilsin.
 * Kayıt <dizin>/kilit.json — ajanın durum dizininde, kişisel veri; hiçbir yere gönderilmez. Kullanıcının isteğiyle
 * yapılan değişiklik diske yazılamazsa istek 500 alır (kilit bellekte geçerlidir ama yeniden başlatmada kalkar —
 * "kaydedildi" denmez); bekçinin olay kaydı yazılamazsa yalnız günlüğe düşer.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { satirlariHazirla } from './satirlar.mjs';

export const KILIT_MESAJI = ['🔒 Bu TV kilitlidir, izlenemez!'];
const KAPSAMLAR = new Set(['tv', 'tv+apple']);
const EN_COK_DK = 30 * 24 * 60;
const EN_COK_OLAY = 200;

export class KilitHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

export class TvKilidi {
  constructor({ dizin, simdi = Date.now, log = () => {} }) {
    Object.assign(this, { dosya: join(dizin, 'kilit.json'), simdi, log });
    this.veri = { kilitler: {}, olaylar: [], mesaj: null };
    this.yaziliyor = Promise.resolve();
  }

  async yukle() {
    try {
      const j = JSON.parse(await readFile(this.dosya, 'utf8'));
      this.veri = { kilitler: j.kilitler && typeof j.kilitler === 'object' ? j.kilitler : {}, olaylar: Array.isArray(j.olaylar) ? j.olaylar : [], mesaj: Array.isArray(j.mesaj) ? j.mesaj : null };
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[kilit] kayıt okunamadı (${e.message}) — kilit yok sayılıyor`);
    }
  }

  /** TV kilitliyse { bitis, zaman, kapsam }, değilse null. Süresi dolan kilit burada kalkar. */
  bilgi(tvId) {
    const k = this.veri.kilitler[tvId];
    if (!k) return null;
    if (k.bitis != null && k.bitis <= this.simdi()) {
      delete this.veri.kilitler[tvId];
      this.log(`[kilit] ${tvId}: süre doldu, kilit kalktı`);
      this.veri.olaylar.push({ id: randomUUID().slice(0, 8), zaman: this.simdi(), tv: tvId, ne: 'suresi-doldu' });
      this._kaydet().catch(() => {});   // hata günlükte (_kaydet)
      return null;
    }
    return k;
  }

  durum() {
    const kilitler = {};
    for (const id of Object.keys(this.veri.kilitler)) { const k = this.bilgi(id); if (k) kilitler[id] = k; }
    return { kilitler, olaylar: this.veri.olaylar.slice(-50).reverse(), mesaj: this.mesaj() };
  }

  /** TV'de gösterilecek satırlar (ayar yoksa varsayılan). */
  mesaj() { return this.veri.mesaj && this.veri.mesaj.length ? this.veri.mesaj : KILIT_MESAJI; }

  /** Mesaj satırları: dizi ya da "\n" ile ayrılmış metin (bkz. satirlar.mjs). Boş → varsayılan. */
  async mesajAyarla(m) {
    const satirlar = satirlariHazirla(m);
    this.veri.mesaj = satirlar.length ? satirlar : null;
    await this._kaydetIstek();
    return this.mesaj();
  }

  /**
   * `dk` null → süresiz; aksi halde 1 dk – 30 gün. `kapsam`: 'tv' (yalnız TV kapatılır) ya da 'tv+apple'
   * (kapatmadan önce Apple TV de uyutulur — Apple TV'nin kumandası TV'yi CEC ile yeniden açamasın).
   */
  async kilitle(tvId, dk = null, kapsam = 'tv+apple', kaynak = null) {
    if (dk != null && !(Number.isInteger(dk) && dk >= 1 && dk <= EN_COK_DK)) throw new KilitHata(400, `süre 1 dk – ${EN_COK_DK / 1440} gün ya da süresiz olmalı`);
    if (!KAPSAMLAR.has(kapsam)) throw new KilitHata(400, 'kapsam tv ya da tv+apple olmalı');
    const zaman = this.simdi();
    this.veri.kilitler[tvId] = { bitis: dk == null ? null : zaman + dk * 60000, zaman, kapsam };
    this._olay({ tv: tvId, ne: 'kilitlendi', dk, kapsam, ...(kaynak ? { kaynak } : {}) });
    await this._kaydetIstek();
    return this.veri.kilitler[tvId];
  }

  async ac(tvId, kaynak = null) {
    const vardi = !!this.veri.kilitler[tvId];
    delete this.veri.kilitler[tvId];
    if (vardi) this._olay({ tv: tvId, ne: 'acildi', ...(kaynak ? { kaynak } : {}) });
    await this._kaydetIstek();
  }

  _olay(olay) {
    this.veri.olaylar.push({ id: randomUUID().slice(0, 8), zaman: this.simdi(), ...olay });
    if (this.veri.olaylar.length > EN_COK_OLAY) this.veri.olaylar = this.veri.olaylar.slice(-EN_COK_OLAY);
  }

  /** Bekçinin olayı: yazılamazsa yalnız günlük (bekçi işine devam eder). */
  async olayEkle(olay) {
    this._olay(olay);
    await this._kaydet().catch(() => {});
  }

  /** Yazımlar sırayla; dizin yoksa oluşturulur. Dönen söz hata verirse çağıran görür (günlüğe de yazılır). */
  _kaydet() {
    const metin = JSON.stringify(this.veri);
    const is = this.yaziliyor.catch(() => {}).then(async () => {
      await mkdir(dirname(this.dosya), { recursive: true });
      await writeFile(`${this.dosya}.tmp`, metin);
      await rename(`${this.dosya}.tmp`, this.dosya);
    });
    this.yaziliyor = is.catch((e) => this.log(`[kilit] yazılamadı: ${e.message}`));
    return is;
  }

  /** Kullanıcı isteği yolunda: yazılamazsa 500. */
  async _kaydetIstek() {
    try { await this._kaydet(); } catch (e) {
      throw new KilitHata(500, `kilit diske kaydedilemedi (${e.code || e.message}) — şimdilik geçerli, ajan yeniden başlarsa kaybolur`);
    }
  }
}

/**
 * Bekçi: her `aralikMs`'de yalnız KİLİTLİ TV'lere "açık mısın" diye sorar; açıksa uyarı + kapat.
 * TV nesnesinden beklenen: `acikMi()`, `uyariGoster(satirlar, ms)`, `kapat()`; Apple TV'si varsa `appletv` + `appleUyut()`.
 */
export class KilitBekcisi {
  constructor({ tvler, kilit, aralikMs = 3000, mesajMs = 5000, bekle = (ms) => new Promise((r) => setTimeout(r, ms)), simdi = Date.now, log = () => {} }) {
    Object.assign(this, { tvler, kilit, aralikMs, mesajMs, bekle, simdi, log });
    this.mesgul = new Set();
    this.zamanlayici = null;
  }

  baslat() {
    if (this.zamanlayici) return;
    const dongu = async () => {
      await Promise.all(this.tvler.map((tv) => this.denetle(tv).catch(() => {})));
      this.zamanlayici = setTimeout(dongu, this.aralikMs);
      this.zamanlayici.unref?.();
    };
    dongu();
  }

  durdur() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  /** Kilitli ve açıksa kapatır; ne yapıldığını döner ('kapatildi' | 'kapali' | null = kilitli değil). */
  async denetle(tv) {
    const k = this.kilit.bilgi(tv.id);
    if (!k || this.mesgul.has(tv.id)) return null;
    this.mesgul.add(tv.id);
    try {
      if (!(await tv.acikMi())) return 'kapali';
      this.log(`[kilit] ${tv.id} kilitliyken açıldı — kapatılıyor`);
      await tv.uyariGoster(this.kilit.mesaj(), this.mesajMs).catch(() => {});   // okunsun diye bekler
      if (k.kapsam !== 'tv' && tv.appletv) await tv.appleUyut().catch((e) => this.log(`[kilit] ${tv.id} Apple TV uyutulamadı: ${e.message}`));
      try { await tv.kapat(); } catch (e) { this.log(`[kilit] ${tv.id} kapatılamadı: ${e.message}`); }
      await this.kilit.olayEkle({ tv: tv.id, ne: 'kapatildi' });
      await this.bekle(4000);   // kapanma sürerken yeniden "açık" görüp ikinci kez kapatmasın
      return 'kapatildi';
    } finally {
      this.mesgul.delete(tv.id);
    }
  }
}
