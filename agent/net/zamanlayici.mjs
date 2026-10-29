/**
 * Kumanda zamanlayıcısı — "Geri dön" sayacı ve "Program" görevleri.
 *
 *   geri-don  "X dk sonra şu kanala dön" (reklam arası). TV başına TEK sayaç; yenisi eskisinin
 *             yerine geçer. TV o arada kapatıldıysa ya da başka bir uygulamaya/girişe geçildiyse AÇMAZ,
 *             atlar (izleme bitmiş ya da başka bir şey izleniyor demektir).
 *   tek       "şu tarih ve saatte şu kanalı aç" ya da "şu mesajı göster".
 *   haftalik  "şu günlerde şu saatte şu kanalı aç / şu mesajı göster" (her gün / hafta içi / seçili günler).
 *
 * NEDEN AJANDA: telefon kilitliyken, geçit yeniden başlarken de çalışmalı. Zamanlayıcıyı istemcide
 * tutan ürünler ("uygulama çalışmıyorsa hiçbir şey yapamıyor") bu özelliği kaldırmak zorunda kaldı.
 *
 * KALICILIK: yaygın Node zamanlayıcı kütüphaneleri kalıcılık ve kaçırılan görev politikası vermiyor → tek JSON
 * dosyası, MUTLAK an saklanır ("8 dk" yeniden başlatmada baştan sayılmaz). Yazımlar tek kuyruktan, geçici
 * dosya + rename ile gider (eşzamanlı iki yazım dosyayı bozmasın); okunamayan dosya `.bozuk-<zaman>` adıyla
 * saklanır (ilk yazım eski görevlerin üzerine yazmasın). Kullanıcının isteğiyle yapılan bir değişiklik diske
 * yazılamazsa istek hata alır — "kaydedildi" deyip yeniden başlatmada görevi kaybetmek yok.
 * Tetikleme: göreve özel setTimeout + 30 sn'lik yoklama (uyku/saat sıçraması güvencesi).
 *
 * KAÇIRILAN GÖREV: geç yapılan kanal değişimi hiç yapılmamasından kötü olabilir (gece TV açmak gibi).
 * Tolerans içindeyse BİR kez çalışır, dışındaysa "kacirildi" olarak geçmişe yazılır ve çalışmaz;
 * haftalıkta sonraki an hesaplanır — geriye dönük birden fazla çalıştırma yok.
 *
 * ÖN UYARI: kanal geçişinden 1 dk ve 10 sn önce TV ekranına bildirim (Kodi'nin "hatırlatma çıkar, tepki yoksa
 * kanala geç" modeli). Uyarı zamanlayıcıları kalıcı değil, her planlamada yeniden kurulur; kaçan uyarı telafi
 * edilmez (geç gelen "1 dk sonra" yanlış bilgi olur). Mesaj görevinde ön uyarı yok — kendisi zaten bir uyarı.
 *
 * Saatler yerel saattir: TV_AJAN_TZ (varsayılan Europe/Istanbul; bkz. saat.mjs). Yaz saati geçişinde haftalık
 * görev duvar saatini korur (her gün 20:00 → geçişten sonra da 20:00).
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import crypto from 'node:crypto';
import { parcalar, yerelAn, gunEkle, tarihGecerli, saatBilgisi } from './saat.mjs';

export const TOLERANS_MS = { 'geri-don': 2 * 60 * 1000, tek: 5 * 60 * 1000, haftalik: 5 * 60 * 1000 };
export const EN_FAZLA_GOREV = 50;
const GECMIS_EN_FAZLA = 30;
const YOKLAMA_MS = 30 * 1000;
const EN_UZUN_BEKLEME = 2 ** 31 - 1;   // Node: daha uzun setTimeout HEMEN ateşlenir
export const UYARI_SN = [60, 10];

export class ZamanlayiciHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

const SAAT = /^([01]\d|2[0-3]):([0-5]\d)$/;
const TARIH = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Yerel duvar saatindeki tarih + saat → ms. Takvimde olmayan tarih (31 Şubat) reddedilir. */
export function tarihSaatAn(tarih, saat) {
  const t = TARIH.exec(String(tarih || ''));
  const s = SAAT.exec(String(saat || ''));
  if (!t || !s) throw new ZamanlayiciHata(400, 'tarih (YYYY-AA-GG) ve saat (SS:DD) gerekli');
  if (!tarihGecerli(+t[1], +t[2], +t[3])) throw new ZamanlayiciHata(400, `takvimde olmayan tarih: ${tarih}`);
  return yerelAn(+t[1], +t[2], +t[3], +s[1], +s[2]);
}

