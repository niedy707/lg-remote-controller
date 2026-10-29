/**
 * YouTube video bulucu testleri — sahte arama sayfasıyla; ağa çıkmaz.
 *   node --test agent/test/youtube-bul.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YoutubeBulucu, videolariAyikla, eslesen, ayir, sureSn } from '../net/youtube-bul.mjs';
import { youtubeEkle } from '../tv-ajan.mjs';

const video = (id, baslik, kanal, sure) => ({ videoRenderer: { videoId: id, title: { runs: [{ text: baslik }] }, ownerText: { runs: [{ text: kanal }] }, lengthText: { simpleText: sure } } });
const sayfa = (...v) => `<html><script>var ytInitialData = ${JSON.stringify({ contents: { a: { b: v } } })};</script></html>`;
const SAYFA = sayfa(
  video('aaaaaaaaaa1', 'Benzer Bir Video', 'Örnek Kanal', '5:00'),
  video('bbbbbbbbbb2', 'İLK VİDEO BAŞLIĞI?', 'Örnek Kanal', '8:56'),
  video('cccccccccc3', 'İlk video başlığı?', 'Başka Kanal', '3:10'),
);

test('ayıklama: arama sayfasındaki videolar sırayla, süre saniye', () => {
  const v = videolariAyikla(SAYFA);
  assert.equal(v.length, 3);
  assert.deepEqual(v[1], { id: 'bbbbbbbbbb2', baslik: 'İLK VİDEO BAŞLIĞI?', kanal: 'Örnek Kanal', sure: 536 });
  assert.deepEqual(videolariAyikla('<html>veri yok</html>'), []);
  assert.equal(sureSn('1:02:03'), 3723);
});

test('eşleşme: başlık birebir (Türkçe büyük/küçük harf duyarsız) VE kanal ya da süre tutmalı', () => {
  const v = videolariAyikla(SAYFA);
  assert.equal(eslesen(v, { baslik: 'ilk video başlığı?', kanal: 'örnek kanal' }), 'bbbbbbbbbb2');
  assert.equal(eslesen(v, { baslik: 'İLK VİDEO BAŞLIĞI?', kanal: 'Yanlış', sure: 535 }), 'bbbbbbbbbb2');
  assert.equal(eslesen(v, { baslik: 'İLK VİDEO BAŞLIĞI?', kanal: 'Yanlış', sure: 100 }), null);
  assert.equal(eslesen(v, { baslik: 'Hiç olmayan', kanal: 'Örnek Kanal' }), null);
});

test('program metni "Başlık (Kanal)" ayrılır; başlıktaki parantez korunur', () => {
  assert.deepEqual(ayir('Bir Video (Kanal)'), { baslik: 'Bir Video', kanal: 'Kanal' });
  assert.deepEqual(ayir('Film (2024) fragman (Kanal Adı)'), { baslik: 'Film (2024) fragman', kanal: 'Kanal Adı' });
  assert.deepEqual(ayir('Kanalsız'), { baslik: 'Kanalsız', kanal: null });
});

function kur(yanit) {
  const dizin = mkdtempSync(join(tmpdir(), 'yt-'));
  const saat = { t: 1e12 };
  const istekler = [];
  const getir = async (url) => { istekler.push(url); const y = typeof yanit === 'function' ? yanit() : yanit; if (y instanceof Error) throw y; return { ok: true, status: 200, text: async () => y }; };
  const b = new YoutubeBulucu({ dizin, getir, simdi: () => saat.t, aralikMs: 0 });
  return { b, saat, istekler, dizin, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

test('önbellek: bulunan kalıcı (diske de), bulunamayan 1 gün sonra yeniden sorulur, ağ hatası önbelleğe girmez', async () => {
  const k = kur(SAYFA);
  assert.equal(await k.b.bul({ baslik: 'İLK VİDEO BAŞLIĞI?', kanal: 'Örnek Kanal' }), 'bbbbbbbbbb2');
  assert.equal(await k.b.bul({ baslik: 'İLK VİDEO BAŞLIĞI?', kanal: 'Örnek Kanal' }), 'bbbbbbbbbb2');
  assert.equal(k.istekler.length, 1);
  const ikinci = new YoutubeBulucu({ dizin: k.dizin, getir: async () => { throw new Error('ağa çıkmamalı'); } });
  await ikinci.yukle();
  assert.equal(ikinci.onbellekte('ilk video başlığı?', 'örnek kanal'), 'bbbbbbbbbb2');

  assert.equal(await k.b.bul({ baslik: 'Yok', kanal: 'Örnek Kanal' }), null);
  assert.equal(k.b.onbellekte('Yok', 'Örnek Kanal'), null);
  k.saat.t += 25 * 3600e3;
  assert.equal(k.b.onbellekte('Yok', 'Örnek Kanal'), undefined);

  const h = kur(new Error('ağ yok'));
  assert.equal(await h.b.bul({ baslik: 'İLK VİDEO BAŞLIĞI?', kanal: 'Örnek Kanal' }), null);
  assert.equal(h.b.onbellekte('İLK VİDEO BAŞLIĞI?', 'Örnek Kanal'), undefined);
  k.temizle(); h.temizle();
});

test('izleme ucu: YouTube kesitlerine kimlik eklenir, diğerlerine dokunulmaz', async () => {
  const k = kur(SAYFA);
  const kesitler = [
    { uygulama: 'YouTube', program: 'İLK VİDEO BAŞLIĞI? (Örnek Kanal)' },
    { uygulama: 'YouTube', program: 'Hiç olmayan (Örnek Kanal)' },
    { uygulama: null, kaynak: 'canli', program: 'İLK VİDEO BAŞLIĞI? (Örnek Kanal)' },
  ];
  await youtubeEkle(kesitler, k.b);
  assert.equal(kesitler[0].youtube, 'bbbbbbbbbb2');
  assert.equal(kesitler[1].youtube, undefined);
  assert.equal(kesitler[2].youtube, undefined);
  k.temizle();
});
