/**
 * İzleme kaydı testleri — sahte TV durumları ve sahte saatle; TV'ye dokunmaz.
 *   node --test agent/test/izleme.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IzlemeKaydi, ozetle, kesitAnahtari, trGun } from '../net/izleme.mjs';

const TR = 3 * 3600e3;
const tr = (y, m, d, s, dk = 0) => Date.UTC(y, m - 1, d, s, dk) - TR;
const canli = (no, ad, program) => ({ acik: true, kaynak: 'canli', kanal: { no, ad, program: program ? { ad: program } : null } });
const KAPALI = { acik: false };

function kur(baslangic = tr(2026, 10, 18, 20, 0)) {
  const dizin = mkdtempSync(join(tmpdir(), 'izleme-'));
  const saat = { t: baslangic };
  const durumlar = { tv1: KAPALI, tv2: KAPALI };
  const tvler = Object.keys(durumlar).map((id) => ({ id, durum: async () => { if (durumlar[id] === 'hata') throw new Error('ağ'); return durumlar[id]; } }));
  const iz = new IzlemeKaydi({ dizin, tvler, simdi: () => saat.t });
  const adim = async (dk = 0.5) => { saat.t += dk * 60000; await iz.ornekle(); };
  return { dizin, saat, durumlar, iz, adim, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

test('anahtar: kapalı → null; canlıda kanal+program, uygulamada uygulama adı', () => {
  assert.equal(kesitAnahtari(KAPALI), null);
  assert.deepEqual(kesitAnahtari(canli(3, 'KANAL D HD', 'Dizi')).kanal, { no: 3, ad: 'KANAL D HD' });
  const n = kesitAnahtari({ acik: true, kaynak: 'netflix', uygulama: 'netflix', uygulamaAdi: 'Netflix' });
  assert.equal(n.uygulama, 'Netflix');
  assert.equal(n.kanal, null);
});

test('kesit: açılınca başlar, program değişince bölünür, iki ardışık kapalı örnekle son görülmede kapanır', async () => {
  const k = kur();
  await k.iz.yukle();
  k.durumlar.tv1 = canli(3, 'KANAL D HD', 'Haberler');
  await k.adim();                                   // 20:00:30 açıldı
  await k.adim(30);                                 // 20:30:30 aynı program
  k.durumlar.tv1 = canli(3, 'KANAL D HD', 'Dizi');
  await k.adim(0.5);                                // 20:31 program değişti
  await k.adim(60);                                 // 21:31
  k.durumlar.tv1 = KAPALI;
  await k.adim(0.5);                                // tek kapalı örnek: henüz kapanmaz
  await k.adim(0.5);                                // ikinci: son görülmede (21:31) kapanır
  const ks = await k.iz.kesitler({ bas: tr(2026, 10, 18, 0), bit: tr(2026, 10, 19, 0) });
  assert.equal(ks.length, 2);
  assert.equal(ks[0].program, 'Haberler');
  assert.equal(ks[0].bit - ks[0].bas, 30.5 * 60000);
  assert.equal(ks[1].program, 'Dizi');
  assert.equal(ks[1].bit, tr(2026, 10, 18, 21, 31));
  assert.ok(!ks.some((x) => x.acik));
  k.temizle();
});

test('tek bir ağ aksaklığı izlemeyi bölmez', async () => {
  const k = kur();
  await k.iz.yukle();
  k.durumlar.tv1 = canli(7, 'TV8', 'Yarışma');
  await k.adim();
  k.durumlar.tv1 = 'hata';
  await k.adim();
  k.durumlar.tv1 = canli(7, 'TV8', 'Yarışma');
  await k.adim();
  const ks = await k.iz.kesitler({ bas: tr(2026, 10, 18, 0), bit: tr(2026, 10, 19, 0) });
  assert.equal(ks.length, 1);
  assert.equal(ks[0].acik, true);
  k.temizle();
});

test('yeniden başlatma: açık kesit son görülmede kapatılır, aradaki boşluk izleme sayılmaz', async () => {
  const k = kur();
  await k.iz.yukle();
  k.durumlar.tv2 = canli(1, 'TRT 1', 'Film');
  await k.adim();
  await k.adim(10);
  const ikinci = new IzlemeKaydi({ dizin: k.dizin, tvler: [], simdi: () => k.saat.t + 3600e3 });
  await ikinci.yukle();
  const ks = await ikinci.kesitler({ bas: tr(2026, 10, 18, 0), bit: tr(2026, 10, 19, 0) });
  assert.equal(ks.length, 1);
  assert.equal(ks[0].bit, k.saat.t);
  k.temizle();
});

test('özet: toplam, kanal ve saat dağılımı (İstanbul saati); aralık dışı kısım sayılmaz', () => {
  const kesitler = [
    { tv: 'tv1', bas: tr(2026, 10, 18, 20, 30), bit: tr(2026, 10, 18, 22, 0), kaynak: 'canli', kanal: { no: 3, ad: 'KANAL D HD' }, program: 'Dizi' },
    { tv: 'tv1', bas: tr(2026, 10, 18, 23, 30), bit: tr(2026, 10, 19, 0, 30), kaynak: 'netflix', kanal: null, program: null, uygulama: 'Netflix' },
  ];
  const o = ozetle(kesitler, { bas: tr(2026, 10, 18, 0), bit: tr(2026, 10, 19, 0) });
  assert.equal(o.toplam, 120 * 60000);                  // 90 dk + (gece yarısına kadar) 30 dk
  assert.equal(o.kanal['KANAL D HD'], 90 * 60000);
  assert.equal(o.uygulama.Netflix, 30 * 60000);
  assert.equal(o.saat[20], 30 * 60000);
  assert.equal(o.saat[21], 60 * 60000);
  assert.equal(o.saat[23], 30 * 60000);
});

test('saklama: 365 günden eski gün dosyaları silinir', async () => {
  const k = kur();
  await k.iz.yukle();
  writeFileSync(join(k.dizin, `${trGun(k.saat.t - 400 * 86400e3)}.jsonl`), '{}\n');
  writeFileSync(join(k.dizin, `${trGun(k.saat.t - 10 * 86400e3)}.jsonl`), '{}\n');
  await k.iz.temizle();
  const kalan = readdirSync(k.dizin).filter((f) => f.endsWith('.jsonl'));
  assert.equal(kalan.length, 1);
  k.temizle();
});

test('Apple TV: oynayan içerik kesite uygulama + başlık (kanal) olarak girer; dizi bölümüyle yazılır', () => {
  const yt = kesitAnahtari({ acik: true, kaynak: 'apple', uygulamaAdi: 'HDMI 2', oynayan: { uygulama: 'YouTube', baslik: 'Bir Video', sanatci: 'Bir Kanal', durum: 'playing' } });
  assert.equal(yt.uygulama, 'YouTube');
  assert.equal(yt.program, 'Bir Video (Bir Kanal)');
  const nf = kesitAnahtari({ acik: true, kaynak: 'apple', oynayan: { uygulama: 'Netflix', dizi: 'Bir Dizi', sezon: 2, bolum: 5, baslik: 'Bölüm Adı' } });
  assert.equal(nf.program, 'Bir Dizi S2B5 — Bölüm Adı');
  const bos = kesitAnahtari({ acik: true, kaynak: 'apple', uygulamaAdi: 'HDMI 2', oynayan: { uygulama: 'YouTube', durum: 'idle' } });
  assert.equal(bos.program, null);
  assert.equal(bos.uygulama, 'YouTube');
  assert.equal(bos.pasif, 'bekleme', 'menüde / ana ekranda: oynayan yok → bekleme (gri)');
  assert.equal(kesitAnahtari({ acik: true, kaynak: 'apple', oynayan: { uygulama: 'Netflix', durum: 'playing' } }).pasif, null);
  assert.equal(kesitAnahtari({ acik: true, kaynak: 'canli', kanal: { no: 1, ad: 'X' } }).pasif, null, 'canlı yayın hep izleme');
});

test('duraklatma: Apple TV oynatması duraklatılınca ayrı (pasif) kesit; özet izleme süresine katmaz', async () => {
  const k = kur();
  await k.iz.yukle();
  const yt = (durum) => ({ acik: true, kaynak: 'apple', oynayan: { uygulama: 'YouTube', baslik: 'Bir Video', sanatci: 'Bir Kanal', durum } });
  k.durumlar.tv1 = yt('playing');
  await k.adim();                                   // 20:00:30 oynuyor
  await k.adim(10);                                 // 20:10:30
  k.durumlar.tv1 = yt('paused');
  await k.adim(0.5);                                // 20:11 duraklatıldı
  await k.adim(30);                                 // 20:41 hâlâ duraklatılmış
  k.durumlar.tv1 = yt('playing');
  await k.adim(0.5);                                // 20:41:30 devam
  await k.adim(5);                                  // 20:46:30
  const ks = await k.iz.kesitler({ bas: tr(2026, 10, 18, 0), bit: tr(2026, 10, 19, 0) });
  assert.deepEqual(ks.map((x) => x.pasif || null), [null, 'duraklatildi', null]);
  assert.equal(ks[1].program, 'Bir Video (Bir Kanal)');
  const o = ozetle(ks, { bas: tr(2026, 10, 18, 0), bit: tr(2026, 10, 19, 0) });
  assert.equal(o.toplam, 46 * 60000);
  assert.equal(o.pasif, 30.5 * 60000);
  assert.equal(o.izlenen, 15.5 * 60000);
  assert.equal(o.uygulama.YouTube, 15.5 * 60000);
  k.temizle();
});
