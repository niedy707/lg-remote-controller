/**
 * YouTube videosunu başlık + kanaldan bulur (izleme geçmişinde videonun bağlantısı ve engel kuralları için).
 *
 * Apple TV'nin "şu an oynayan" bilgisinde video kimliği YOK: YouTube uygulaması contentIdentifier'ı boş
 * bırakıyor, `hash` rastgele bir UUID (ölçüldü: tvOS 27, YouTube tvOS). Elde başlık, kanal ve süre var.
 * youtube.com arama sayfasının gömülü verisinden (ytInitialData) yalnız BİREBİR eşleşme alınır:
 * başlık aynı VE (kanal aynı ya da süre ±3 sn). Eşleşme yoksa null — çağıran arama bağlantısına düşer;
 * yanlış videoya bağlamaktansa bağlamamak.
 *
 * Önbellek <dizin>/youtube.json: bulunan kalıcı, bulunamayan 1 gün sonra yeniden denenir. Sorgular sırayla
 * ve en az `aralikMs` arayla gider (YouTube'a yük bindirmemek için).
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const BULUNAMADI_MS = 24 * 3600e3;

export const normal = (s) => String(s || '').normalize('NFC').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
export const anahtar = (baslik, kanal) => `${normal(baslik)}\u0000${normal(kanal)}`;

/** "8:56" / "1:02:03" → saniye */
export function sureSn(metin) {
  if (!metin) return null;
  const p = String(metin).split(':').map(Number);
  if (p.some((x) => !Number.isFinite(x))) return null;
  return p.reduce((a, x) => a * 60 + x, 0);
}

/** İzleme kaydındaki program metni "Başlık (Kanal)" → { baslik, kanal } */
export function ayir(program) {
  const m = /^(.*\S) \(([^()]+)\)$/.exec(String(program || ''));
  return m ? { baslik: m[1], kanal: m[2] } : { baslik: String(program || ''), kanal: null };
}

/** Arama sayfası HTML'inden video listesi: [{ id, baslik, kanal, sure }] (sayfadaki sırayla). */
export function videolariAyikla(html) {
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(html);
  if (!m) return [];
  let veri;
  try { veri = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  const gez = (o) => {
    if (Array.isArray(o)) { for (const x of o) gez(x); return; }
    if (!o || typeof o !== 'object') return;
    const v = o.videoRenderer;
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v.videoId || '')) {
      out.push({
        id: v.videoId,
        baslik: (v.title?.runs || []).map((r) => r.text || '').join('') || v.title?.simpleText || '',
        kanal: (v.ownerText?.runs || v.longBylineText?.runs || [])[0]?.text || '',
        sure: sureSn(v.lengthText?.simpleText),
      });
    }
    for (const x of Object.values(o)) gez(x);
  };
  gez(veri);
  return out;
}

/** Listeden birebir eşleşen ilk videonun kimliği, yoksa null. */
export function eslesen(videolar, { baslik, kanal, sure = null }) {
  const b = normal(baslik);
  const k = normal(kanal);
  for (const v of videolar) {
    if (normal(v.baslik) !== b) continue;
    const kanalTutar = !!k && normal(v.kanal) === k;
    const sureTutar = sure != null && v.sure != null && Math.abs(v.sure - sure) <= 3;
    if (kanalTutar || sureTutar) return v.id;
  }
  return null;
}

export class YoutubeBulucu {
  constructor({ dizin, getir = fetch, simdi = Date.now, aralikMs = 5000, log = () => {} }) {
    Object.assign(this, { dosya: join(dizin, 'youtube.json'), getir, simdi, aralikMs, log });
    this.kayit = {};           // anahtar → { id | null, zaman }
    this.kuyruk = Promise.resolve();
    this.son = 0;
    this.bekleyen = new Map(); // anahtar → Promise (aynı video iki kez sorulmasın)
  }

  async yukle() {
    try { this.kayit = JSON.parse(await readFile(this.dosya, 'utf8')) || {}; } catch { this.kayit = {}; }
  }

  /** Önbellekte: kimlik (string), "bulunamadı" (null) ya da hiç sorulmamış/süresi geçmiş (undefined). */
  onbellekte(baslik, kanal) {
    const k = this.kayit[anahtar(baslik, kanal)];
    if (!k) return undefined;
    if (k.id) return k.id;
    return this.simdi() - k.zaman < BULUNAMADI_MS ? null : undefined;
  }

  /** Önbellekte yoksa YouTube'da arar (sıralı, aralıklı). Hata/eşleşmesizlik → null. */
  bul({ baslik, kanal, sure = null }) {
    const o = this.onbellekte(baslik, kanal);
    if (o !== undefined) return Promise.resolve(o);
    const a = anahtar(baslik, kanal);
    if (this.bekleyen.has(a)) return this.bekleyen.get(a);
    const is = this.kuyruk.then(async () => {
      const bekle = this.son + this.aralikMs - this.simdi();
      if (bekle > 0) await new Promise((r) => setTimeout(r, bekle));
      this.son = this.simdi();
      let id = null;
      try {
        const q = encodeURIComponent([baslik, kanal].filter(Boolean).join(' '));
        const r = await this.getir(`https://www.youtube.com/results?search_query=${q}`, {
          headers: { 'User-Agent': UA, 'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8' },
          signal: AbortSignal.timeout(15000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        id = eslesen(videolariAyikla(await r.text()), { baslik, kanal, sure });
      } catch (e) {
        this.log(`[youtube] arama olmadı: ${e.message}`);
        return null;   // ağ hatası önbelleğe "bulunamadı" diye yazılmaz — sonra yeniden denenir
      }
      this.kayit[a] = { id, zaman: this.simdi() };
      await this._kaydet();
      return id;
    });
    this.kuyruk = is.catch(() => {});
    this.bekleyen.set(a, is);
    is.finally(() => this.bekleyen.delete(a)).catch(() => {});
    return is;
  }

  async _kaydet() {
    const girdiler = Object.entries(this.kayit);
    if (girdiler.length > 5000) {   // en eskiler atılır
      girdiler.sort((x, y) => y[1].zaman - x[1].zaman);
      this.kayit = Object.fromEntries(girdiler.slice(0, 4000));
    }
    try {
      await mkdir(dirname(this.dosya), { recursive: true });
      await writeFile(`${this.dosya}.tmp`, JSON.stringify(this.kayit));
      await rename(`${this.dosya}.tmp`, this.dosya);
    } catch (e) { this.log(`[youtube] önbellek yazılamadı: ${e.message}`); }
  }
}
