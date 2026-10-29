/**
 * Apple TV köprüsü — ajandan Apple TV yardımcısına (agent/atv-yardimci.py, pyatv) satır başına JSON.
 *
 * Yardımcı ilk istekte başlatılır ve açık kalır (bağlantıyı o tutar; her komutta yeniden kurmak Pi 3'te
 * ~3,5 sn). Süreç düşerse bekleyen istekler hata alır, sonraki istek yeniden başlatır.
 * Kimlik dosyası yoksa (Apple TV hiç eşleştirilmemiş) `hazirMi()` false — ajan TV'nin kendi uygulamasına döner.
 *
 * Yardımcı açılır açılmaz art arda çöküyorsa (bozuk sanal ortam, eksik paket) her istekte yeniden başlatmak
 * boşuna: `HIZLI_CIKIS_SINIRI` hızlı çıkıştan sonra `BEKLEME_MS` boyunca `hazirMi()` false döner (ajan TV'nin
 * kendi uygulamasına düşer) ve günlüğe tek satır yazılır. Ölü sürecin stdin'ine yazım (EPIPE) yakalanır —
 * dinleyicisiz akış hatası ajanı düşürürdü.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const HIZLI_CIKIS_MS = 5000;
const HIZLI_CIKIS_SINIRI = 3;
const BEKLEME_MS = 10 * 60 * 1000;

export class AtvHata extends Error {
  constructor(kod, mesaj) { super(mesaj); this.kod = kod; }
}

export class AppleTvKopru {
  /**
   * @param {object} o
   * @param {string} o.python  pyatv kurulu Python (örn. /opt/pyatv/bin/python3)
   * @param {string} o.betik   agent/atv-yardimci.py
   * @param {string} o.depo    pyatv kimlik dosyası (eşleştirme bunu yazar)
   */
  constructor({ python, betik, depo, spawnFn = spawn, varMi = existsSync, log = () => {}, simdi = Date.now }) {
    Object.assign(this, { python, betik, depo, spawnFn, varMi, log, simdi });
    this.no = 0;
    this.bekleyen = new Map();
    this.surec = null;
    this.hizliCikis = 0;
    this.beklemeSonu = 0;
  }

  hazirMi() {
    if (this.simdi() < this.beklemeSonu) return false;
    return this.varMi(this.python) && this.varMi(this.betik) && this.varMi(this.depo);
  }

  _baslat() {
    const p = this.spawnFn(this.python, [this.betik, this.depo], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.surec = p;
    const basladi = this.simdi();
    const bitti = (neden) => {
      if (this.surec !== p) return;
      this.surec = null;
      for (const [no, b] of this.bekleyen) { this.bekleyen.delete(no); b.red(new AtvHata(502, `Apple TV yardımcısı kapandı (${neden})`)); }
      if (this.simdi() - basladi < HIZLI_CIKIS_MS) {
        if (++this.hizliCikis >= HIZLI_CIKIS_SINIRI) {
          this.hizliCikis = 0;
          this.beklemeSonu = this.simdi() + BEKLEME_MS;
          this.log(`[apple-tv] yardımcı art arda açılışta kapandı (${neden}) — ${BEKLEME_MS / 60000} dk Apple TV kullanılmıyor, TV'nin uygulamasına düşülüyor`);
        }
      } else this.hizliCikis = 0;
    };
    // Ölü sürecin stdin'ine yazım EPIPE verir; dinleyicisiz akış hatası süreci düşürür.
    p.stdin?.on?.('error', (e) => { bitti(`stdin ${e.code || e.message}`); try { p.kill?.(); } catch { /* yok say */ } });
    createInterface({ input: p.stdout }).on('line', (satir) => {
      let j;
      try { j = JSON.parse(satir); } catch { return; }
      const b = j.no != null && this.bekleyen.get(j.no);
      if (!b) return;
      this.bekleyen.delete(j.no);
      if (j.ok) b.coz(j); else b.red(new AtvHata(502, `Apple TV: ${j.hata || 'bilinmeyen hata'}`));
    });
    createInterface({ input: p.stderr }).on('line', (satir) => {
      if (satir.trim()) this.log(`[apple-tv] ${satir.slice(0, 300)}`);
    });
    p.on('exit', (kod) => bitti(`çıkış ${kod}`));
    p.on('error', (e) => bitti(e.message));
  }

  /**
   * Bir iş gönderir: "uygulama" {uygulama}, "tus" {tus}, "metin" {metin}, "uygulamalar", "oynayan", "uyku",
   * "uygulama-kapat", "sistem" (bkz. atv-yardimci.py).
   */
  iste(cihaz, is, ek = {}, ms = 25000) {
    if (!this.hazirMi()) {
      return Promise.reject(this.simdi() < this.beklemeSonu
        ? new AtvHata(503, 'Apple TV yardımcısı çalışmıyor (art arda kapandı) — bir süre sonra yeniden denenecek')
        : new AtvHata(409, 'Apple TV eşleştirilmemiş'));
    }
    if (!this.surec) this._baslat();
    const p = this.surec;
    const no = ++this.no;
    return new Promise((coz, red) => {
      const z = setTimeout(() => { this.bekleyen.delete(no); red(new AtvHata(504, 'Apple TV yanıt vermedi')); }, ms);
      this.bekleyen.set(no, {
        coz: (j) => { clearTimeout(z); coz(j); },
        red: (e) => { clearTimeout(z); red(e); },
      });
      try {
        if (!p || p.stdin?.destroyed) throw new Error('yardımcı kapalı');
        p.stdin.write(JSON.stringify({ no, cihaz, is, ...ek }) + '\n');
      } catch (e) {
        this.bekleyen.delete(no);
        clearTimeout(z);
        red(new AtvHata(502, `Apple TV yardımcısına yazılamadı (${e.message})`));
      }
    });
  }

  kapat() {
    if (this.surec) { try { this.surec.stdin.end(); } catch { /* yok say */ } }
  }
}
