/**
 * Kanal listesi düzenleme işi + HTTP kilidi — sahte TV, sahte liste okuyucu ve sahte sürücüyle; TV'ye dokunmaz.
 *   node --test agent/test/kanal-sirasi.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanalSirasi } from '../net/kanal-sirasi.mjs';
import { Tv, sunucuKur } from '../tv-ajan.mjs';

const TOKEN = 'x'.repeat(40);
const bekle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const ertelenen = () => { let coz; let red; const soz = new Promise((a, b) => { coz = a; red = b; }); return { soz, coz, red }; };
const kanal = (no) => ({ key: `${no}_${100 + no}`, channelId: `c${no}`, number: no, minor: 0, name: `KANAL ${no}`, raw: {} });
const LISTE = [1, 2, 3, 4, 5].map(kanal);

function sahteTv() {
  const t = new Tv({ id: 'tv1', ad: 'TV 1', ip: '192.0.2.11', mac: 'aa:bb:cc:dd:ee:01' }, 'anahtar', {});
  t.baglan = async () => ({ ip: '192.0.2.11' });   // sahte oturum: ağa çıkılmaz
  t.uyanis = null;                                  // verilirse uyanma bunu bekler
  t.uyan = async () => { if (t.uyanis) await t.uyanis; return { uyandirildi: false }; };
  t.tuslar = [];
  t.tus = async (ad) => { t.tuslar.push(ad); };
  return t;
}

function kur({ liste = LISTE } = {}) {
  const dizin = mkdtempSync(join(tmpdir(), 'kanal-'));
  const is = { d: null, cagri: null };
  const ks = new KanalSirasi({
    dizin, oneriDizini: dizin,
    okuFn: async () => liste,
    uygulaFn: (ssap, sira, o) => { is.cagri = o; is.d = ertelenen(); return is.d.soz; },
  });
  return { dizin, ks, is, temizle: () => rmSync(dizin, { recursive: true, force: true }) };
}

async function sunucuyla(tvler, ops, fn) {
  const s = sunucuKur(tvler, { token: TOKEN, log: () => {}, ...ops });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const taban = `http://127.0.0.1:${s.address().port}`;
  const iste = (yol, govde) => fetch(taban + yol, {
    method: govde ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: govde ? JSON.stringify(govde) : undefined,
  });
  try { await fn(iste); } finally { await new Promise((r) => s.close(r)); }
}

test('kilit: iş başlamadan önceki uyanma penceresinde de, iş sürerken de başka komut 409; bitince serbest', async () => {
  const k = kur();
  const t = sahteTv();
  const uyanma = ertelenen();
  t.uyanis = uyanma.soz;
  await sunucuyla([t], { kanalSirasi: k.ks }, async (iste) => {
    const sirala = iste('/kanal-sirala', { tv: 'tv1', sira: ['3_103', '1_101'] });
    for (let i = 0; i < 100 && !k.ks.mesgul('tv1'); i++) await bekle();
    assert.equal(k.ks.mesgul('tv1'), true, 'istek gelir gelmez rezerve');
    assert.equal(k.ks.calisiyor('tv1'), false, 'iş henüz başlamadı (TV uyanıyor)');
    assert.equal((await iste('/tus', { tv: 'tv1', tus: 'EXIT' })).status, 409, 'uyanma sırasında gelen tuş');
    assert.equal((await iste('/kanal', { tv: 'tv1', ad: 'Kanal 1' })).status, 409);
    uyanma.coz();
    const r = await sirala;
    assert.equal(r.status, 200);
    assert.equal((await r.json()).is.durum, 'calisiyor');
    assert.equal((await iste('/tus', { tv: 'tv1', tus: 'EXIT' })).status, 409, 'iş sürerken');
    k.is.d.coz({ yapilan: 2, hatali: 0, sure: 1, eksik: [] });
    for (let i = 0; i < 100 && k.ks.mesgul('tv1'); i++) await bekle();
    assert.equal((await iste('/tus', { tv: 'tv1', tus: 'EXIT' })).status, 200, 'bitince serbest');
  });
  assert.deepEqual(t.tuslar, ['EXIT'], 'menüye yalnız iş bittikten sonraki tuş gitti');
  k.temizle();
});

test('kilit: kilitten ÖNCE kabul edilip sırada bekleyen tuş, iş rezerve edildiyse çalışma anında 409 alır', async () => {
  const k = kur();
  const t = sahteTv();
  const tikali = ertelenen();
  t.sirayla(() => tikali.soz);   // sırayı tutan yavaş bir iş
  await sunucuyla([t], { kanalSirasi: k.ks }, async (iste) => {
    const tus = iste('/tus', { tv: 'tv1', tus: 'ENTER' });
    await bekle(20);
    const sirala = iste('/kanal-sirala', { tv: 'tv1', sira: ['3_103'] });
    for (let i = 0; i < 100 && !k.ks.mesgul('tv1'); i++) await bekle();
    tikali.coz();
    assert.equal((await tus).status, 409);
    assert.equal((await sirala).status, 200);
    k.is.d.coz({ yapilan: 1, hatali: 0, sure: 1, eksik: [] });
  });
  assert.deepEqual(t.tuslar, []);
  k.temizle();
});

test('ikinci sıralama isteği 409 alır ve kayıtlı sırayı EZMEZ', async () => {
  const k = kur();
  const t = sahteTv();
  await sunucuyla([t], { kanalSirasi: k.ks }, async (iste) => {
    assert.equal((await iste('/kanal-sirala', { tv: 'tv1', sira: ['2_102', '1_101'] })).status, 200);
    assert.equal((await iste('/kanal-sirala', { tv: 'tv1', sira: ['1_101'] })).status, 409);
    assert.deepEqual((await k.ks.kayitli('tv1')).sira, ['2_102', '1_101']);
    k.is.d.coz({ yapilan: 1, hatali: 0, sure: 1, eksik: [] });
  });
  k.temizle();
});

test('gövde sınırı: tam kanal listesi (~660 anahtar) kanal uçlarına sığar; diğer uçlar 4 KB', async () => {
  const k = kur();
  const t = sahteTv();
  const sira = Array.from({ length: 663 }, (_, i) => `${10000 + i}_${20000 + i}`);
  await sunucuyla([t], { kanalSirasi: k.ks }, async (iste) => {
    const r = await iste('/kanal-sirasi-kaydet', { tv: 'tv1', sira });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).kayitli.sira.length, 663);
    assert.equal((await iste('/bildirim', { tv: 'tv1', mesaj: 'x', dolgu: 'y'.repeat(5000) })).status, 413);
  });
  k.temizle();
});

test('uydu listesi yoksa (kablo/karasal) liste, öneri ve sıralama 422 — iş başlamaz', async () => {
  const k = kur({ liste: [] });
  const t = sahteTv();
  await sunucuyla([t], { kanalSirasi: k.ks }, async (iste) => {
    const l = await iste('/kanal-listesi?tv=tv1');
    assert.equal(l.status, 422);
    assert.match((await l.json()).hata, /uydu/);
    assert.equal((await iste('/kanal-sirala', { tv: 'tv1', sira: ['1_101'] })).status, 422);
    assert.equal(k.ks.durum('tv1'), null);
    assert.equal(k.ks.mesgul('tv1'), false, 'rezerv bırakıldı');
  });
  k.temizle();
});

test('iş sürerken durum yoklamasındaki hata işin bağlantısını kapatmaz; bitince kanal önbelleği boşalır', async () => {
  const k = kur();
  const t = sahteTv();
  let birakildi = 0;
  t.birak = () => { birakildi++; };
  t.iste = async () => { throw new Error('yanıt gelmedi (zaman aşımı)'); };
  t.liste = [{ no: 1, ad: 'KANAL 1', channelId: 'c1' }];
  t.listeZamani = Date.now();
  await k.ks.baslat(t, ['2_102']);
  assert.equal(t.duzenleniyor, true);
  const d = await t.durum();
  assert.equal(d.acik, false);
  assert.equal(birakildi, 0, 'iş sürerken bağlantı bırakılmadı');
  k.is.d.coz({ yapilan: 1, hatali: 0, sure: 1, eksik: [] });
  for (let i = 0; i < 100 && k.ks.calisiyor('tv1'); i++) await bekle();
  await bekle(10);
  assert.equal(t.duzenleniyor, false);
  assert.equal(t.liste, null, 'numaralar değişti: liste yeniden okunacak');
  await t.durum();
  assert.equal(birakildi, 1, 'iş bitince eski davranış');
  k.temizle();
});

test('yeniden başlatma: sürerken kalan iş "yarim" görünür ve bildirilir; hatalı adım görüntüsü teşhis dizinine', async () => {
  const k = kur();
  const t = sahteTv();
  await k.ks.baslat(t, ['2_102']);
  k.is.cagri.ilerleme({ yapilan: 1, kalan: 4 });
  k.is.cagri.onShot(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'hata-1.jpg');
  await bekle(30);
  assert.deepEqual(readdirSync(join(k.dizin, 'teshis')), ['kanal-tv1-hata-1.jpg']);
  const kayit = JSON.parse(readFileSync(join(k.dizin, 'kanal-is-tv1.json'), 'utf8'));
  assert.deepEqual([kayit.durum, kayit.yapilan], ['calisiyor', 1]);
  // Süreç burada "ölür": yeni süreç aynı dizinle açılır.
  const yeni = new KanalSirasi({ dizin: k.dizin, oneriDizini: k.dizin });
  assert.deepEqual(await yeni.yukle(), ['tv1']);
  const d = yeni.durum('tv1');
  assert.equal(d.durum, 'yarim');
  assert.match(d.hata, /yarıda/);
  assert.equal(yeni.calisiyor('tv1'), false, 'yarım iş kilit tutmaz');
  assert.deepEqual(await new KanalSirasi({ dizin: k.dizin, oneriDizini: k.dizin }).yukle(), [], 'bir kez bildirilir');
  k.is.d.coz({ yapilan: 1, hatali: 0, sure: 1, eksik: [] });
  k.temizle();
});

test('kapanış: süren işe dur denir ve bitmesi beklenir', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'kanal-'));
  const ks = new KanalSirasi({
    dizin, oneriDizini: dizin, okuFn: async () => LISTE,
    uygulaFn: async (ssap, sira, o) => { for (let i = 0; i < 200; i++) { if (o.durdur()) throw new Error('kullanıcı durdurdu'); await bekle(); } return { yapilan: 0, hatali: 0, sure: 0, eksik: [] }; },
  });
  const t = sahteTv();
  await ks.baslat(t, ['2_102']);
  await ks.hepsiniDurdur(2000);
  assert.equal(ks.durum('tv1').durum, 'durduruldu');
  rmSync(dizin, { recursive: true, force: true });
});

test('taşıma planı: yerinde kalabilecek en büyük küme oynatılmaz (50. sıradan 3.\'ye almak tek taşıma)', async () => {
  const { createRequire } = await import('node:module');
  const MovePlan = createRequire(import.meta.url)('../net/moveplan.cjs');
  const liste = Array.from({ length: 50 }, (_, i) => `k${i + 1}`);
  const { moves, target } = MovePlan.plan(liste, ['k1', 'k2', 'k50']);
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0], { id: 'k50', from: 49, to: 2 });
  assert.deepEqual(target.slice(0, 4), ['k1', 'k2', 'k50', 'k3']);
  assert.throws(() => MovePlan.plan(liste, ['yok']), /listesinde yok/);
  assert.throws(() => MovePlan.plan(liste, ['k1', 'k1']), /iki kez/);
});

test('öneri eşleme: kimlikle eşleşen kanallar önerinin sırasıyla başa, bulunamayanlar ayrıca bildirilir', async () => {
  const { oneriyiEsle } = await import('../net/kanal-sirasi.mjs');
  const tvKanal = (no, ad, SVCID) => ({ key: `${no}_${SVCID}`, channelId: `c${no}`, number: no, minor: 0, name: ad, raw: { SVCID, TSID: 7, ONID: 1 } });
  const liste = [tvKanal(1, 'BİRİNCİ', 101), tvKanal(2, 'İKİNCİ', 102), tvKanal(3, 'ÜÇÜNCÜ', 103)];
  const tarif = { kanallar: [
    { name: 'ÜÇÜNCÜ', number: 1, SVCID: 103, TSID: 7, ONID: 1 },
    { name: 'BİRİNCİ', number: 2, SVCID: 101, TSID: 7, ONID: 1 },
    { name: 'BU TV\'DE YOK', number: 3, SVCID: 999, TSID: 8, ONID: 1 },
  ] };
  const r = oneriyiEsle(tarif, liste);
  assert.deepEqual(r.kanallar.map((k) => k.ad), ['ÜÇÜNCÜ', 'BİRİNCİ', 'İKİNCİ']);
  assert.equal(r.eslesen, 2);
  assert.deepEqual(r.bulunamayan, ['BU TV\'DE YOK']);
});
