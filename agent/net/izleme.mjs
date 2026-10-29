/**
 * İzleme kaydı — hangi TV ne zaman açık kaldı, o sırada ne izlendi (kumanda → "İzleme geçmişi").
 *
 * Ajan her `ornekMs`'de (30 sn) her TV'nin durumunu alır (`tv.durum()`: güç, kaynak, kanal, şu anki program).
 * Durum değişmedikçe açık kesit uzar; değişince (kanal, program, kaynak, kapanma) kesit kapanır, yenisi açılır.
 *  - Kapanma için iki ardışık "kapalı" örnek gerekir: tek bir ağ aksaklığı izlemeyi bölmesin. Kesitin bitişi
 *    o zaman bile SON GÖRÜLDÜĞÜ an olur (kapanmayı fark ettiğimiz an değil).
 *  - Ajan yeniden başlarsa açık kesit dosyadan okunur; aradaki boşluk izleme sayılmaz (son görülmede kapatılır).
 *  - Apple TV'de oynayan (AirPlay eşleştirmesiyle) uygulama + içerik olarak yazılır. Apple TV'de OYNAYAN yoksa kesit
 *    `pasif` taşır: 'duraklatildi' (paused) ya da 'bekleme' (idle/stopped: ana ekran, menü — bazı uygulamalar
 *    duraklatınca da idle bildiriyor, pyatv #2888). TV açık ama izlenmiyor: özet bunu izleme süresine katmaz.
 *    (LG'nin kendi uygulamalarında oynatma durumu okunamıyor; orada duraklatma izleme sayılır.)
 *
 * Kayıt: <dizin>/YYYY-MM-DD.jsonl (yerel gün — TV_AJAN_TZ, bkz. saat.mjs — kesitin BAŞLADIĞI güne), satır =
 * kapanmış kesit: { tv, bas, bit, kaynak, kanal: {no, ad} | null, program, uygulama, ekranKapali?, pasif? }
 * Açık kesitler <dizin>/acik.json. `saklaGun` günden eski dosyalar silinir. Bu veri kişiseldir: yalnız ajanın
 * durum dizininde durur, hiçbir yere gönderilmez; okunması belirteçli /izleme ucundan.
 */
