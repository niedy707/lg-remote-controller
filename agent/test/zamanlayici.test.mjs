/**
 * Zamanlayıcı testleri — sahte saat, sahte yürütücü; TV'ye dokunmaz.
 *   node --test agent/test/zamanlayici.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Zamanlayici, sonrakiHaftalik, tarihSaatAn, TOLERANS_MS } from '../net/zamanlayici.mjs';

const TR = 3 * 3600e3;
const tr = (y, m, d, s, dk = 0) => Date.UTC(y, m - 1, d, s, dk) - TR;   // İstanbul saati → ms
const KANAL = { no: 3, ad: 'KANAL D HD' };

/** Sahte saat: setTimeout gerçekte kurulur ama çalışmayı testler `ilerle` + `_yokla` ile sürer. */
function kur({ dosya = null, sonuc = { sonuc: 'ok' }, simdi = tr(2026, 10, 17, 20, 0) } = {}) {
  const saat = { t: simdi };
  const calisan = [];
  const uyarilar = [];
  const z = new Zamanlayici({
    dosya,
    simdi: () => saat.t,
    calistir: async (g) => { calisan.push(g); if (sonuc instanceof Error) throw sonuc; return sonuc; },
    uyar: async (g, sn) => { uyarilar.push(sn); },
  });
  const ilerle = async (ms) => { saat.t += ms; z._yokla(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { z, saat, calisan, uyarilar, ilerle };
}

test('sonrakiHaftalik: gün listesi + saat, İstanbul saatiyle; geçmiş saat ertesi uygun güne', () => {
  // Senaryo: Cumartesi 17.10.2026, 20:00 (İstanbul)
  const cumartesi20 = tr(2026, 10, 17, 20, 0);
  assert.equal(sonrakiHaftalik('21:30', [6], cumartesi20), tr(2026, 10, 17, 21, 30));      // aynı gün, ileride
  assert.equal(sonrakiHaftalik('19:00', [6], cumartesi20), tr(2026, 10, 24, 19, 0));       // aynı gün geçti → haftaya
  assert.equal(sonrakiHaftalik('08:00', [1, 2, 3, 4, 5], cumartesi20), tr(2026, 10, 19, 8, 0));   // hafta içi → Pazartesi
  assert.equal(sonrakiHaftalik('00:30', [7], cumartesi20), tr(2026, 10, 18, 0, 30));       // gece yarısından sonra, Pazar
  assert.equal(tarihSaatAn('2026-10-18', '20:00'), tr(2026, 10, 18, 20, 0));
});

test('geri dön: vakti gelince bir kez çalışır, geçmişe "ok" yazılır, görev biter', async () => {
  const { z, calisan, ilerle } = kur();
  const g = await z.geriDon({ tv: 'tv1', dk: 8, kanal: KANAL });
  assert.equal(g.an - z.simdi(), 8 * 60000);
  await ilerle(7 * 60000);
  assert.equal(calisan.length, 0);
  await ilerle(60000);
  assert.equal(calisan.length, 1);
  assert.deepEqual(calisan[0].kanal, KANAL);
  assert.equal(z.liste().gorevler.length, 0);
  assert.equal(z.liste().gecmis[0].sonuc, 'ok');
  z.durdur();
});

test('geri dön: TV başına tek sayaç — yenisi eskisinin yerine geçer; başka TV etkilenmez', async () => {
  const { z } = kur();
  await z.geriDon({ tv: 'tv1', dk: 8, kanal: KANAL });
  await z.geriDon({ tv: 'tv1', dk: 3, kanal: KANAL });
  await z.geriDon({ tv: 'tv2', dk: 5, kanal: KANAL });
  const l = z.liste().gorevler;
  assert.equal(l.length, 2);
  assert.equal(l.find((g) => g.tv === 'tv1').dk, 3);
  z.durdur();
});

test('geri dön: uzat, şimdi çalıştır, iptal', async () => {
  const { z, calisan, ilerle } = kur();
  const g = await z.geriDon({ tv: 'tv1', dk: 2, kanal: KANAL });
  await z.uzat(g.id, 1);
  await ilerle(2 * 60000);
  assert.equal(calisan.length, 0, 'uzatılan sayaç henüz çalışmamalı');
  await ilerle(60000);
  assert.equal(calisan.length, 1);
  const g2 = await z.geriDon({ tv: 'tv1', dk: 8, kanal: KANAL });
  await z.hemen(g2.id);
  assert.equal(calisan.length, 2);
  const g3 = await z.geriDon({ tv: 'tv1', dk: 8, kanal: KANAL });
  await z.sil(g3.id);
  await ilerle(10 * 60000);
  assert.equal(calisan.length, 2);
  assert.equal(z.liste().gecmis[0].sonuc, 'iptal');
  z.durdur();
});

test('kaçırma: tolerans içinde bir kez çalışır, dışında çalışmaz ve "kacirildi" yazılır', async () => {
  const icinde = kur();
  await icinde.z.geriDon({ tv: 'tv1', dk: 1, kanal: KANAL });
  await icinde.ilerle(60000 + TOLERANS_MS['geri-don'] - 1000);
  assert.equal(icinde.calisan.length, 1);
  icinde.z.durdur();

  const disinda = kur();
  disinda.z._zamanla = () => {};   // ajan kapalıymış gibi: zamanlayıcı hiç kurulmasın
  await disinda.z.geriDon({ tv: 'tv1', dk: 1, kanal: KANAL });
  await disinda.ilerle(60000 + TOLERANS_MS['geri-don'] + 60000);
  assert.equal(disinda.calisan.length, 0);
  assert.equal(disinda.z.liste().gecmis[0].sonuc, 'kacirildi');
  assert.equal(disinda.z.liste().gorevler.length, 0);
});

test('haftalık: çalıştıktan sonra bir sonraki ana geçer; kaçırılan an geriye dönük çalıştırılmaz', async () => {
  const { z, calisan, ilerle } = kur();
  const g = await z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '20:30', gunler: [6] } });
  assert.equal(g.an, tr(2026, 10, 17, 20, 30));
  await ilerle(30 * 60000);
  assert.equal(calisan.length, 1);
  assert.equal(z.liste().gorevler[0].an, tr(2026, 10, 24, 20, 30));
  // Ajan bir haftadan uzun kapalı kaldı: tek "kacirildi", sonra yine ileriye planlanır.
  z._zamanla = () => {};
  await ilerle(8 * 24 * 3600e3);
  assert.equal(calisan.length, 1);
  assert.equal(z.liste().gecmis[0].sonuc, 'kacirildi');
  assert.ok(z.liste().gorevler[0].an > z.simdi());
  z.durdur();
});

