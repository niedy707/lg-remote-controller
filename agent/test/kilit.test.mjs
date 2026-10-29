/**
 * TV kilidi testleri — sahte saat ve sahte TV ile; gerçek TV'ye dokunmaz.
 *   node --test agent/test/kilit.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TvKilidi, KilitBekcisi, KILIT_MESAJI } from '../net/kilit.mjs';
import { Tv } from '../tv-ajan.mjs';

function kur() {
  const dizin = mkdtempSync(join(tmpdir(), 'kilit-'));
  const saat = { t: 1e12 };
  const k = new TvKilidi({ dizin, simdi: () => saat.t });
  return { k, saat, dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

test('kilit: süreli kilit süresi dolunca kalkar; süresiz kalır; diske yazılır; geçersiz süre reddedilir', async () => {
  const { k, saat, dizin, temizle } = kur();
  await k.kilitle('tv1', 30);
  await k.kilitle('tv2');
  assert.ok(k.bilgi('tv1'));
  assert.equal(k.bilgi('tv2').bitis, null);
  const ikinci = new TvKilidi({ dizin, simdi: () => saat.t });
  await ikinci.yukle();
  assert.deepEqual(Object.keys(ikinci.durum().kilitler).sort(), ['tv1', 'tv2']);
  saat.t += 31 * 60000;
  assert.equal(k.bilgi('tv1'), null);
  assert.ok(k.bilgi('tv2'));
  await k.ac('tv2');
  assert.equal(k.bilgi('tv2'), null);
  await assert.rejects(k.kilitle('tv1', 0), /süre/);
  await assert.rejects(k.kilitle('tv1', 1.5), /süre/);
  temizle();
});

function sahteTv(acik, appletv = null) {
  const olan = [];
  return {
    id: 'tv1', appletv, olan, acikMi: async () => acik.shift() ?? false,
    uyariGoster: async (m) => olan.push(['uyari', m]), appleUyut: async () => olan.push(['apple-uyku']), kapat: async () => olan.push(['kapat']),
  };
}

test('bekçi: kilitli TV açılınca uyarı + kapat + olay; kapalıysa ya da kilitli değilse dokunmaz', async () => {
  const { k, temizle } = kur();
  const tv = sahteTv([true, false]);
  const b = new KilitBekcisi({ tvler: [tv], kilit: k, bekle: async () => {} });
  assert.equal(await b.denetle(tv), null, 'kilitli değil');
  assert.deepEqual(tv.olan, []);
  await k.kilitle('tv1');
  assert.equal(await b.denetle(tv), 'kapatildi');
  assert.deepEqual(tv.olan, [['uyari', KILIT_MESAJI], ['kapat']], 'Apple TV yok: yalnız TV');
  assert.equal(k.durum().olaylar[0].tv, 'tv1');
  assert.equal(await b.denetle(tv), 'kapali');
  assert.equal(tv.olan.length, 2);
  temizle();
});

test('kapsam: TV + Apple TV → mesaj, Apple TV uyku, TV kapat; yalnız TV → Apple TV\'ye dokunmaz; mesaj ayarı', async () => {
  const { k, temizle } = kur();
  await k.mesajAyarla('Bu TV kilitlidir, izlenemez!\nalt satır: deneme');
  assert.deepEqual(k.mesaj(), ['Bu TV kilitlidir, izlenemez!', 'alt satır: deneme']);
  await assert.rejects(k.mesajAyarla('a\nb\nc\nd\ne\nf'), /5 satır/);
  assert.deepEqual(await k.mesajAyarla('\n🔒 Örnek başlık 🔒\n\nℹ️ Örnek alt satır.\n\n'), ['🔒 Örnek başlık 🔒', '', 'ℹ️ Örnek alt satır.'], 'aradaki boş satır kalır, baş/son atılır');
  await k.mesajAyarla('Bu TV kilitlidir, izlenemez!\nalt satır: deneme');
  await assert.rejects(k.kilitle('tv1', null, 'apple'), /kapsam/);
  const ikisi = sahteTv([true], { ip: '192.0.2.5', id: 'x' });
  await k.kilitle('tv1');
  await new KilitBekcisi({ tvler: [ikisi], kilit: k, bekle: async () => {} }).denetle(ikisi);
  assert.deepEqual(ikisi.olan, [['uyari', ['Bu TV kilitlidir, izlenemez!', 'alt satır: deneme']], ['apple-uyku'], ['kapat']]);
  const yalniz = sahteTv([true], { ip: '192.0.2.5', id: 'x' });
  await k.kilitle('tv1', null, 'tv');
  await new KilitBekcisi({ tvler: [yalniz], kilit: k, bekle: async () => {} }).denetle(yalniz);
  assert.deepEqual(yalniz.olan.map((x) => x[0]), ['uyari', 'kapat']);
  await k.mesajAyarla('');
  assert.deepEqual(k.mesaj(), KILIT_MESAJI);
  temizle();
});

test('kilitli TV: açma (uyan), Apple TV tuşu ve metni 423 ile reddedilir — TV\'ye hiçbir şey gitmez', async () => {
  let wol = 0;
  const tv = new Tv({ id: 'tv1', ad: 'TV 1', ip: '192.0.2.11', mac: 'aa:bb:cc:dd:ee:01', appletv: { ip: '192.0.2.12', id: 'ORNEK000001' } }, 'anahtar', {
    wol: async () => { wol++; }, atv: { hazirMi: () => true, iste: async () => { throw new Error('Apple TV\'ye gitmemeli'); } },
  });
  tv.kilit = { bilgi: () => ({ bitis: null }) };
  await assert.rejects(tv.uyan(), (e) => e.kod === 423 && /TV 1 kilitli/.test(e.message));
  await assert.rejects(tv.appleTus('ENTER'), (e) => e.kod === 423);
  await assert.rejects(tv.appleMetin('a'), (e) => e.kod === 423);
  assert.equal(wol, 0);
});

test('olay kaydı: kilitlendi / açıldı (kaynakla) ve süresi doldu yazılır; kilit yokken açmak kayıt üretmez', async () => {
  const { k, saat, temizle } = kur();
  await k.kilitle('tv1', 30, 'tv', 'panel');
  await k.ac('tv1', 'panel');
  await k.ac('tv1', 'panel');
  await k.kilitle('tv2', 1, 'tv+apple', 'dogrudan');
  saat.t += 2 * 60000;
  assert.equal(k.bilgi('tv2'), null);
  assert.deepEqual(k.durum().olaylar.map((o) => [o.tv, o.ne, o.kaynak ?? null]), [
    ['tv2', 'suresi-doldu', null], ['tv2', 'kilitlendi', 'dogrudan'], ['tv1', 'acildi', 'panel'], ['tv1', 'kilitlendi', 'panel'],
  ]);
  temizle();
});

test('HTTP: /kilit ve /kilit/ayar — kilitlenen TV\'ye /kanal 423; kaynak X-Istemci; DELETE açar', async () => {
  const { sunucuKur } = await import('../tv-ajan.mjs');
  const { k, temizle } = kur();
  const tv = new Tv({ id: 'tv1', ad: 'TV 1', ip: '192.0.2.11', mac: 'aa:bb:cc:dd:ee:01' }, 'anahtar', { wol: async () => { throw new Error('uyandırılmamalı'); } });
  tv.kilit = k;
  tv.baglan = async () => { throw new Error('TV kapalı (sahte) — ağa çıkılmaz'); };
  const TOKEN = 'x'.repeat(40);
  const s = sunucuKur([tv], { token: TOKEN, log: () => {}, kilit: k });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const taban = `http://127.0.0.1:${s.address().port}`;
  const iste = (yol, { yontem, govde, basliklar = {} } = {}) => fetch(taban + yol, { method: yontem || (govde ? 'POST' : 'GET'), headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...basliklar }, body: govde ? JSON.stringify(govde) : undefined });
  try {
    const g = await (await iste('/kilit')).json();
    assert.deepEqual([g.kilitler, g.mesaj, g.tvler], [{}, KILIT_MESAJI, [{ id: 'tv1', ad: 'TV 1' }]]);
    const r = await (await iste('/kilit', { govde: { tv: 'tv1', dk: 30 }, basliklar: { 'X-Istemci': 'panel' } })).json();
    assert.equal(r.ok, true);
    assert.equal(r.kilitler.tv1.kapsam, 'tv', 'Apple TV yok → kapsam tv');
    assert.equal(r.olaylar[0].kaynak, 'panel');
    const kanal = await iste('/kanal', { govde: { tv: 'tv1', ad: 'Kanal D' } });
    assert.equal(kanal.status, 423);
    assert.match((await kanal.json()).hata, /TV 1 kilitli \(\d\d:\d\d'e kadar\)/);
    assert.equal((await iste('/kilit', { govde: { tv: 'tv1', dk: 0 } })).status, 400);
    const m = await (await iste('/kilit/ayar', { govde: { mesaj: '🔒 Kilitli\n\nSonra' } })).json();
    assert.deepEqual(m.mesaj, ['🔒 Kilitli', '', 'Sonra']);
    const ac = await (await iste('/kilit?tv=tv1', { yontem: 'DELETE' })).json();
    assert.deepEqual([ac.kilitler, ac.olaylar[0].ne, ac.olaylar[0].kaynak], [{}, 'acildi', 'dogrudan']);
    const tvler = await (await iste('/tvler')).json();
    assert.equal(tvler.tvler[0].kilit, null);
  } finally {
    await new Promise((r) => s.close(r));
    temizle();
  }
});

test('kayıt: durum dizini yoksa oluşturulur; diske yazılamazsa kilitleme 500 alır, bekçinin olayı ise yalnız günlüğe düşer', async () => {
  const kok = mkdtempSync(join(tmpdir(), 'kilit-'));
  try {
    const k = new TvKilidi({ dizin: join(kok, 'yeni', 'dizin') });
    await k.kilitle('tv1', 10);
    const ikinci = new TvKilidi({ dizin: join(kok, 'yeni', 'dizin') });
    await ikinci.yukle();
    assert.ok(ikinci.bilgi('tv1'), 'yoktan oluşturulan dizine yazıldı');
    writeFileSync(join(kok, 'dosya'), 'x');
    const loglar = [];
    const bozuk = new TvKilidi({ dizin: join(kok, 'dosya', 'alt'), log: (m) => loglar.push(m) });   // üst yol dosya: ENOTDIR
    await assert.rejects(bozuk.kilitle('tv1'), (e) => e.kod === 500 && /kaydedilemedi/.test(e.message));
    assert.ok(bozuk.bilgi('tv1'), 'kilit yine de geçerli (güvenli taraf)');
    await bozuk.olayEkle({ tv: 'tv1', ne: 'kapatildi' });   // atmaz
    assert.ok(loglar.some((m) => /yazılamadı/.test(m)));
  } finally { rmSync(kok, { recursive: true, force: true }); }
});
