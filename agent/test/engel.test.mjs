/**
 * YouTube engelleri testleri — sahte YouTube yanıtları ve sahte TV ile; ağa ve TV'ye dokunmaz.
 *   node --test agent/test/engel.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngelListesi, EngelBekcisi, linkCoz, katla, kanalAdiAyikla, MESAJ, UYARI } from '../net/engel.mjs';

test('link çözme: video ve kanal biçimleri; düz metin link sayılmaz', () => {
  assert.deepEqual(linkCoz('https://www.youtube.com/watch?v=abcdefghijk&t=30s'), { tur: 'video', id: 'abcdefghijk' });
  assert.deepEqual(linkCoz('youtu.be/abcdefghijk?si=x'), { tur: 'video', id: 'abcdefghijk' });
  assert.deepEqual(linkCoz('https://m.youtube.com/shorts/abcdefghijk'), { tur: 'video', id: 'abcdefghijk' });
  assert.deepEqual(linkCoz('https://www.youtube.com/@OrnekKanal/videos'), { tur: 'kanal', yol: '@OrnekKanal' });
  assert.deepEqual(linkCoz('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv'), { tur: 'kanal', yol: 'channel/UCabcdefghijklmnopqrstuv' });
  assert.equal(linkCoz('ornekkelime'), null);
  assert.equal(linkCoz('https://example.com/watch?v=abcdefghijk'), null);
});

test('katlama: Türkçe büyük/küçük harf ve aksan farkı gözetilmez', () => {
  assert.equal(katla('İNCİR'), katla('incir'));
  assert.equal(katla('INCIR'), katla('incir'));
  assert.equal(katla('ÇİÇEK Şiirleri'), 'cicek siirleri');
});

function liste(getir = async () => { throw new Error('ağa çıkmamalı'); }) {
  const dizin = mkdtempSync(join(tmpdir(), 'engel-'));
  const l = new EngelListesi({ dizin, getir });
  return { l, dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}
const yanit = (govde, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => govde, text: async () => govde });

test('ekleme: video linki başlık+kanalı oEmbed\'den, kanal linki adı kanal sayfasından alır; aynısı iki kez eklenmez', async () => {
  const { l, dizin, temizle } = liste(async (url) => {
    if (url.includes('/oembed')) return yanit({ title: 'Örnek Video Başlığı', author_name: 'Örnek Kanal' });
    if (url.includes('/@OrnekKanal')) return yanit('<html><script>var x = {"channelMetadataRenderer":{"title":"Örnek \\"Kanal\\" TV","description":""}}</script></html>');
    throw new Error(`beklenmeyen ${url}`);
  });
  const v = await l.ekle({ metin: 'https://youtu.be/abcdefghijk' });
  assert.equal(v.kural.tur, 'video');
  assert.equal(v.kural.baslik, 'Örnek Video Başlığı');
  assert.equal(v.kural.kanal, 'Örnek Kanal');
  const k = await l.ekle({ metin: 'https://www.youtube.com/@OrnekKanal' });
  assert.deepEqual([k.kural.tur, k.kural.deger], ['kanal', 'Örnek "Kanal" TV']);
  const w = await l.ekle({ metin: 'bulut' });
  assert.equal(w.kural.tur, 'kelime');
  const vk = await l.ekle({ metin: 'https://youtu.be/bbbbbbbbbbb', tur: 'kanal' });
  assert.deepEqual([vk.kural.tur, vk.kural.deger, vk.kural.ornek], ['kanal', 'Örnek Kanal', 'Örnek Video Başlığı'], 'video linkinden kanalı');
  await l.sil(vk.kural.id);
  const ad = await l.ekle({ metin: 'Bir Kanal', tur: 'kanal' });
  assert.equal(ad.kural.tur, 'kanal');
  assert.equal((await l.ekle({ metin: 'BULUT' })).varmis, true);
  assert.equal(l.durum().kurallar.length, 4);
  const ikinci = new EngelListesi({ dizin });
  await ikinci.yukle();
  assert.equal(ikinci.durum().kurallar.length, 4);
  await l.sil(w.kural.id);
  assert.equal(l.durum().kurallar.length, 3);
  await assert.rejects(l.sil('yok'), /kural yok/);
  temizle();
});

test('eşleşme: video (başlık+kanal ya da kimlik), kanal adı, kelime sözcük başında', async () => {
  const { l, temizle } = liste(async () => yanit({ title: 'Örnek Video Başlığı', author_name: 'Örnek Kanal' }));
  await l.ekle({ metin: 'https://youtu.be/abcdefghijk' });
  await l.ekle({ metin: 'Bir Kanal', tur: 'kanal' });
  await l.ekle({ metin: 'deniz' });
  assert.equal(l.eslesen({ baslik: 'ÖRNEK VİDEO BAŞLIĞI', kanal: 'örnek kanal' })?.tur, 'video');
  assert.equal(l.eslesen({ baslik: 'Örnek Video Başlığı', kanal: 'Başka Kanal' }), null);
  assert.equal(l.eslesen({ baslik: 'Başka', kanal: 'Başka', videoId: 'abcdefghijk' })?.tur, 'video');
  assert.equal(l.eslesen({ baslik: 'Herhangi', kanal: 'BİR KANAL' })?.tur, 'kanal');
  assert.equal(l.eslesen({ baslik: 'En güzel DENİZLERİ geziyoruz', kanal: 'X' })?.tur, 'kelime');
  assert.equal(l.eslesen({ baslik: 'Ödeniz ne kadar', kanal: 'X' }), null, 'sözcük ortasında geçmesi tutmaz');
  temizle();
});

function sahteTv(oynayanlar) {
  const komutlar = [];
  const bildirimler = [];
  return {
    id: 'tv1', appletv: { ip: '192.0.2.5', id: 'x' }, komutlar, bildirimler,
    appledaOynayan: async () => (oynayanlar.length > 1 ? oynayanlar.shift() : oynayanlar[0]),
    appleKomut: async (tus) => { komutlar.push(tus); },
    uyariGoster: async (m, ms) => { bildirimler.push([m, ms]); },
  };
}

test('bekçi: kademeli — 1. duraklat + geri ×2, yine oynatılırsa 2. YouTube kapat', async () => {
  const { l, temizle } = liste();
  await l.ekle({ metin: 'deniz' });
  const yt = (durum) => ({ uygulama: 'YouTube', baslik: 'Deniz videosu', sanatci: 'Bir Kanal', durum });
  const tv = sahteTv([yt('playing'), yt('paused')]);
  let kapatma = 0;
  tv.appleUygulamaKapat = async () => { kapatma++; };
  const uyarilar = [];
  tv.uyariGoster = async (satirlar, ms) => { uyarilar.push([satirlar, ms]); };   // MESAJ + UYARI birlikte
  const saat = { t: 1e12 };
  const b = new EngelBekcisi({ tvler: [tv], liste: l, bekle: async () => {}, simdi: () => saat.t });
  const oynat = async () => { tv.sira = [yt('playing'), yt('paused')]; return b.denetle(tv); };
  tv.appledaOynayan = async () => (tv.sira.length > 1 ? tv.sira.shift() : tv.sira[0]);
  const kural = await oynat();
  assert.equal(kural.tur, 'kelime');
  assert.deepEqual(tv.komutlar, ['pause', 'menu', 'menu'], '1. kademe: duraklat + oynatıcıdan çık');
  assert.deepEqual(uyarilar, [[MESAJ, 8000]], '1. kademe: ortada 8 sn');
  assert.equal(l.durum().olaylar[0].baslik, 'Deniz videosu');
  // duraklatılmış haliyle tekrar sorulunca bir şey yapılmaz
  assert.equal(await b.denetle(tv), null);
  saat.t += 60000;
  await oynat();
  assert.equal(kapatma, 1, '2. kademe: YouTube kapatılır');
  assert.deepEqual(uyarilar, [[MESAJ, 8000], [MESAJ, 4000], [UYARI, 10000]], '1. kademe MESAJ; 2. kademe MESAJ (4 sn) + UYARI');
  saat.t += 60000;
  await oynat();
  assert.equal(kapatma, 2, 'yine açılırsa yine kapatılır');
  assert.deepEqual(l.durum().olaylar.map((o) => o.seviye), [2, 2, 1]);
  // 10 dk sessizlikten sonra yeniden 1. kademe
  saat.t += 11 * 60000;
  tv.komutlar.length = 0;
  await oynat();
  assert.deepEqual(tv.komutlar, ['pause', 'menu', 'menu']);
  temizle();
});

test('bekçi: tuş kaçtıysa (hâlâ oynuyor) bir kez daha; YouTube dışı ve kuralsız içeriğe dokunmaz', async () => {
  const { l, temizle } = liste();
  await l.ekle({ metin: 'deniz' });
  const yt = { uygulama: 'YouTube', baslik: 'Deniz videosu', sanatci: 'K', durum: 'playing' };
  const tv = sahteTv([yt, yt]);
  await new EngelBekcisi({ tvler: [tv], liste: l, bekle: async () => {} }).denetle(tv);
  assert.deepEqual(tv.komutlar, ['pause', 'menu', 'menu', 'pause'], 'tuş kaçtıysa yeniden duraklatılır');
  const nf = sahteTv([{ uygulama: 'Netflix', baslik: 'Deniz', durum: 'playing' }]);
  assert.equal(await new EngelBekcisi({ tvler: [nf], liste: l, bekle: async () => {} }).denetle(nf), null);
  const temiz = sahteTv([{ uygulama: 'YouTube', baslik: 'Belgesel', sanatci: 'K', durum: 'playing' }]);
  assert.equal(await new EngelBekcisi({ tvler: [temiz], liste: l, bekle: async () => {} }).denetle(temiz), null);
  assert.deepEqual([nf.komutlar, temiz.komutlar], [[], []]);
  temizle();
});

test('kanal adı ayıklama: og:title yedeği', () => {
  assert.equal(kanalAdiAyikla('<meta property="og:title" content="A &amp; B">'), 'A & B');
  assert.equal(kanalAdiAyikla('<html></html>'), null);
});

test('işlem kaydı: kural eklendi / silindi, engelleme açıldı / kapatıldı — kaynakla', async () => {
  const { l, temizle } = liste();
  const { kural } = await l.ekle({ metin: 'deniz' }, 'panel');
  await l.ayarla({ acik: false }, 'panel');
  await l.ayarla({ acik: true }, 'dogrudan');
  await l.sil(kural.id, 'panel');
  assert.deepEqual(l.durum().islemler.map((i) => [i.ne, i.deger ?? null, i.kaynak]), [
    ['silindi', 'deniz', 'panel'], ['acildi', null, 'dogrudan'], ['kapatildi', null, 'panel'], ['eklendi', 'deniz', 'panel'],
  ]);
  temizle();
});

// ───────────────────────────────────────────── ekran metinleri ayarlanabilir

test('metinler: varsayılan nötr; mesaj/uyari ayarlanır, aradaki boş satır kalır, baş/son atılır, boş → varsayılan; diske yazılır', async () => {
  const { l, dizin, temizle } = liste();
  assert.deepEqual(l.durum().mesaj, MESAJ);
  assert.deepEqual(l.durum().uyari, UYARI);
  assert.ok(MESAJ.length >= 1 && UYARI.length >= 1);
  const d = await l.ayarla({ mesaj: '\n🚫 Bu video kapatıldı\n\nSonra konuşalım\n\n', uyari: ['Uyarı satırı'] }, 'panel');
  assert.deepEqual(d.mesaj, ['🚫 Bu video kapatıldı', '', 'Sonra konuşalım']);
  assert.deepEqual(d.uyari, ['Uyarı satırı']);
  assert.equal(d.acik, true, 'acik verilmediyse değişmez');
  const ikinci = new EngelListesi({ dizin });
  await ikinci.yukle();
  assert.deepEqual(ikinci.durum().mesaj, ['🚫 Bu video kapatıldı', '', 'Sonra konuşalım']);
  assert.deepEqual(ikinci.durum().uyari, ['Uyarı satırı']);
  await l.ayarla({ mesaj: '', uyari: [] });
  assert.deepEqual([l.mesaj(), l.uyari()], [MESAJ, UYARI], 'boş → varsayılan');
  assert.deepEqual(l.durum().islemler.slice(0, 2).map((i) => i.ne).sort(), ['mesaj-degisti', 'uyari-degisti']);
  temizle();
});

test('metinler: en çok 5 satır, satır başı 80 karakter; geçersizse hiçbir alan değişmez; boş gövde 400', async () => {
  const { l, temizle } = liste();
  await assert.rejects(l.ayarla({ mesaj: 'a\nb\nc\nd\ne\nf' }), (e) => e.kod === 400 && /5 satır/.test(e.message));
  await assert.rejects(l.ayarla({ uyari: ['x'.repeat(81)] }), (e) => e.kod === 400 && /80 karakter/.test(e.message));
  await assert.rejects(l.ayarla({ acik: false, mesaj: 42 }), (e) => e.kod === 400);
  assert.equal(l.veri.acik, true, 'geçersiz istekte acik da değişmedi');
  assert.ok(await l.ayarla({ mesaj: 'a\n\nb\nc\nd' }), 'aradaki boş satır dahil 5 satır kabul');
  await assert.rejects(l.ayarla({}), (e) => e.kod === 400);
  temizle();
});

test('bekçi: ayarlanan metinleri gösterir (1. kademe mesaj, 2. kademe mesaj + uyarı)', async () => {
  const { l, temizle } = liste();
  await l.ekle({ metin: 'deniz' });
  await l.ayarla({ mesaj: ['Özel engel metni'], uyari: ['Özel uyarı', 'ikinci satır'] });
  const yt = (durum) => ({ uygulama: 'YouTube', baslik: 'Deniz videosu', sanatci: 'Bir Kanal', durum });
  const tv = sahteTv([]);
  const uyarilar = [];
  tv.uyariGoster = async (satirlar, ms) => { uyarilar.push([satirlar, ms]); };
  tv.appleUygulamaKapat = async () => {};
  const saat = { t: 1e12 };
  const b = new EngelBekcisi({ tvler: [tv], liste: l, bekle: async () => {}, simdi: () => saat.t });
  const oynat = async () => { tv.sira = [yt('playing'), yt('paused')]; return b.denetle(tv); };
  tv.appledaOynayan = async () => (tv.sira.length > 1 ? tv.sira.shift() : tv.sira[0]);
  await oynat();
  saat.t += 60000;
  await oynat();
  assert.deepEqual(uyarilar, [[['Özel engel metni'], 8000], [['Özel engel metni'], 4000], [['Özel uyarı', 'ikinci satır'], 10000]]);
  temizle();
});

test('HTTP: GET /engel mesaj+uyari döner; POST /engel/ayar {acik, mesaj, uyari}; kaynak X-Istemci başlığından', async () => {
  const { sunucuKur } = await import('../tv-ajan.mjs');
  const { l, temizle } = liste();
  const TOKEN = 'x'.repeat(40);
  const s = sunucuKur([], { token: TOKEN, log: () => {}, engel: l });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const taban = `http://127.0.0.1:${s.address().port}`;
  const iste = (yol, govde, basliklar = {}) => fetch(taban + yol, { method: govde ? 'POST' : 'GET', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...basliklar }, body: govde ? JSON.stringify(govde) : undefined });
  try {
    const g = await (await iste('/engel')).json();
    assert.deepEqual([g.mesaj, g.uyari, g.acik], [MESAJ, UYARI, true]);
    const r = await iste('/engel/ayar', { mesaj: 'Satır 1\n\nSatır 3', uyari: ['Tek satır'] }, { 'X-Istemci': 'panel' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual([j.ok, j.mesaj, j.uyari, j.acik], [true, ['Satır 1', '', 'Satır 3'], ['Tek satır'], true]);
    assert.equal(j.islemler[0].kaynak, 'panel');
    const k = await (await iste('/engel/ayar', { acik: false })).json();
    assert.deepEqual([k.acik, k.mesaj, k.islemler[0].ne, k.islemler[0].kaynak], [false, ['Satır 1', '', 'Satır 3'], 'kapatildi', 'dogrudan']);
    assert.equal((await iste('/engel/ayar', { mesaj: 'a\nb\nc\nd\ne\nf' })).status, 400);
    assert.equal((await iste('/engel/ayar', {})).status, 400);
    const e = await iste('/engel', { metin: 'deniz' });
    assert.equal(e.status, 201);
    assert.equal((await iste('/engel', { metin: 'DENİZ' })).status, 200, 'aynı kural ikinci kez: 200 varmis');
    const kural = (await e.json()).kural;
    const sil = await fetch(`${taban}/engel?id=${kural.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.deepEqual([sil.status, (await sil.json()).kurallar.length], [200, 0]);
  } finally {
    await new Promise((r) => s.close(r));
    temizle();
  }
});

test('kayıt: diske yazılamazsa kural ekleme ve ayar 500 alır ("eklendi" denmez); bekçinin olayı atmaz', async () => {
  const kok = mkdtempSync(join(tmpdir(), 'engel-'));
  try {
    writeFileSync(join(kok, 'dosya'), 'x');
    const l = new EngelListesi({ dizin: join(kok, 'dosya', 'alt'), getir: async () => { throw new Error('ağa çıkmamalı'); } });
    await assert.rejects(l.ekle({ metin: 'deniz' }), (e) => e.kod === 500);
    await assert.rejects(l.ayarla({ acik: false }), (e) => e.kod === 500);
    await l.olayEkle({ tv: 'tv1', baslik: 'x' });
    const yeni = new EngelListesi({ dizin: join(kok, 'yok', 'dizin') });
    await yeni.ekle({ metin: 'deniz' });
    const ikinci = new EngelListesi({ dizin: join(kok, 'yok', 'dizin') });
    await ikinci.yukle();
    assert.equal(ikinci.durum().kurallar.length, 1, 'yoktan oluşturulan dizine yazıldı');
  } finally { rmSync(kok, { recursive: true, force: true }); }
});