/** Haftalık görevin `sonra`dan sonraki ilk anı. gunler: 1 = Pazartesi … 7 = Pazar (yerel takvim). */
export function sonrakiHaftalik(saat, gunler, sonra) {
  const s = SAAT.exec(String(saat || ''));
  if (!s) return null;
  const bugun = parcalar(sonra);
  for (let i = 0; i <= 7; i++) {
    const g = gunEkle(bugun, i);
    const an = yerelAn(g.y, g.m, g.d, +s[1], +s[2]);
    const gun = ((new Date(Date.UTC(g.y, g.m - 1, g.d)).getUTCDay() + 6) % 7) + 1;
    if (an > sonra && gunler.includes(gun)) return an;
  }
  return null;
}

export class Zamanlayici {
  /**
   * @param {object} o
   * @param {string|null} o.dosya   kalıcı dosya (yoksa yalnız bellekte — testler)
   * @param {(g) => Promise<{sonuc:string, neden?:string}>} o.calistir  görevi yürüten (TV'ye giden) işlev
   */
  constructor({ dosya = null, calistir, uyar = null, log = () => {}, simdi = () => Date.now() }) {
    this.dosya = dosya;
    this.calistirFn = calistir;
    this.uyarFn = uyar;            // (g, saniye) → TV'ye "N sn sonra … geçilecek"
    this.uyariSaatleri = new Map(); // id → [setTimeout]
    this.log = log;
    this.simdi = simdi;
    this.gorevler = new Map();     // id → görev
    this.gecmis = [];
    this.saatler = new Map();      // id → setTimeout
    this.calisanlar = new Set();
    this.yoklama = null;
    this._yazim = Promise.resolve();
  }

  // ── kalıcılık ────────────────────────────────────────────────────────

  async yukle() {
    if (this.dosya) {
      let metin = null;
      try {
        metin = await readFile(this.dosya, 'utf8');
      } catch (e) {
        if (e.code !== 'ENOENT') this.log(`[zamanlayıcı] dosya okunamadı: ${e.message}`);
      }
      if (metin != null) {
        try {
          const j = JSON.parse(metin);
          for (const g of j.gorevler || []) this.gorevler.set(g.id, g);
          this.gecmis = Array.isArray(j.gecmis) ? j.gecmis.slice(-GECMIS_EN_FAZLA) : [];
        } catch (e) {
          // Bozuk dosya (güç kesintisinde yarım yazım vb.): üzerine yazılmadan önce kenara alınır.
          const yedek = `${this.dosya}.bozuk-${Date.now()}`;
          await rename(this.dosya, yedek).catch(() => {});
          this.log(`[zamanlayıcı] dosya bozuk (${e.message}) — ${yedek} olarak saklandı, görevsiz başlanıyor`);
        }
      }
    }
    for (const g of this.gorevler.values()) this._zamanla(g);   // vadesi geçenler hemen değerlendirilir
  }

  /** Sıradaki yazım: o anki durumun anlık görüntüsü, önceki yazım bitince. Hata çağırana döner. */
  _yaz() {
    if (!this.dosya) return Promise.resolve();
    const metin = JSON.stringify({ surum: 1, gorevler: [...this.gorevler.values()], gecmis: this.gecmis });
    const is = this._yazim.catch(() => {}).then(async () => {
      await mkdir(dirname(this.dosya), { recursive: true });
      const tmp = `${this.dosya}.${process.pid}.tmp`;
      await writeFile(tmp, metin);
      await rename(tmp, this.dosya);
    });
    this._yazim = is;
    return is;
  }

  /** Kullanıcı isteği yolunda: yazılamazsa 500. */
  async _kaydet() {
    try { await this._yaz(); } catch (e) {
      this.log(`[zamanlayıcı] diske yazılamadı: ${e.message}`);
      throw new ZamanlayiciHata(500, `görev diske kaydedilemedi (${e.code || e.message})`);
    }
  }

  /** Arka plan yolunda (görev bitti, sonraki an): hata yalnız günlüğe. */
  _yazSessiz() {
    return this._yaz().catch((e) => this.log(`[zamanlayıcı] diske yazılamadı: ${e.message}`));
  }

  baslat() {
    if (this.yoklama) return;
    this.yoklama = setInterval(() => this._yokla(), YOKLAMA_MS);
    this.yoklama.unref?.();
  }

  durdur() {
    clearInterval(this.yoklama);
    this.yoklama = null;
    for (const t of this.saatler.values()) clearTimeout(t);
    this.saatler.clear();
    for (const id of [...this.uyariSaatleri.keys()]) this._uyarilariSil(id);
  }