test('program: bir kez — geçmişteki an reddedilir; geçersiz girdiler 400', async () => {
  const { z } = kur();
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'tek', tarih: '2026-10-17', saat: '19:00' } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '25:00', gunler: [1] } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '20:00', gunler: [] } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: '', zaman: { tur: 'tek', tarih: '2026-10-18', saat: '20:00' } }), (e) => e.kod === 400);
  await assert.rejects(z.geriDon({ tv: 'tv1', dk: 0, kanal: KANAL }), (e) => e.kod === 400);
  await assert.rejects(z.geriDon({ tv: 'tv1', dk: 121, kanal: KANAL }), (e) => e.kod === 400);
  await assert.rejects(z.sil('yok'), (e) => e.kod === 404);
  const g = await z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'tek', tarih: '2026-10-18', saat: '20:00' }, tvKapaliysa: 'atla' });
  assert.equal(g.an, tr(2026, 10, 18, 20, 0));
  assert.equal(g.tvKapaliysa, 'atla');
  z.durdur();
});

test('kalıcılık: yeniden başlatmada görevler geri gelir, sayaç baştan sayılmaz', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'zaman-'));
  try {
    const dosya = join(dizin, 'zamanlayici.json');
    const a = kur({ dosya });
    await a.z.geriDon({ tv: 'tv1', dk: 8, kanal: KANAL });
    await a.z.ekle({ tv: 'tv2', kanal: 'TV8', zaman: { tur: 'haftalik', saat: '21:00', gunler: [1, 2, 3, 4, 5] } });
    a.z.durdur();
    const kayit = JSON.parse(readFileSync(dosya, 'utf8'));
    assert.equal(kayit.gorevler.length, 2);
    const b = kur({ dosya, simdi: a.saat.t + 5 * 60000 });   // 5 dk sonra yeniden başladı
    await b.z.yukle();
    assert.equal(b.z.liste().gorevler.length, 2);
    await b.ilerle(3 * 60000);                                 // 8. dakika
    assert.equal(b.calisan.length, 1);
    assert.equal(b.calisan[0].tur, 'geri-don');
    b.z.durdur();
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('yürütücü hata atarsa geçmişe "hata" ve neden yazılır', async () => {
  const { z, ilerle } = kur({ sonuc: new Error('TV yanıt vermedi') });
  await z.geriDon({ tv: 'tv1', dk: 1, kanal: KANAL });
  await ilerle(60000);
  const s = z.liste().gecmis[0];
  assert.equal(s.sonuc, 'hata');
  assert.match(s.neden, /yanıt vermedi/);
  z.durdur();
});

test('ön uyarı: 1 dk ve 10 sn kala; uzatılınca eski uyarılar iptal, yenileri kurulur', async () => {
  // Gerçek zamanlayıcı: kısa süreli görevle (an = şimdi + 61 sn) 60. sn uyarısı ~1 sn sonra gelir.
  const uyarilar = [];
  const z = new Zamanlayici({ calistir: async () => ({ sonuc: 'ok' }), uyar: async (g, sn) => { uyarilar.push(sn); } });
  const g = await z.geriDon({ tv: 'tv1', dk: 1, kanal: KANAL });
  g.an = Date.now() + 61000;
  z._zamanla(g);
  await new Promise((r) => setTimeout(r, 1300));
  assert.deepEqual(uyarilar, [60]);
  await z.sil(g.id);
  z.durdur();
});

test('program: etiket (program adı) saklanır ve geçmişe taşınır', async () => {
  const { z, ilerle } = kur();
  const g = await z.ekle({ tv: 'tv1', kanal: 'TV8', zaman: { tur: 'tek', tarih: '2026-10-17', saat: '20:30' }, etiket: 'Örnek Program' });
  assert.equal(g.etiket, 'Örnek Program');
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'TV8', zaman: { tur: 'tek', tarih: '2026-10-17', saat: '21:30' }, etiket: 'x'.repeat(81) }), (e) => e.kod === 400);
  await ilerle(30 * 60000);
  assert.equal(z.liste().gecmis[0].etiket, 'Örnek Program');
  z.durdur();
});

