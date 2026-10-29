/**
 * Küçük WebSocket istemcisi (RFC 6455) — sıfır bağımlılık.
 *
 * Neden Node'un yerleşik `WebSocket`'i kullanılmıyor:
 * LG TV'ler `wss://<ip>:3001` üzerinde KENDİ cihaz sertifikalarını sunuyor
 * ("LGE SSG Intermediate CA" tarafından imzalı, herkese açık bir CA zinciri yok
 * ve konak adı IP). Yerleşik WebSocket bu bağlantı için TLS doğrulamasını
 * gevşetme imkânı vermiyor; tek çare `NODE_TLS_REJECT_UNAUTHORIZED=0` ile
 * doğrulamayı TÜM süreç için kapatmak olurdu — bu fazla geniş bir taviz.
 *
 * Bunun yerine: zincir doğrulaması bu tek bağlantı için kapatılır, ama
 * sertifikanın gerçekten bir LG cihaz sertifikası olduğu ADI ÜZERİNDEN
 * DOĞRULANIR. Beklenmeyen bir sertifika görülürse bağlantı reddedilir.
 * (Yeni webOS modellerinde 3000/ws portu TCP'yi kabul edip HTTP isteğinde
 * bağlantıyı sıfırlıyor, bu yüzden önce 3001/wss denenir.)
 */

import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Tek çerçeve / birleştirilmiş ileti üst sınırı. TV'nin en büyük yanıtı (tam kanal listesi) birkaç MB. */
export const EN_BUYUK_CERCEVE = 16 * 1024 * 1024;

/** Sertifikanın LG cihaz sertifikası olduğunu adı üzerinden doğrular. */
export function looksLikeLgCertificate(cert) {
  if (!cert || !cert.subject) return false;
  const org = String(cert.subject.O || '');
  const cn = String(cert.subject.CN || '');
  return /LG Electronics/i.test(org) || /^LGE /i.test(cn);
}

export function describeCertificate(cert) {
  if (!cert || !cert.subject) return '(sertifika okunamadı)';
  const s = cert.subject;
  return `CN=${s.CN || '?'} O=${s.O || '?'}${cert.issuer?.CN ? ` · veren: ${cert.issuer.CN}` : ''}`;
}

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;

    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    // Dinleyicisiz 'error' olayı Node'da süreci düşürür (TV fişten çekilince RST/EPIPE). Hata ancak biri
    // dinliyorsa iletilir; ardından gelen 'close' bağlantıyı zaten kapalı işaretler, sonraki istek yeniden kurar.
    socket.on('error', (e) => { if (!this.closed && this.listenerCount('error')) this.emit('error', e); });
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      // Aşırı büyük çerçeve: 'data' olayı içinde hata atmak süreci düşürürdü — bağlantı kapatılır.
      if (frame.asiri) { this.buf = Buffer.alloc(0); this.fragments = []; this.close(); return; }
      this._handleFrame(frame);
      if (this.closed) return;
    }
  }

  /** Tamponda tam bir çerçeve varsa çözer; yoksa null döner. */
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(EN_BUYUK_CERCEVE)) return { asiri: true };
      len = Number(big);
    }
    if (len > EN_BUYUK_CERCEVE) return { asiri: true };
    // Sunucudan gelen çerçeveler maskesizdir; yine de tanımlı davranalım.
    let maskKey = null;
    if (masked) {
      if (b.length < off + 4) return null;
      maskKey = b.subarray(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;

    let payload = b.subarray(off, off + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { this.close(); return; }              // close
    if (opcode === 0x9) { this._send(0xa, payload); return; }  // ping → pong
    if (opcode === 0xa) return;                                // pong

    if (opcode === 0x0) {
      this.fragments.push(payload);
      if (this.fragments.reduce((n, p) => n + p.length, 0) > EN_BUYUK_CERCEVE) { this.fragments = []; this.close(); return; }
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }
    if (!fin) return;

    const full = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.emit('message', full.toString('utf8'));
    else this.emit('binary', full);
  }

  _send(opcode, payload) {
    if (this.closed) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
    const out = Buffer.alloc(head + 4 + len);
    out[0] = 0x80 | opcode;
    if (len < 126) out[1] = 0x80 | len;
    else if (len < 65536) { out[1] = 0x80 | 126; out.writeUInt16BE(len, 2); }
    else { out[1] = 0x80 | 127; out.writeBigUInt64BE(BigInt(len), 2); }
    mask.copy(out, head);
    for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
    this.socket.write(out);
  }

  send(text) { this._send(0x1, Buffer.from(String(text), 'utf8')); }

  close() {
    if (this.closed) return;
    try { this._send(0x8, Buffer.alloc(0)); } catch { /* yok say */ }
    try { this.socket.end(); } catch { /* yok say */ }
    // Bazı TV'ler kapanış çerçevesine karşılık vermiyor (SM8000 / webOS 4.5'te
    // ölçüldü): TCP yarı açık kalıyor ve Node süreci iş bittiği hâlde hiç çıkmıyor.
    // Kısa bir süre tanınır, sonra soket zorla kapatılır.
    const t = setTimeout(() => { try { this.socket.destroy(); } catch { /* yok say */ } }, 1000);
    t.unref();
    this._finish();
  }
}

/** Bir soket üzerinde WebSocket el sıkışmasını yapar. */
function handshake(socket, host, port, timeoutMs, path = '/') {
  return new Promise((ok, fail) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
    let buf = '';

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      fail(new Error('el sıkışma zaman aşımı'));
    }, timeoutMs);

    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16384) { cleanup(); socket.destroy(); fail(new Error('geçersiz el sıkışma yanıtı')); }
        return;
      }
      const header = buf.slice(0, end);
      const rest = Buffer.from(buf.slice(end + 4), 'latin1');
      cleanup();

      if (!/^HTTP\/1\.1 101/.test(header)) {
        socket.destroy();
        fail(new Error('sunucu yükseltmeyi reddetti: ' + header.split('\r\n')[0]));
        return;
      }
      const m = /sec-websocket-accept:\s*(\S+)/i.exec(header);
      if (!m || m[1] !== expect) {
        socket.destroy();
        fail(new Error('Sec-WebSocket-Accept doğrulanamadı'));
        return;
      }
      const conn = new WsConnection(socket);
      if (rest.length) conn._onData(rest);
      ok(conn);
    };

    const onErr = (e) => { cleanup(); fail(e); };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
    }

    socket.on('data', onData);
    socket.on('error', onErr);
    socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
    );
  });
}