  // ── dışarıya açık işlemler ───────────────────────────────────────────

  liste() {
    const gorevler = [...this.gorevler.values()].sort((a, b) => (a.etkin === b.etkin ? a.an - b.an : a.etkin ? -1 : 1));
    const simdi = this.simdi();
    return { simdi, ...saatBilgisi(simdi), gorevler, gecmis: this.gecmis.slice(-15).reverse() };
  }

  /** "X dk sonra şu kanala dön" — aynı TV'nin önceki sayacının yerine geçer. */
  async geriDon({ tv, dk, kanal }) {
    const d = Number(dk);
    if (!Number.isInteger(d) || d < 1 || d > 120) throw new ZamanlayiciHata(400, 'süre 1-120 dk olmalı');
    if (!kanal || (kanal.no == null && !kanal.ad)) throw new ZamanlayiciHata(400, 'kanal gerekli');
    for (const g of [...this.gorevler.values()]) if (g.tur === 'geri-don' && g.tv === tv) this._kaldir(g.id);
    const simdi = this.simdi();
    const g = this._yeni({ tur: 'geri-don', tv, kanal: { no: kanal.no ?? null, ad: kanal.ad || null }, dk: d, an: simdi + d * 60000, tvKapaliysa: 'atla' });
    await this._ekleVeYaz(g);
    this.log(`[zamanlayıcı] ${tv}: ${d} dk sonra ${g.kanal.ad || g.kanal.no}'e dönülecek`);
    return g;
  }

  /**
   * Program görevi: bir kez (tarih + saat ya da X dk sonra) ya da haftalık (günler + saat).
   * Görev ya bir KANALA geçer ya da TV ekranında bir MESAJ gösterir (`mesaj: { metin, sureSn }`, ör. her akşam
   * aynı saatte bir hatırlatma). Mesaj görevi TV kapalıysa her zaman atlanır (TV'yi açmaz) ve ön uyarı göstermez.
   * `ortada: true` → ekranın ortasında çok satırlı uyarı penceresi (en çok 5 satır, 300 karakter; köşe bildirimi
   * satır sonunu yutuyor); `sonraKapat: true` → gösterdikten sonra TV kapatılır (ör. "ekran süresi doldu").
   */
  async ekle({ tv, kanal, mesaj = null, zaman, tvKapaliysa = 'ac', etiket = null }) {
    let mesajKaydi = null;
    if (mesaj != null) {
      const ortada = mesaj.ortada === true;
      // Satır içi girinti korunur (imza satırı gibi); yalnız baştaki boş satırlar ve sondaki boşluk atılır.
      const metin = typeof mesaj.metin === 'string' ? mesaj.metin.replace(/^(\s*\n)+/, '').trimEnd() : '';
      const sureSn = Number(mesaj.sureSn ?? 15);
      const sinir = ortada ? 300 : 160;
      if (!metin.trim() || metin.length > sinir) throw new ZamanlayiciHata(400, `mesaj 1-${sinir} karakter olmalı`);
      if (ortada && metin.split('\n').length > 5) throw new ZamanlayiciHata(400, 'mesaj en çok 5 satır');
      if (!Number.isInteger(sureSn) || sureSn < 5 || sureSn > 120) throw new ZamanlayiciHata(400, 'mesaj süresi 5-120 sn olmalı');
      mesajKaydi = { metin, sureSn, ...(ortada ? { ortada: true } : {}), ...(mesaj.sonraKapat === true ? { sonraKapat: true } : {}) };
      tvKapaliysa = 'atla';
    } else if (!kanal || typeof kanal !== 'string' || kanal.length > 60) throw new ZamanlayiciHata(400, 'kanal adı gerekli');
    if (etiket != null && (typeof etiket !== 'string' || etiket.length > 80)) throw new ZamanlayiciHata(400, 'etiket en çok 80 karakter');
    if (!['ac', 'atla'].includes(tvKapaliysa)) throw new ZamanlayiciHata(400, 'TV kapalıysa: ac ya da atla');
    if ([...this.gorevler.values()].filter((g) => g.tur !== 'geri-don').length >= EN_FAZLA_GOREV) {
      throw new ZamanlayiciHata(409, `en fazla ${EN_FAZLA_GOREV} program görevi`);
    }
    const simdi = this.simdi();
    const hedef = mesajKaydi ? { kanal: null, mesaj: mesajKaydi } : { kanal: { ad: kanal } };
    let g;
    if (zaman?.tur === 'sonra') {
      // "X dk sonra şu kanala git" (kanala basılı tutunca): dakikası dakikasına, saate yuvarlanmadan.
      // Bir kez çalışan görevdir (tür "tek" olarak saklanır).
      const dk = Number(zaman.dk);
      if (!Number.isInteger(dk) || dk < 1 || dk > 720) throw new ZamanlayiciHata(400, 'süre 1-720 dk olmalı');
      g = this._yeni({ tur: 'tek', tv, ...hedef, an: simdi + dk * 60000, tvKapaliysa, ...(etiket ? { etiket } : {}) });
    } else if (zaman?.tur === 'tek') {
      const an = tarihSaatAn(zaman.tarih, zaman.saat);
      if (an <= simdi) throw new ZamanlayiciHata(400, 'bu an geçmişte');
      g = this._yeni({ tur: 'tek', tv, ...hedef, an, tvKapaliysa, ...(etiket ? { etiket } : {}) });
    } else if (zaman?.tur === 'haftalik') {
      const gunler = [...new Set((zaman.gunler || []).map(Number))].filter((x) => Number.isInteger(x) && x >= 1 && x <= 7).sort();
      if (!gunler.length) throw new ZamanlayiciHata(400, 'en az bir gün seçilmeli');
      if (!SAAT.test(String(zaman.saat || ''))) throw new ZamanlayiciHata(400, 'saat SS:DD olmalı');
      g = this._yeni({ tur: 'haftalik', tv, ...hedef, saat: zaman.saat, gunler, an: sonrakiHaftalik(zaman.saat, gunler, simdi), tvKapaliysa, ...(etiket ? { etiket } : {}) });
    } else {
      throw new ZamanlayiciHata(400, 'zaman türü tek, sonra ya da haftalik olmalı');
    }
    await this._ekleVeYaz(g);
    return g;
  }

