/**
 * TV kanal listesi düzenleme (kumanda → "TV kanal listesi düzenleme").
 *
 * SSAP'ta kanal listesini yazan uç yok; sıra TV'nin KENDİ Kanal Yöneticisi kumanda soketinden sürülerek
 * değiştirilir (lg-editor.mjs, kapalı döngü: her taşımadan sonra liste okunup doğrulanır). Taşıma başına
 * ~10-15 sn sürdüğü için iş arka planda koşar; kumanda ilerlemeyi yoklar, isterse durdurur.
 * İş sürerken — ve iş başlamadan önceki uyanma/liste okuma penceresinde (`rezerveEt`) — o TV'ye başka komut
 * gönderilmez (ajan 409 döner): kumanda ekrandaki menüyü sürüyor.
 *
 * Liste kimliği `key` = transponder numarası + servis numarası (lg-editor → channelKey): taşıyınca ve
 * TV'nin kendi kayıt yenilemesinde değişmez. Hazır öneri (oneriler/*.json) ise TV'den bağımsız yayın
 * kimlikleriyle (SVCID/TSID/ONID + frekans + ad) tutulur ve her TV'nin listesine order.cjs ile eşlenir.
 *
 * Yalnız UYDU (DVB-S) listesi desteklenir (tuş tarifi orada çıkarıldı): uydu listesi boş olan TV'de iş
 * başlamadan 422 döner — her kanalı "eksik" sayıp anında "bitti" demek yerine.
 *
 * İş durumu her adımda diske yazılır (`kanal-is-<tv>.json`): ajan iş sürerken yeniden başlarsa (güncelleme,
 * çökme) açılışta iş "yarim" olarak görünür; TV hâlâ kanal düzenleyicisindeyse ona bir kez EXIT gönderilir.
 * Hatalı adımda ekran görüntüsü durum dizininin `teshis/` klasörüne yazılır (TV başına son 10).
 */