/**
 * TLS üzerinden bağlanır (wss). Sertifika zinciri doğrulanmaz ama sertifikanın
 * bir LG cihaz sertifikası olduğu doğrulanır.
 * @returns {Promise<{conn: WsConnection, certificate: object}>}
 */
export function connectSecure(host, port = 3001, { timeoutMs = 8000, allowAnyCertificate = false, path = '/' } = {}) {
  return new Promise((ok, fail) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false, servername: undefined });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => { socket.destroy(); fail(new Error(`bağlantı zaman aşımı (wss://${host}:${port})`)); });
    socket.once('error', (e) => fail(e));
    socket.once('secureConnect', () => {
      socket.setTimeout(0);
      const cert = socket.getPeerCertificate();
      if (!allowAnyCertificate && !looksLikeLgCertificate(cert)) {
        socket.destroy();
        fail(new Error(
          `${host}:${port} adresindeki sertifika bir LG cihaz sertifikasına benzemiyor ` +
            `(${describeCertificate(cert)}). Bağlantı güvenlik gereği kesildi. ` +
            `Yine de denemek için --insecure kullan.`
        ));
        return;
      }
      handshake(socket, host, port, timeoutMs, path).then((conn) => ok({ conn, certificate: cert }), fail);
    });
  });
}

/**
 * Tam bir wss:// URL'ine bağlanır (yol dahil).
 * LG'nin kumanda giriş soketi kökte değil, `/resources/<hash>/netinput.pointer.sock`
 * gibi bir yolda durur — bu yüzden yol desteği şart.
 */
export function connectUrl(urlStr, opts = {}) {
  const u = new URL(urlStr);
  const port = u.port ? Number(u.port) : u.protocol === 'wss:' ? 3001 : 3000;
  const path = (u.pathname || '/') + (u.search || '');
  if (u.protocol === 'wss:') return connectSecure(u.hostname, port, { ...opts, path });
  return connectPlain(u.hostname, port, { ...opts, path });
}

/** Düz ws bağlantısı (eski modeller, port 3000). */
export function connectPlain(host, port = 3000, { timeoutMs = 8000, path = '/' } = {}) {
  return new Promise((ok, fail) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => { socket.destroy(); fail(new Error(`bağlantı zaman aşımı (ws://${host}:${port})`)); });
    socket.once('error', (e) => fail(e));
    socket.once('connect', () => {
      socket.setTimeout(0);
      handshake(socket, host, port, timeoutMs, path).then((conn) => ok({ conn, certificate: null }), fail);
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Önce wss:3001, olmazsa (yalnız `duzIzin` açıksa) ws:3000 dener; her ikisi de artan beklemeyle
 * yeniden denenir.
 *
 * Düz ws'ye düşmek güvenlik tavizidir: eşleşme anahtarı (ekran onayı olmadan TV'yi tam kumanda) ağda
 * açık metin gider; wss el sıkışması geciken ya da sertifikası tutmayan bir bağlantı da sessizce
 * düz bağlantıya dönerdi. Varsayılan izinli (eski modeller ve elle kullanılan araçlar için); uzun
 * ömürlü ajan kapatır (bkz. tv-ajan.mjs → TV_AJAN_DUZ_WS).
 *
 * Neden yeniden deneme şart: TV eşzamanlı SSAP oturumu sayısını sınırlıyor ve
 * bir önceki bağlantının kapanışı cihaz tarafında birkaç saniye sürebiliyor.
 * Bu aralıkta yeni bağlantı sessizce zaman aşımına düşüyor — gerçek cihazda
 * (OLED G5) art arda çalıştırmalarda tekrar tekrar gözlendi. Tek denemede
 * pes etmek kullanıcıya "TV kapalı" gibi yanlış bir teşhis verir.
 */
export async function connectAuto(host, opts = {}) {
  const { retries = 3, retryDelayMs = 1500, duzIzin = true } = opts;
  let errors = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    errors = [];
    try {
      const r = await connectSecure(host, 3001, opts);
      return { ...r, url: `wss://${host}:3001`, deneme: attempt + 1 };
    } catch (e) {
      errors.push(`wss://${host}:3001 → ${e.message}`);
    }
    if (duzIzin) {
      try {
        const r = await connectPlain(host, 3000, opts);
        return { ...r, url: `ws://${host}:3000`, deneme: attempt + 1 };
      } catch (e) {
        errors.push(`ws://${host}:3000 → ${e.message}`);
      }
    }
    if (attempt < retries) await wait(retryDelayMs * (attempt + 1));
  }
  throw new Error(
    `Bağlanılamadı (${retries + 1} deneme).\n  ` + errors.join('\n  ') +
      '\n  TV açık ve aynı ağda mı? Bir önceki bağlantı kapanıyorsa birkaç saniye sonra tekrar dene.'
  );
}