  async uzat(id, dk = 1) {
    const g = this._bul(id);
    const d = Number(dk);
    if (!Number.isInteger(d) || d < 1 || d > 30) throw new ZamanlayiciHata(400, 'uzatma 1-30 dk olmalı');
    if (g.tur !== 'geri-don') throw new ZamanlayiciHata(400, 'yalnız geri dön sayacı uzatılır');
    g.an = Math.max(g.an, this.simdi()) + d * 60000;
    this._zamanla(g);
    await this._kaydet();
    return g;
  }

  async sil(id) {
    const g = this._bul(id);
    this._kaldir(id);
    this._gecmiseYaz(g, { sonuc: 'iptal' });
    await this._kaydet();
    return g;
  }

  async etkin(id, acik) {
    const g = this._bul(id);
    if (g.tur !== 'haftalik') throw new ZamanlayiciHata(400, 'yalnız tekrarlı görev kapatılıp açılır');
    g.etkin = !!acik;
    if (g.etkin) g.an = sonrakiHaftalik(g.saat, g.gunler, this.simdi());
    this._zamanla(g);
    await this._kaydet();
    return g;
  }

  /**
   * Beklemeden şimdi çalıştır (ör. "Şimdi dön"). Tek seferlik görev böylece tüketilir; haftalık görevin
   * sıradaki PLANLI çalışması yerinde kalır (elle çalıştırma onu atlatmaz).
   */
  async hemen(id) {
    const g = this._bul(id);
    return this._calistir(g, { elle: true });
  }

  // ── iç işler ─────────────────────────────────────────────────────────

  _yeni(alanlar) {
    return { id: crypto.randomBytes(6).toString('hex'), etkin: true, olusturuldu: this.simdi(), ...alanlar };
  }

  async _ekleVeYaz(g) {
    this.gorevler.set(g.id, g);
    try {
      await this._kaydet();
    } catch (e) {
      this.gorevler.delete(g.id);   // kaydedilemeyen görev kurulmaz: yeniden başlatmada sessizce yok olmasın
      throw e;
    }
    this._zamanla(g);
  }

  _bul(id) {
    const g = this.gorevler.get(String(id || ''));
    if (!g) throw new ZamanlayiciHata(404, 'görev bulunamadı');
    return g;
  }

  _kaldir(id) {
    clearTimeout(this.saatler.get(id));
    this.saatler.delete(id);
    this._uyarilariSil(id);
    this.gorevler.delete(id);
  }

  _uyarilariSil(id) {
    for (const t of this.uyariSaatleri.get(id) || []) clearTimeout(t);
    this.uyariSaatleri.delete(id);
  }