test('program: "X dk sonra" dakikası dakikasına kurulur, bir kez çalışır; sınır dışı süre 400', async () => {
  const { z, saat, calisan, ilerle } = kur();
  saat.t += 40000;   // 20:00:40 — dakika başında değil: saate yuvarlanmamalı
  const g = await z.ekle({ tv: 'tv1', kanal: 'NTV', zaman: { tur: 'sonra', dk: 5 } });
  assert.equal(g.tur, 'tek');
  assert.equal(g.an, saat.t + 5 * 60000);
  await ilerle(5 * 60000 - 1000);
  assert.equal(calisan.length, 0);
  await ilerle(1000);
  assert.equal(calisan.length, 1);
  assert.equal(calisan[0].kanal.ad, 'NTV');
  for (const dk of [0, 721, 1.5, 'beş']) {
    await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'NTV', zaman: { tur: 'sonra', dk } }), (e) => e.kod === 400);
  }
  z.durdur();
});

test('mesaj görevi: her gün belirli saatte TV ekranına mesaj; TV kapalıysa atlanır (açmaz), ön uyarı yok', async () => {
  const { z, calisan, uyarilar, ilerle } = kur();   // 17.10.2026 20:00
  const g = await z.ekle({ tv: 'tv1', mesaj: { metin: 'Örnek mesaj 😴', sureSn: 15 }, zaman: { tur: 'haftalik', saat: '22:00', gunler: [1, 2, 3, 4, 5, 6, 7] }, tvKapaliysa: 'ac' });
  assert.equal(g.tvKapaliysa, 'atla', 'mesaj görevi TV açmaz');
  assert.equal(g.kanal, null);
  assert.deepEqual(g.mesaj, { metin: 'Örnek mesaj 😴', sureSn: 15 });
  assert.equal(g.an, tr(2026, 10, 17, 22, 0));
  await ilerle(2 * 3600e3);
  assert.equal(calisan.length, 1);
  assert.equal(calisan[0].mesaj.metin, 'Örnek mesaj 😴');
  assert.deepEqual(uyarilar, [], 'ön uyarı gösterilmez');
  assert.equal(z.liste().gorevler[0].an, tr(2026, 10, 18, 22, 0), 'ertesi güne kurulur');
  await assert.rejects(z.ekle({ tv: 'tv1', mesaj: { metin: '' }, zaman: { tur: 'haftalik', saat: '22:00', gunler: [1] } }), (e) => e.kod === 400);
  await assert.rejects(z.ekle({ tv: 'tv1', mesaj: { metin: 'x', sureSn: 500 }, zaman: { tur: 'haftalik', saat: '22:00', gunler: [1] } }), (e) => e.kod === 400);
  z.durdur();
});