import { readFile, writeFile, mkdir, rename, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { readTvList, applyHead } from './lg-editor.mjs';

const Order = createRequire(import.meta.url)('./order.cjs');

export const ANAHTAR = /^\d{1,6}_\d{1,6}$/;
const MESAJ_SAKLA = 30;
const TESHIS_SAKLA = 10;

const hata = (kod, mesaj) => Object.assign(new Error(mesaj), { kod });

/** TV listesinin satırı → öneri/eşleştirme motorunun beklediği biçim. */
export const satir = (c) => ({
  name: c.name, number: c.number, isRadio: false,
  SVCID: c.raw.SVCID ?? null, TSID: c.raw.TSID ?? null, ONID: c.raw.ONID ?? null,
  frequency: c.raw.Frequency ?? null, serviceType: c.raw.serviceType ?? null,
});
const sade = (c) => ({ key: c.key, no: c.number, ad: c.name });

/**
 * Hazır öneriyi bu TV'nin listesine eşler: önerideki kanallar önerinin sırasıyla başa, kalanlar
 * bugünkü sırasıyla sona. Bulunamayan öneri kanalları ayrıca bildirilir.
 */
export function oneriyiEsle(tarif, liste) {
  const eski = (tarif.kanallar || []).filter((c) => !c.isRadio && c.serviceType !== 2);
  const es = Order.match(eski, liste.map(satir));
  const bas = es.matched.slice().sort((a, b) => a.oldNumber - b.oldNumber).map((m) => liste[m.idx]);
  const bastakiler = new Set(bas.map((c) => c.key));
  return {
    kanallar: [...bas, ...liste.filter((c) => !bastakiler.has(c.key))].map(sade),
    eslesen: bas.length,
    bulunamayan: es.onlyOld.map((o) => o.name),
  };
}

export class KanalSirasi {
  /**
   * @param {object} o
   * @param {string} o.dizin       kayıtlı listeler, iş durumu ve yedekler (ajanın durum dizini)
   * @param {string} o.oneriDizini hazır öneriler (depodaki agent/oneriler)
   */
  constructor({ dizin, oneriDizini, log = () => {}, okuFn = readTvList, uygulaFn = applyHead }) {
    Object.assign(this, { dizin, oneriDizini, log, okuFn, uygulaFn });
    this.isler = new Map();       // tv id → iş
    this.rezerve = new Set();     // iş başlamak üzere (uyanma, liste okuma, yedek)
    this.sozler = new Map();      // tv id → arka plandaki işin sözü (kapanışta beklemek için)
  }

  calisiyor(tvId) {
    return this.isler.get(tvId)?.durum === 'calisiyor';
  }

  /** İş sürüyor ya da başlamak üzere: bu TV'ye başka komut gönderilmemeli. */
  mesgul(tvId) {
    return this.calisiyor(tvId) || this.rezerve.has(tvId);
  }

  rezerveEt(tvId) { this.rezerve.add(tvId); }
  rezervKaldir(tvId) { this.rezerve.delete(tvId); }

  /** Uydu listesi; boşsa 422 (bu TV'nin listesi desteklenmiyor). */
  async _uyduListesi(ssap) {
    const l = await this.okuFn(ssap);
    if (!l.length) throw hata(422, 'bu TV\'de uydu (DVB-S) kanal listesi yok — kanal sıralama yalnız uydu listesinde destekleniyor');
    return l;
  }

  async liste(t) {
    return (await this._uyduListesi(await t.baglan())).map(sade);
  }

  async oneri(t, ad = 'vibecoder') {
    if (!/^[a-z0-9-]{1,40}$/.test(ad)) throw hata(400, 'geçersiz öneri adı');
    let tarif;
    try { tarif = JSON.parse(await readFile(join(this.oneriDizini, `${ad}.json`), 'utf8')); } catch {
      throw hata(404, 'öneri bulunamadı');
    }
    const liste = await this._uyduListesi(await t.baglan());
    return { ad: tarif.ad || ad, aciklama: tarif.aciklama || '', ...oneriyiEsle(tarif, liste) };
  }

  _dosya(tvId, tur) { return join(this.dizin, `kanal-${tur}-${tvId}.json`); }

  async kaydet(tvId, sira) {
    await mkdir(this.dizin, { recursive: true });
    const kayit = { zaman: Date.now(), sira };
    const yol = this._dosya(tvId, 'sirasi');
    await writeFile(`${yol}.tmp`, JSON.stringify(kayit));
    await rename(`${yol}.tmp`, yol);
    return kayit;
  }

  async kayitli(tvId) {
    try { return JSON.parse(await readFile(this._dosya(tvId, 'sirasi'), 'utf8')); } catch { return null; }
  }

  durum(tvId) {
    const is = this.isler.get(tvId);
    if (!is) return null;
    const { durdurIstendi, ...gorunur } = is;
    return { ...gorunur, mesajlar: is.mesajlar.slice(-MESAJ_SAKLA) };
  }

  /** İş durumunu diske yazar (en iyi çaba; yazılamazsa yalnız günlük). */
  _isKaydet(tvId) {
    const d = this.durum(tvId);
    if (!d) return Promise.resolve();
    const yol = this._dosya(tvId, 'is');
    const onceki = this._isYazimi || Promise.resolve();
    this._isYazimi = onceki.then(async () => {
      await mkdir(this.dizin, { recursive: true });
      await writeFile(`${yol}.tmp`, JSON.stringify({ tv: tvId, ...d }));
      await rename(`${yol}.tmp`, yol);
    }).catch((e) => this.log(`[kanal-sirasi] ${tvId}: iş durumu yazılamadı (${e.message})`));
    return this._isYazimi;
  }

  /**
   * Açılışta: önceki süreçten "calisiyor" kalmış işler "yarim" olarak işaretlenir ve görünür kalır.
   * @returns {Promise<string[]>} yarım kalan işlerin TV kimlikleri (çağıran TV'ye EXIT gönderir)
   */
  async yukle() {
    const yarim = [];
    let dosyalar = [];
    try { dosyalar = await readdir(this.dizin); } catch { return yarim; }
    for (const f of dosyalar) {
      const m = /^kanal-is-([a-z0-9-]{1,20})\.json$/.exec(f);
      if (!m) continue;
      let is;
      try { is = JSON.parse(await readFile(join(this.dizin, f), 'utf8')); } catch { continue; }
      if (is?.durum !== 'calisiyor') continue;
      const { tv, ...kalan } = is;
      this.isler.set(m[1], {
        ...kalan, durum: 'yarim', bitti: Date.now(), durdurIstendi: false,
        hata: 'ajan iş sürerken yeniden başladı — sıra yarıda kaldı; TV kanal düzenleyicisinde kalmış olabilir',
        mesajlar: Array.isArray(kalan.mesajlar) ? kalan.mesajlar : [],
      });
      await this._isKaydet(m[1]);
      this.log(`[kanal-sirasi] ${m[1]}: önceki çalışmadan yarım kalmış iş bulundu`);
      yarim.push(m[1]);
    }
    return yarim;
  }

  async _teshis(tvId, buf, ad) {
    const dizin = join(this.dizin, 'teshis');
    await mkdir(dizin, { recursive: true });
    await writeFile(join(dizin, `kanal-${tvId}-${ad}`), buf);
    const eski = (await readdir(dizin)).filter((f) => f.startsWith(`kanal-${tvId}-`)).sort().slice(0, -TESHIS_SAKLA);
    for (const f of eski) await unlink(join(dizin, f)).catch(() => {});
  }

  /** Sırayı TV'ye uygulamaya başlar (arka planda). Önce bugünkü sıra yedeklenir. */
  async baslat(t, sira) {
    if (this.calisiyor(t.id)) throw hata(409, 'bu TV için düzenleme zaten sürüyor');
    const ssap = await t.baglan();
    const once = await this._uyduListesi(ssap);
    await mkdir(this.dizin, { recursive: true });
    await writeFile(this._dosya(t.id, `yedek-${Date.now()}`), JSON.stringify(Order.toRecipe(once.map(satir))));
    const is = {
      durum: 'calisiyor', basladi: Date.now(), bitti: null, yapilan: 0, kalan: null,
      hata: null, sonuc: null, mesajlar: [], durdurIstendi: false,
    };
    this.isler.set(t.id, is);
    // İş sürerken durum yoklaması (GET /tvler) işin bağlantısını kapatmasın (Tv.durum → birak).
    t.duzenleniyor = true;
    await this._isKaydet(t.id);
    const yaz = (m) => { is.mesajlar.push({ zaman: Date.now(), m }); if (is.mesajlar.length > MESAJ_SAKLA * 2) is.mesajlar.splice(0, MESAJ_SAKLA); };
    this.log(`[kanal-sirasi] ${t.id}: başladı (${sira.length} kanallık sıra)`);
    const soz = Promise.resolve().then(() => this.uygulaFn(ssap, sira, {
      log: yaz,
      durdur: () => is.durdurIstendi,
      ilerleme: (p) => { is.yapilan = p.yapilan; is.kalan = p.kalan; this._isKaydet(t.id); },
      onShot: (buf, ad) => { this._teshis(t.id, buf, ad).catch(() => {}); },
    })).then((r) => {
      Object.assign(is, { durum: 'bitti', bitti: Date.now(), sonuc: { yapilan: r.yapilan, hatali: r.hatali, sure: r.sure, eksik: r.eksik.length }, kalan: 0, yapilan: r.yapilan });
      this.log(`[kanal-sirasi] ${t.id}: bitti — ${r.yapilan} taşıma, ${r.sure} sn`);
    }).catch((e) => {
      Object.assign(is, { durum: is.durdurIstendi ? 'durduruldu' : 'hata', bitti: Date.now(), hata: String(e.message || e).slice(0, 300) });
      this.log(`[kanal-sirasi] ${t.id}: ${is.durum} — ${is.hata}`);
    }).finally(() => {
      t.duzenleniyor = false;
      // Numaralar değişti: TV'nin kanal listesi önbelleği bayat (/epg, kanalAc ilk denemesi).
      t.liste = null;
      t.listeZamani = 0;
      this.sozler.delete(t.id);
      return this._isKaydet(t.id);
    });
    this.sozler.set(t.id, soz);
    return this.durum(t.id);
  }

  durdur(tvId) {
    const is = this.isler.get(tvId);
    if (!is || is.durum !== 'calisiyor') return false;
    is.durdurIstendi = true;
    return true;
  }

  /** Kapanışta: sürenlerin hepsine dur de, en çok `ms` bitmelerini bekle (taşıma ortasında kesilmesin). */
  async hepsiniDurdur(ms = 20000) {
    for (const id of this.isler.keys()) this.durdur(id);
    const bekleyen = [...this.sozler.values()];
    if (!bekleyen.length) return;
    let z;
    await Promise.race([Promise.allSettled(bekleyen), new Promise((r) => { z = setTimeout(r, ms); })]);
    clearTimeout(z);
  }
}