  _zamanla(g) {
    clearTimeout(this.saatler.get(g.id));
    this.saatler.delete(g.id);
    this._uyarilariSil(g.id);
    if (!g.etkin || g.an == null) return;
    const kalan = g.an - this.simdi();
    if (kalan <= 0) { void this._vade(g); return; }
    const t = setTimeout(() => this._vade(g), Math.min(kalan, EN_UZUN_BEKLEME));
    t.unref?.();
    this.saatler.set(g.id, t);
    if (!this.uyarFn || g.mesaj) return;   // mesaj görevinin kendisi zaten ekranda bir uyarı
    const an = g.an;
    const uyarilar = [];
    for (const sn of UYARI_SN) {
      const once = kalan - sn * 1000;
      if (once <= 0 || once > EN_UZUN_BEKLEME) continue;
      const u = setTimeout(() => {
        // Bu arada silindi, uzatıldı ya da kapatıldıysa eski uyarı gösterilmez.
        if (this.gorevler.get(g.id) !== g || !g.etkin || g.an !== an) return;
        Promise.resolve().then(() => this.uyarFn(g, sn)).catch((e) => this.log(`[zamanlayıcı] uyarı gösterilemedi: ${e.message}`));
      }, once);
      u.unref?.();
      uyarilar.push(u);
    }
    this.uyariSaatleri.set(g.id, uyarilar);
  }

  _yokla() {
    const simdi = this.simdi();
    for (const g of this.gorevler.values()) if (g.etkin && g.an != null && simdi >= g.an) void this._vade(g);
  }

  async _vade(g) {
    if (this.gorevler.get(g.id) !== g || !g.etkin || this.calisanlar.has(g.id)) return;
    const simdi = this.simdi();
    if (simdi < g.an) { this._zamanla(g); return; }   // erken uyanan setTimeout (çok uzun bekleme bölündü)
    const gec = simdi - g.an;
    if (gec > TOLERANS_MS[g.tur]) {
      this._gecmiseYaz(g, { sonuc: 'kacirildi', neden: `${Math.round(gec / 60000)} dk geç kalındı (ajan o sırada çalışmıyordu)` });
      this.log(`[zamanlayıcı] ${g.tv}: ${this._tarif(g)} KAÇIRILDI (${Math.round(gec / 60000)} dk geç)`);
      await this._sonraki(g);
      return;
    }
    await this._calistir(g);
  }

  async _calistir(g, { elle = false } = {}) {
    if (this.calisanlar.has(g.id)) return { sonuc: 'zaten-calisiyor' };
    this.calisanlar.add(g.id);
    clearTimeout(this.saatler.get(g.id));
    this._uyarilariSil(g.id);
    let sonuc;
    try {
      sonuc = await this.calistirFn(g);
    } catch (e) {
      sonuc = { sonuc: 'hata', neden: String(e.message || e).split('\n')[0].slice(0, 200) };
    } finally {
      this.calisanlar.delete(g.id);
    }
    this._gecmiseYaz(g, sonuc);
    this.log(`[zamanlayıcı] ${g.tv}: ${this._tarif(g)} → ${sonuc.sonuc}${sonuc.neden ? ` (${sonuc.neden})` : ''}`);
    if (this.gorevler.get(g.id) === g) await this._sonraki(g, { elle });   // bu arada silinmediyse
    else await this._yazSessiz();
    return sonuc;
  }

  /** Tek seferlik görev biter; haftalık bir sonraki ana geçer (geriye dönük çalıştırma yok). */
  async _sonraki(g, { elle = false } = {}) {
    if (g.tur === 'haftalik') {
      if (!elle || g.an == null || g.an <= this.simdi()) g.an = sonrakiHaftalik(g.saat, g.gunler, Math.max(this.simdi(), g.an ?? 0));
      this._zamanla(g);
    } else {
      this._kaldir(g.id);
    }
    await this._yazSessiz();
  }

  _gecmiseYaz(g, sonuc) {
    this.gecmis.push({ id: g.id, tur: g.tur, tv: g.tv, kanal: g.kanal, ...(g.mesaj ? { mesaj: g.mesaj } : {}), etiket: g.etiket || null, an: g.an, bitti: this.simdi(), sonuc: sonuc.sonuc, neden: sonuc.neden || null });
    if (this.gecmis.length > GECMIS_EN_FAZLA) this.gecmis.splice(0, this.gecmis.length - GECMIS_EN_FAZLA);
  }

  _tarif(g) {
    const k = g.mesaj ? `mesaj "${g.mesaj.metin.slice(0, 30)}"` : (g.kanal.ad || g.kanal.no);
    return g.tur === 'geri-don' ? `geri dön → ${k}` : `${g.tur === 'tek' ? 'bir kez' : 'haftalık'} → ${k}`;
  }
}