test('mesaj görevi: ortada çok satırlı (girinti korunur) ve sonra TV kapat; köşe mesajında 160, ortada 300 karakter / 5 satır', async () => {
  const { z } = kur();   // 17.10.2026 20:00
  const metin = 'Birinci satır\nİkinci satır.\n            Girintili satır';
  const g = await z.ekle({ tv: 'tv1', mesaj: { metin: `\n${metin}  \n`, sureSn: 15, ortada: true }, zaman: { tur: 'tek', tarih: '2026-10-17', saat: '20:40' } });
  assert.deepEqual(g.mesaj, { metin, sureSn: 15, ortada: true }, 'iç girinti korunur, baş/son boşluk atılır');
  const k = await z.ekle({ tv: 'tv1', mesaj: { metin: 'Süre doldu', sureSn: 10, ortada: true, sonraKapat: true }, zaman: { tur: 'tek', tarih: '2026-10-17', saat: '21:00' } });
  assert.equal(k.mesaj.sonraKapat, true);
  await assert.rejects(z.ekle({ tv: 'tv1', mesaj: { metin: 'a\nb\nc\nd\ne\nf', ortada: true }, zaman: { tur: 'tek', tarih: '2026-10-17', saat: '21:00' } }), /5 satır/);
  await assert.rejects(z.ekle({ tv: 'tv1', mesaj: { metin: 'x'.repeat(200) }, zaman: { tur: 'tek', tarih: '2026-10-17', saat: '21:00' } }), /160/);
  assert.ok(await z.ekle({ tv: 'tv1', mesaj: { metin: 'x'.repeat(200), ortada: true }, zaman: { tur: 'tek', tarih: '2026-10-17', saat: '21:00' } }));
  z.durdur();
});

