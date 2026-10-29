/**
 * Dayanıklılık: ajanı düşürebilecek ya da sessizce yanlış davranan kenar durumlar. Yalnız loopback, sahte soket
 * ve alt süreçle; TV'ye, ev ağına ya da internete çıkmaz.
 *   node --test agent/test/dayaniklilik.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sunucuKur, yetkili, gorevYurutucu } from '../tv-ajan.mjs';
import { connectPlain, connectAuto } from '../ws-client.mjs';
import { LgInput, soketAdresi } from '../net/lg-input.mjs';
import { AppleTvKopru } from '../net/atv-kopru.mjs';
import { wolGonder } from '../net/wol.mjs';
import { Rehber, trGunu } from '../net/rehber.mjs';

const KOK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'x'.repeat(40);
const bekle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────────────────────── HTTP girişi

/** Ham soketle tek istek; yanıtın ilk satırı. */
function hamIstek(port, metin) {
  return new Promise((ok, red) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(metin));
    let veri = '';
    s.on('data', (d) => { veri += d; if (veri.includes('\r\n')) { s.destroy(); ok(veri.split('\r\n')[0]); } });
    s.on('error', red);
    s.setTimeout(3000, () => { s.destroy(); red(new Error('yanıt yok')); });
  });
}

test('HTTP: ayrıştırılamayan istek adresi ajanı düşürmez — belirteçsiz 401, belirteçli 400, sunucu ayakta', async () => {
  const s = sunucuKur([], { token: TOKEN, log: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  try {
    assert.match(await hamIstek(port, 'GET http://[ HTTP/1.1\r\nHost: x\r\n\r\n'), / 401 /);
    assert.match(await hamIstek(port, `GET http://[ HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`), / 400 /);
    const r = await fetch(`http://127.0.0.1:${port}/tvler`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200, 'sonraki istekler çalışıyor');
  } finally { await new Promise((r) => s.close(r)); }
});

test('yetkili: başlıksız, küçük harf "bearer", farklı uzunluk, boş belirteç → hayır; doğru belirteç → evet', () => {
  const req = (h) => ({ headers: h === undefined ? {} : { authorization: h } });
  assert.equal(yetkili(req(undefined), TOKEN), false);
  assert.equal(yetkili(req(`bearer ${TOKEN}`), TOKEN), false);
  assert.equal(yetkili(req(`Bearer ${TOKEN}x`), TOKEN), false);
  assert.equal(yetkili(req('Bearer '), ''), false, 'boş belirteçle hiçbir istek geçmez');
  assert.equal(yetkili(req(`Bearer ${TOKEN}`), TOKEN), true);
});

test('HTTP: gövde JSON nesnesi değilse 400 (dizi, null, sayı)', async () => {
  const s = sunucuKur([], { token: TOKEN, log: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  try {
    for (const govde of ['[]', 'null', '7', '{bozuk']) {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/kanal`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: govde });
      assert.equal(r.status, 400, govde);
    }
  } finally { await new Promise((r) => s.close(r)); }
});

// ───────────────────────────────────────────── WebSocket istemcisi

/** El sıkışmayı yapan, sonra `sonra(soket)` çağıran loopback WS sunucusu. */
async function wsSunucu(sonra) {
  const srv = net.createServer((sock) => {
    let tampon = '';
    let el = false;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      if (el) { sonra(sock, d); return; }
      tampon += d.toString('latin1');
      const m = /Sec-WebSocket-Key: (\S+)/i.exec(tampon);
      if (!tampon.includes('\r\n\r\n') || !m) return;
      el = true;
      const kabul = crypto.createHash('sha1').update(`${m[1]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${kabul}\r\n\r\n`);
      sonra(sock, null);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, kapat: () => new Promise((r) => srv.close(r)) };
}

test('ws: karşı taraf bağlantıyı RST ile koparınca (TV fişten çekildi) süreç düşmez, bağlantı kapalı işaretlenir', async () => {
  const srv = await wsSunucu((sock, d) => { if (d) sock.resetAndDestroy(); });
  try {
    const { conn } = await connectPlain('127.0.0.1', srv.port, { timeoutMs: 2000 });
    const kapandi = new Promise((r) => conn.once('close', r));
    conn.send('ilk tuş');   // dinleyicisiz 'error' olsaydı yakalanmamış istisna olurdu
    await kapandi;
    assert.equal(conn.closed, true);
    conn.send('kapalıya yazım sessizce yok sayılır');
    // Kumanda soketi (LgInput) de aynı bağlantı sınıfını kullanır: kendi dinleyicisi de var.
    const { conn: c2 } = await connectPlain('127.0.0.1', srv.port, { timeoutMs: 2000 });
    const k = new LgInput(c2);
    const k2 = new Promise((r) => c2.once('close', r));
    await k.button('UP', { settleMs: 0 });
    await k2;
    assert.equal(k.conn.closed, true);
  } finally { await srv.kapat(); }
});

test('ws: aşırı büyük çerçeve başlığı (> 16 MB, > 2^53) bağlantıyı kapatır, süreci düşürmez', async () => {
  const srv = await wsSunucu((sock, d) => {
    if (d) return;
    sock.write(Buffer.from([0x81, 127, 0x10, 0, 0, 0, 0, 0, 0, 0]));   // uzunluk 2^60
  });
  try {
    const { conn } = await connectPlain('127.0.0.1', srv.port, { timeoutMs: 2000 });
    if (!conn.closed) await new Promise((r) => conn.once('close', r));
    assert.equal(conn.closed, true);
  } finally { await srv.kapat(); }
});

test('kumanda soketi adresi: TV başka bir konak gösterse de bağlantı eşleşilen TV\'ye gider', () => {
  assert.equal(soketAdresi('wss://192.0.2.5:3001/resources/abc/netinput.pointer.sock', '192.0.2.5'), 'wss://192.0.2.5:3001/resources/abc/netinput.pointer.sock');
  assert.equal(soketAdresi('wss://198.51.100.7:3001/resources/abc/netinput.pointer.sock', '192.0.2.5'), 'wss://192.0.2.5:3001/resources/abc/netinput.pointer.sock');
  assert.throws(() => soketAdresi('http://192.0.2.5/x', '192.0.2.5'), /beklenmeyen/);
});

test('connectAuto: düz ws izni kapalıysa ws:3000 hiç denenmez', async () => {
  await assert.rejects(connectAuto('127.0.0.1', { duzIzin: false, retries: 0, timeoutMs: 500 }), (e) => !/ws:\/\/127\.0\.0\.1:3000/.test(e.message) && /wss:\/\/127\.0\.0\.1:3001/.test(e.message));
});

// ───────────────────────────────────────────── Apple TV yardımcısı

test('Apple TV köprüsü: yardımcının stdin\'i kapanınca yazım (EPIPE) ajanı düşürmez, bekleyenler hata alır', async () => {
  const k = new AppleTvKopru({
    python: 'python', betik: 'b.py', depo: 'd.conf', varMi: () => true,
    // Süreç yaşıyor ama girdisini kapatmış (bozuk sanal ortamda açılış hatası gibi): yazım EPIPE verir.
    spawnFn: (cmd, args, o) => spawn(process.execPath, ['-e', 'require("fs").closeSync(0); setTimeout(() => {}, 1500)'], o),
  });
  const cihaz = { ip: '192.0.2.42', id: 'ORNEK000001' };
  const ilk = k.iste(cihaz, 'tus', { tus: 'up' }, 5000);
  await bekle(400);   // alt süreç girdisini kapattı
  const sonuc = await Promise.allSettled([ilk, ...Array.from({ length: 10 }, () => k.iste(cihaz, 'tus', { tus: 'up' }, 5000))]);
  assert.ok(sonuc.every((s) => s.status === 'rejected'), 'her istek okunur hatayla döner');
  assert.ok(sonuc.some((s) => /stdin|kapandı|yazılamadı/.test(s.reason?.message || '')), sonuc.map((s) => s.reason?.message).join(' | '));
});

test('Apple TV köprüsü: yardımcı açılır açılmaz çıkarsa ajan düşmez; art arda çökünce bir süre devre dışı', async () => {
  let saat = 1e12;
  let baslatma = 0;
  const k = new AppleTvKopru({
    python: 'python', betik: 'b.py', depo: 'd.conf', varMi: () => true, simdi: () => saat,
    spawnFn: (cmd, args, o) => { baslatma++; return spawn(process.execPath, ['-e', 'process.exit(3)'], o); },
  });
  const cihaz = { ip: '192.0.2.42', id: 'ORNEK000001' };
  for (let tur = 0; tur < 3; tur++) {
    const sonuc = await Promise.allSettled(Array.from({ length: 20 }, () => k.iste(cihaz, 'tus', { tus: 'up' }, 3000)));
    assert.ok(sonuc.every((s) => s.status === 'rejected'), 'her istek okunur hatayla döner');
    await bekle(20);
  }
  assert.equal(baslatma, 3);
  assert.equal(k.hazirMi(), false, '3 hızlı çöküşten sonra Apple TV kullanılmıyor (TV uygulamasına düşülür)');
  await assert.rejects(k.iste(cihaz, 'tus', { tus: 'up' }), (e) => e.kod === 503);
  assert.equal(baslatma, 3, 'bekleme sırasında yeniden başlatılmadı');
  saat += 11 * 60 * 1000;
  assert.equal(k.hazirMi(), true, 'bekleme bitince yeniden denenir');
});

// ───────────────────────────────────────────── Wake-on-LAN

function sahteUdp(hataKodu) {
  const s = new EventEmitter();
  s.gonderilen = [];
  s.bind = (port, cb) => setImmediate(cb);
  s.setBroadcast = () => {};
  s.send = (paket, port, adres, cb) => { s.gonderilen.push(`${adres}:${port}`); setImmediate(() => cb(hataKodu ? Object.assign(new Error(hataKodu), { code: hataKodu }) : null)); };
  s.close = () => {};
  return s;
}

test('WOL: hiçbir paket gönderilemezse hata (neden ile) — "TV ayarı" diye yanlış teşhis yok', async () => {
  await assert.rejects(wolGonder('00:00:5e:00:53:01', '192.0.2.40', { soketFn: () => sahteUdp('ENETUNREACH'), arayuzler: {}, araMs: 0 }), /gönderilemedi \(ENETUNREACH\)/);
  const s = sahteUdp(null);
  assert.deepEqual(await wolGonder('00:00:5e:00:53:01', '192.0.2.40', { soketFn: () => s, arayuzler: {}, araMs: 0 }), ['192.0.2.255', '255.255.255.255']);
  assert.equal(s.gonderilen.length, 12, '2 adres × 2 port × 3 tur');
});

// ───────────────────────────────────────────── rehber önbelleği

const sayfa = (n) => Array.from({ length: n }, (_, i) => `<div class="swiper-slide channelContent">
  <input type="hidden" id="channelID" name="channelID" value="DOLGU ${i}" />
  <div class="tvGuideResult-box-wholeDates channelDetail">
    <span class="tvGuideResult-box-wholeDates-time-hour">20:00</span>
    <span class="tvGuideResult-box-wholeDates-time-totalMinute">- 60dk</span>
    <span class="tvGuideResult-box-wholeDates-title" title="Program ${i}">Program ${i}</span>
  </div></div>`).join('');

test('rehber: aylarca çalışınca bellek ve disk önbelleği büyümez (bellek dün/bugün/yarın, disk 7 gün)', async () => {
  const dizin = mkdtempSync(join(tmpdir(), 'rehber-'));
  try {
    writeFileSync(join(dizin, 'zamanlayici.json'), '{}');   // aynı dizindeki başka dosyalara dokunulmaz
    let an = Date.UTC(2026, 0, 1, 9);
    const r = new Rehber({ dizin, fetchFn: async () => ({ ok: true, status: 200, text: async () => sayfa(12) }), simdi: () => an });
    for (let g = 0; g < 40; g++, an += 24 * 3600e3) await r.gun(trGunu(an));
    assert.ok(r.gunler.size <= 3, `bellekte ${r.gunler.size} gün`);
    const disk = readdirSync(dizin).filter((f) => f.startsWith('digiturk-'));
    assert.ok(disk.length <= 8, `diskte ${disk.length} gün`);
    assert.ok(readdirSync(dizin).includes('zamanlayici.json'));
  } finally { rmSync(dizin, { recursive: true, force: true }); }
});

// ───────────────────────────────────────────── zamanlayıcı görev yürütücüsü

function gorevTv({ acik = true, canli = true } = {}) {
  const olan = [];
  return {
    id: 'tv1', olan,
    hazirMi: async () => acik,
    canliMi: async () => canli,
    sirayla: (f) => f(),
    kanalAc: async (h) => { olan.push(['kanal', h.ad ?? h.no]); return { no: 3, ad: 'KANAL D HD', acildi: false }; },
    uyariGoster: async (s, ms) => { olan.push(['uyari', s, ms]); },
    bildirimGoster: async (m, sn) => { olan.push(['bildirim', m, sn]); },
    kapat: async () => { olan.push(['kapat']); },
    toast: async (m) => { olan.push(['toast', m]); },
  };
}

test('görev: "geri dön" TV canlı yayında değilse (uygulamaya/HDMI\'ya geçildi) atlanır, uyarı da gösterilmez', async () => {
  const tv = gorevTv({ canli: false });
  const y = gorevYurutucu({ tvBul: () => tv });
  const g = { tur: 'geri-don', tv: 'tv1', kanal: { no: 3, ad: 'KANAL D HD' }, tvKapaliysa: 'atla' };
  const r = await y.calistir(g);
  assert.equal(r.sonuc, 'atlandi');
  assert.match(r.neden, /canlı yayında değildi/);
  await y.uyar(g, 60);
  assert.deepEqual(tv.olan, []);
  const tek = await y.calistir({ ...g, tur: 'tek', tvKapaliysa: 'ac' });
  assert.equal(tek.sonuc, 'ok', 'program görevi uygulamadaki TV\'yi de kanala geçirir');
  const canli = gorevTv();
  assert.equal((await gorevYurutucu({ tvBul: () => canli }).calistir(g)).sonuc, 'ok');
});

test('görev: mesaj — TV kapalıysa atlanır; ortada uyarı penceresi; sonraKapat TV\'yi kapatır; kanal düzenlenirken atlanır', async () => {
  const kapali = gorevTv({ acik: false });
  assert.equal((await gorevYurutucu({ tvBul: () => kapali }).calistir({ tur: 'tek', tv: 'tv1', kanal: null, mesaj: { metin: 'x', sureSn: 5 } })).sonuc, 'atlandi');
  const tv = gorevTv();
  const y = gorevYurutucu({ tvBul: () => tv });
  await y.calistir({ tur: 'tek', tv: 'tv1', kanal: null, mesaj: { metin: 'Satır 1\nSatır 2', sureSn: 10, ortada: true, sonraKapat: true } });
  assert.deepEqual(tv.olan, [['uyari', ['Satır 1', 'Satır 2'], 10000], ['kapat']]);
  const mesgul = gorevYurutucu({ tvBul: () => tv, kanalSirasi: { mesgul: () => true } });
  assert.match((await mesgul.calistir({ tur: 'tek', tv: 'tv1', kanal: { ad: 'X' } })).neden, /kanal listesi/);
});

// ───────────────────────────────────────────── eşleştirme aracı

test('eslestir: eksik --dosya değeri TV\'ye bağlanmadan reddedilir (onaydan sonra anahtar kaybolmaz)', () => {
  const r = spawnSync(process.execPath, [join(KOK, 'eslestir.mjs'), '192.0.2.1', '--dosya'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--dosya bir yol ister/);
  assert.doesNotMatch(r.stdout, /bağlandı/);
  const b = spawnSync(process.execPath, [join(KOK, 'eslestir.mjs'), '192.0.2.1', '--bilinmeyen'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(b.status, 1);
  assert.match(b.stderr, /bilinmeyen seçenek/);
});