import { mkdir, readFile, writeFile, appendFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { gunAnahtari, gunBasi, gunCoz, gunEkle, gunMetni, parcalar, saatSonu } from './saat.mjs';

const GUN = 24 * 3600e3;
/** Anın yerel günü "YYYY-MM-DD" (gün dosyalarının adı). */
export const trGun = (ms) => gunAnahtari(ms);

/** Durumdan izleme anahtarı: aynı anahtar = aynı kesit. Kapalıysa null. */
export function kesitAnahtari(d) {
  if (!d || !d.acik) return null;
  const kanal = d.kaynak === 'canli' && d.kanal ? { no: d.kanal.no ?? null, ad: d.kanal.ad ?? null } : null;
  let program = kanal && d.kanal.program ? d.kanal.program.ad || null : null;
  let uygulama = d.kaynak === 'canli' ? null : (d.uygulamaAdi || d.uygulama || null);
  // Apple TV'de oynayan (AirPlay): uygulama adı (YouTube…) ve içerik — "Dizi S2B5 — Bölüm adı" ya da "Video (Kanal)".
  const o = d.kaynak !== 'canli' ? d.oynayan : null;
  if (o) {
    uygulama = o.uygulama || uygulama;
    const dizi = o.dizi ? `${o.dizi}${o.sezon ? ` S${o.sezon}` : ''}${o.bolum ? `B${o.bolum}` : ''}` : null;
    const ad = [dizi, o.baslik].filter(Boolean).join(' — ');
    program = ad ? `${ad}${o.sanatci && !o.dizi ? ` (${o.sanatci})` : ''}` : null;
  }
  // Apple TV'de oynayan yok: TV açık ama izlenmiyor ("açık ama pasif"). Durum bilinmiyorsa (Apple TV yanıt
  // vermedi → oynayan yok) izleme sayılır.
  const pasif = !o ? null : o.durum === 'paused' ? 'duraklatildi' : (['playing', 'loading', 'seeking'].includes(o.durum) ? null : 'bekleme');
  return { kaynak: d.kaynak || 'diger', kanal, program, uygulama, ekranKapali: !!d.ekranKapali, pasif };
}
const ayni = (a, b) => !!a && !!b && a.kaynak === b.kaynak && a.program === b.program && a.uygulama === b.uygulama
  && a.ekranKapali === b.ekranKapali && (a.pasif || null) === (b.pasif || null) && (a.kanal?.no ?? null) === (b.kanal?.no ?? null);

export class IzlemeKaydi {
  /**
   * @param {object} o
   * @param {string} o.dizin    kayıt dizini (ajanın durum dizini altında)
   * @param {Array}  o.tvler    `durum()` yöntemi olan TV nesneleri
   * @param {(id) => boolean} o.atla  bu TV şimdi yoklanmasın (ör. kanal listesi düzenlenirken)
   */
  constructor({ dizin, tvler, ornekMs = 30000, saklaGun = 365, simdi = Date.now, log = () => {}, atla = () => false }) {
    Object.assign(this, { dizin, tvler, ornekMs, saklaGun, simdi, log, atla });
    this.acik = new Map();      // tv id → { ...anahtar, bas, son }
    this.kapaliSayac = new Map();
    this.zamanlayici = null;
    this.sonTemizlik = null;
    this.yaziliyor = Promise.resolve();
  }

  async yukle() {
    await mkdir(this.dizin, { recursive: true });
    try {
      const j = JSON.parse(await readFile(join(this.dizin, 'acik.json'), 'utf8'));
      // Ajan kapalıyken geçen süre izleme sayılmaz: yüklenen açık kesitler son görüldükleri anda kapatılır.
      for (const k of Object.values(j || {})) if (k && k.tv && k.son > k.bas) await this._yaz(k.tv, k, k.son);
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[izleme] açık kesitler okunamadı (${e.message}) — sıfırdan`);
    }
    await this._acikKaydet();
  }

  baslat() {
    if (this.zamanlayici) return;
    const dongu = async () => {
      try { await this.ornekle(); } catch (e) { this.log(`[izleme] örnek alınamadı: ${e.message}`); }
      this.zamanlayici = setTimeout(dongu, this.ornekMs);
      this.zamanlayici.unref?.();
    };
    dongu();
  }

  durdur() { clearTimeout(this.zamanlayici); this.zamanlayici = null; }

  async ornekle() {
    const t = this.simdi();
    for (const tv of this.tvler) {
      if (this.atla(tv.id)) continue;
      let d;
      try { d = await tv.durum(); } catch { d = null; }
      const yeni = kesitAnahtari(d);
      const eski = this.acik.get(tv.id);
      if (!yeni) {
        if (!eski) continue;
        const n = (this.kapaliSayac.get(tv.id) || 0) + 1;
        this.kapaliSayac.set(tv.id, n);
        if (n >= 2) { await this._yaz(tv.id, eski, eski.son); this.acik.delete(tv.id); this.kapaliSayac.delete(tv.id); }
        continue;
      }
      this.kapaliSayac.delete(tv.id);
      if (eski && ayni(eski, yeni)) { eski.son = t; continue; }
      if (eski) await this._yaz(tv.id, eski, t);
      this.acik.set(tv.id, { tv: tv.id, ...yeni, bas: t, son: t });
    }
    await this._acikKaydet();
    if (this.sonTemizlik !== trGun(t)) { this.sonTemizlik = trGun(t); await this.temizle(t); }
  }

  /** Kesiti kapatıp günün dosyasına ekler (yazımlar sırayla). */
  _yaz(tvId, k, bit) {
    const satir = { tv: tvId, bas: k.bas, bit: Math.max(bit, k.bas), kaynak: k.kaynak, kanal: k.kanal || null, program: k.program || null, uygulama: k.uygulama || null };
    if (k.ekranKapali) satir.ekranKapali = true;
    if (k.pasif) satir.pasif = k.pasif;
    this.yaziliyor = this.yaziliyor.then(() => appendFile(join(this.dizin, `${trGun(k.bas)}.jsonl`), JSON.stringify(satir) + '\n'))
      .catch((e) => this.log(`[izleme] yazılamadı: ${e.message}`));
    return this.yaziliyor;
  }

  async _acikKaydet() {
    const tmp = join(this.dizin, 'acik.json.tmp');
    try {
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.acik)));
      await rename(tmp, join(this.dizin, 'acik.json'));
    } catch (e) { this.log(`[izleme] açık kesitler yazılamadı: ${e.message}`); }
  }

  async temizle(t = this.simdi()) {
    const sinir = trGun(t - this.saklaGun * GUN);
    let silinen = 0;
    for (const f of await readdir(this.dizin).catch(() => [])) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1] < sinir) { await unlink(join(this.dizin, f)).catch(() => {}); silinen++; }
    }
    if (silinen) this.log(`[izleme] ${silinen} eski gün silindi (saklama ${this.saklaGun} gün)`);
  }

  /** [bas, bit) aralığındaki kesitler (açık olanlar dahil, `acik: true`), isteğe bağlı TV süzgeci. */
  async kesitler({ bas, bit, tv = null }) {
    const sonuc = [];
    // Bir kesit başladığı günün dosyasında; önceki günden taşanlar için bir gün geriden başla. Günler takvimden
    // sayılır (24 saat eklemek yaz saati geçişinde aynı günü iki kez okuturdu).
    const son = trGun(bit - 1);
    for (let g = gunEkle(gunCoz(trGun(bas)), -1); gunMetni(g) <= son; g = gunEkle(g, 1)) {
      let metin = '';
      try { metin = await readFile(join(this.dizin, `${gunMetni(g)}.jsonl`), 'utf8'); } catch { continue; }
      for (const s of metin.split('\n')) {
        if (!s) continue;
        let k;
        try { k = JSON.parse(s); } catch { continue; }
        if ((!tv || k.tv === tv) && k.bit > bas && k.bas < bit) sonuc.push(k);
      }
    }
    for (const k of this.acik.values()) {
      if ((!tv || k.tv === tv) && k.son > bas && k.bas < bit) {
        sonuc.push({ tv: k.tv, bas: k.bas, bit: k.son, kaynak: k.kaynak, kanal: k.kanal, program: k.program, uygulama: k.uygulama, ...(k.ekranKapali ? { ekranKapali: true } : {}), ...(k.pasif ? { pasif: k.pasif } : {}), acik: true });
      }
    }
    return sonuc.sort((a, b) => a.bas - b.bas);
  }
}

/**
 * Kesitlerden özet (ms): `toplam` = TV açık, `izlenen` = bunun duraklatılmamış kısmı, `pasif` = duraklatılmış.
 * Kaynak/kanal/program/uygulama ve saat dağılımı (yerel saat) yalnız İZLENEN süreyi sayar; `tv` açık kalma süresidir.
 */
export function ozetle(kesitler, { bas, bit }) {
  const ozet = { toplam: 0, izlenen: 0, pasif: 0, kaynak: {}, kanal: {}, program: {}, uygulama: {}, saat: new Array(24).fill(0), tv: {} };
  const ekle = (m, k, ms) => { if (k) m[k] = (m[k] || 0) + ms; };
  for (const k of kesitler) {
    const b = Math.max(k.bas, bas);
    const e = Math.min(k.bit, bit);
    if (e <= b) continue;
    const ms = e - b;
    ozet.toplam += ms;
    ekle(ozet.tv, k.tv, ms);
    if (k.pasif) { ozet.pasif += ms; continue; }
    ozet.izlenen += ms;
    ekle(ozet.kaynak, k.kaynak, ms);
    if (k.kanal) ekle(ozet.kanal, k.kanal.ad || String(k.kanal.no), ms);
    ekle(ozet.program, k.program && `${k.kanal?.ad || ''} · ${k.program}`, ms);
    ekle(ozet.uygulama, k.uygulama, ms);
    // Saat dağılımı (yerel saat): kesiti saat sınırlarında böl.
    for (let t = b; t < e;) {
      const sonraki = Math.min(e, saatSonu(t));
      ozet.saat[parcalar(t).saat] += sonraki - t;
      t = sonraki;
    }
  }
  return ozet;
}

/**
 * /izleme ucunun aralığı: `gun` (yerel, YYYY-MM-DD) dahil geriye `gunSayisi` gün → { bas, bit } (ms).
 * Gün sınırları yerel gece yarısıdır; yaz saati geçişindeki 23/25 saatlik gün doğru sayılır.
 */
export function gunAraligi(gun, gunSayisi = 1) {
  const g = gunCoz(gun);
  if (!g) return null;
  const sonGun = gunEkle(g, 1);
  const ilkGun = gunEkle(g, -(gunSayisi - 1));
  return { bas: gunBasi(ilkGun), bit: gunBasi(sonGun) };
}
