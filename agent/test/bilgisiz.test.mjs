/**
 * Oynatma bilgisi vermeyen Apple TV uygulaması (bazı IPTV oynatıcıları) — sahte Apple TV ve sahte ekranla.
 *   node --test agent/test/bilgisiz.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tv } from '../tv-ajan.mjs';

function kur(durum) {
  const tv = new Tv({ id: 'tv1', ad: 'TV 1', ip: '192.0.2.11', mac: 'aa:bb:cc:dd:ee:01', appletv: { ip: '192.0.2.12', id: 'ORNEK000001' } }, 'anahtar', {
    atv: { hazirMi: () => true, iste: async (cihaz, is) => (is === 'sistem' ? { sistem: durum.sistem } : {}) },
    hareketOlc: async () => durum.fark,
  });
  tv.ekran = async () => Buffer.from('jpeg');
  tv.hareketAraMs = 0;
  return tv;
}
const bekle = () => new Promise((r) => setTimeout(r, 5));
const youtubeDuraklatilmis = { uygulama: 'YouTube', baslik: 'Eski video', durum: 'paused' };

test('Apple TV "oynuyor" demiyor, uyanık ve ekranda hareket var → bilgisiz uygulama oynuyor', async () => {
  const tv = kur({ sistem: 'awake', fark: 42 });
  assert.equal(tv._bilgisizIsle(youtubeDuraklatilmis).uygulama, 'YouTube', 'ilk sorguda ölçüm başlar, beklemez');
  await bekle();
  const o = tv._bilgisizIsle(youtubeDuraklatilmis);
  assert.deepEqual([o.uygulama, o.durum, o.baslik, o.tahmin], ['Apple TV', 'playing', null, 'ekran-hareketi']);
  // Apple TV yeniden "oynuyor" derse (YouTube'a dönüldü) tahmin düşer
  assert.equal(tv._bilgisizIsle({ uygulama: 'YouTube', baslik: 'Yeni', durum: 'playing' }).baslik, 'Yeni');
  assert.equal(tv._bilgisiz, null);
});

test('ekran koruyucu (manzaralar hareketli) ya da durağan ekran → tahmin yok', async () => {
  const koruyucu = kur({ sistem: 'screensaver', fark: 42 });
  koruyucu._bilgisizIsle(youtubeDuraklatilmis);
  await bekle();
  assert.equal(koruyucu._bilgisizIsle(youtubeDuraklatilmis).uygulama, 'YouTube');
  const duragan = kur({ sistem: 'awake', fark: 0.4 });
  duragan._bilgisizIsle(null);
  await bekle();
  assert.equal(duragan._bilgisizIsle(null), null);
});

test('Netflix bildiriliyorsa (menü, fragman) ekran hareketine bakılmaz — Netflix olarak kalır', async () => {
  const tv = kur({ sistem: 'awake', fark: 42 });
  const nf = { uygulama: 'Netflix', baslik: null, durum: 'idle' };
  tv._bilgisizIsle(nf);
  await bekle();
  assert.equal(tv._bilgisizIsle(nf).uygulama, 'Netflix');
});