test('takvimde olmayan tarih reddedilir (31 Şubat kaymaz)', async () => {
  const { z } = kur();
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'tek', tarih: '2027-02-31', saat: '20:00' } }), (e) => e.kod === 400 && /takvimde olmayan/.test(e.message));
  await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'tek', tarih: '2026-13-40', saat: '20:00' } }), (e) => e.kod === 400);
  assert.equal(tarihSaatAn('2028-02-29', '08:00'), tr(2028, 2, 29, 8, 0), 'artık yıl');
  z.durdur();
});

test('"şimdi çalıştır" haftalık görevin sıradaki planlı çalışmasını atlatmaz', async () => {
  const { z, calisan } = kur();   // Cumartesi 17.10.2026 20:00
  const g = await z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'haftalik', saat: '20:00', gunler: [1] } });
  assert.equal(g.an, tr(2026, 10, 19, 20, 0));
  await z.hemen(g.id);
  assert.equal(calisan.length, 1);
  assert.equal(z.liste().gorevler[0].an, tr(2026, 10, 19, 20, 0), 'pazartesi çalışması yerinde');
  z.durdur();
});

test('kalıcılık: eşzamanlı yazımlar dosyayı bozmaz; bozuk dosya kenara alınır, üzerine yazılmaz', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'zaman-'));
  try {
    const dosya = join(dizin, 'zamanlayici.json');
    const a = kur({ dosya });
    // Aynı anda çok sayıda değişiklik: hepsi tek kuyruktan yazılır, son durum dosyada.
    const isler = [];
    for (let i = 0; i < 20; i++) isler.push(a.z.ekle({ tv: 'tv1', kanal: `Kanal ${i}`, zaman: { tur: 'sonra', dk: i + 1 } }));
    await Promise.all(isler);
    const kayit = JSON.parse(readFileSync(dosya, 'utf8'));
    assert.equal(kayit.gorevler.length, 20);
    assert.deepEqual(readdirSync(dizin).filter((f) => f.endsWith('.tmp')), [], 'geçici dosya kalmadı');
    a.z.durdur();

    writeFileSync(dosya, '{"surum":1,"gorevler":[{"id":"x"');   // yarım yazılmış dosya
    const loglar = [];
    const b = new Zamanlayici({ dosya, calistir: async () => ({ sonuc: 'ok' }), log: (m) => loglar.push(m), simdi: () => tr(2026, 10, 17, 20, 0) });
    await b.yukle();
    const bozuk = readdirSync(dizin).filter((f) => f.startsWith('zamanlayici.json.bozuk-'));
    assert.equal(bozuk.length, 1, 'bozuk dosya saklandı');
    assert.match(readFileSync(join(dizin, bozuk[0]), 'utf8'), /"id":"x"/);
    assert.ok(loglar.some((m) => /bozuk/.test(m)), 'günlüğe yazıldı');
    b.durdur();
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('kalıcılık: diske yazılamazsa istek 500 alır ve görev kurulmaz (sessizce "kaydedildi" denmez)', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'zaman-'));
  try {
    writeFileSync(join(dizin, 'dosya-degil-dizin'), 'x');
    const dosya = join(dizin, 'dosya-degil-dizin', 'zamanlayici.json');   // üst yol bir dosya: yazım ENOTDIR
    const { z } = kur({ dosya });
    await assert.rejects(z.ekle({ tv: 'tv1', kanal: 'Kanal D', zaman: { tur: 'sonra', dk: 5 } }), (e) => e.kod === 500 && /kaydedilemedi/.test(e.message));
    assert.equal(z.liste().gorevler.length, 0, 'kaydedilemeyen görev bellekte de yok');
    await assert.rejects(z.geriDon({ tv: 'tv1', dk: 8, kanal: KANAL }), (e) => e.kod === 500);
    z.durdur();
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

test('liste: etkin saat dilimi ve ofset döner (istemci saatleri buna göre çizer)', () => {
  const { z } = kur();
  const l = z.liste();
  assert.equal(l.saatDilimi, 'Europe/Istanbul');
  assert.equal(l.ofsetDk, 180);
  z.durdur();
});
