/**
 * LG webOS — SSAP (Simple Service Access Protocol) istemcisi.
 *
 * Gerçek cihazda doğrulandı: LG OLED G5 (webOS 25).
 * Bağlantı wss://<ip>:3001 üzerinden; TV kendi cihaz sertifikasını sunar.
 *
 * BU MODÜL HİÇBİR ŞEY YAZMAZ. SSAP'ta kanal listesini değiştiren bir uç yok;
 * yoklama sonucu (aynı cihazda): getFavoriteChannelList, getChannelGroupList,
 * getSkipChannelList, getBlockChannelList → hiçbiri mevcut değil. Var olanlar
 * yalnız okuma ve kanal değiştirme.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import { connectAuto, describeCertificate } from '../ws-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDSHAKE = JSON.parse(readFileSync(resolve(HERE, '../ssap-handshake.json'), 'utf8'));

export const READ_ENDPOINTS = {
  channelList: 'ssap://tv/getChannelList',
  currentChannel: 'ssap://tv/getCurrentChannel',
  systemInfo: 'ssap://system/getSystemInfo',
  swInfo: 'ssap://com.webos.service.update/getCurrentSWInformation',
};

/**
 * İmzasız eşleştirme manifesti.
 *
 * webOS 26 (firmware 43.x, Ağustos 2026) LG'nin eski "test-signing-cert"
 * imzasını kara listeye aldı; imzalı manifest `403 Pairing rejected:
 * blacklisted certificate detected` ile reddediliyor. Çare: `signed` ve
 * `signatures` bloklarını atıp imzalı izinleri üst listeye katmak. Eski
 * modeller imzalı manifesti kabul etmeye devam ettiği için bu yalnız o hatada
 * denenir (bkz. `register`).
 */
export function unsignedHandshake() {
  const payload = structuredClone(HANDSHAKE);
  const m = payload.manifest;
  m.permissions = [...new Set([...(m.permissions || []), ...(m.signed?.permissions || [])])];
  delete m.signed;
  delete m.signatures;
  return payload;
}

const BLACKLISTED = /blacklisted certificate/i;

/** Hepsi "get" — cihazda hiçbir şey değiştirmez. Yazan uç bilerek yok. */
export const PROBE_ENDPOINTS = [
  'ssap://tv/getChannelProgramInfo',
  'ssap://tv/getChannelCurrentProgramInfo',
  'ssap://tv/getFavoriteChannelList',
  'ssap://tv/getChannelGroupList',
  'ssap://tv/getSkipChannelList',
  'ssap://tv/getBlockChannelList',
  'ssap://tv/getSatelliteSettings',
  'ssap://tv/getTunerInfo',
  'ssap://tv/getChannelScanStatus',
  'ssap://settings/getSystemSettings',
];

/** SSDP ile ağdaki LG TV'leri arar. */
export function discover(timeoutMs = 4000) {
  const MSG = Buffer.from(
    [
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: urn:lge-com:service:webos-second-screen:1',
      '',
      '',
    ].join('\r\n')
  );
  return new Promise((done) => {
    const found = new Map();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf, rinfo) => {
      const txt = buf.toString();
      if (/webos|LG/i.test(txt)) {
        const loc = /location:\s*(\S+)/i.exec(txt);
        found.set(rinfo.address, { ip: rinfo.address, marka: 'lg', konum: loc ? loc[1] : null });
      }
    });
    sock.on('error', () => {});
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(MSG, 1900, '239.255.255.250');
    });
    setTimeout(() => {
      try { sock.close(); } catch { /* yok say */ }
      done([...found.values()]);
    }, timeoutMs);
  });
}

export class LgSsap {
  constructor(ip) {
    this.ip = ip;
    this.seq = 0;
    this.pending = new Map();
    this.ws = null;
  }

  /**
   * `retries`: kapalı TV'de yeniden deneme sayısı (varsayılan connectAuto'nunki — 3).
   * `duzIzin`: wss:3001 olmazsa düz ws:3000'e düşülsün mü (eşleşme anahtarı o zaman ağda AÇIK METİN gider;
   * bkz. ws-client.mjs → connectAuto). Varsayılan connectAuto'nunki (izinli); ajan kapatır.
   */
  async connect({ timeoutMs = 8000, allowAnyCertificate = false, retries, duzIzin } = {}) {
    this._connectOpts = { timeoutMs, allowAnyCertificate, retries, duzIzin };
    const { conn, certificate, url } = await connectAuto(this.ip, { timeoutMs, allowAnyCertificate, ...(retries != null ? { retries } : {}), ...(duzIzin != null ? { duzIzin } : {}) });
    this.ws = conn;
    this.url = url;
    this.certificate = certificate;
    conn.on('message', (d) => this._onMessage(d));
    conn.on('close', () => {
      for (const { fail } of this.pending.values()) fail(new Error('Bağlantı kapandı'));
      this.pending.clear();
    });
    conn.on('error', () => { /* kapanış bekleyenleri zaten düşürüyor */ });
    return { url, certificate, certificateText: certificate ? describeCertificate(certificate) : null };
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const w = this.pending.get(msg.id);
    if (!w) return;
    if (msg.type === 'error') {
      this.pending.delete(msg.id);
      w.fail(new Error(msg.error || 'bilinmeyen hata'));
      return;
    }
    if (w.until && msg.type !== w.until) return;
    this.pending.delete(msg.id);
    w.ok(msg.payload ?? {});
  }

  _send(obj, { until, timeoutMs = 15000 } = {}) {
    const id = obj.id || `req_${++this.seq}`;
    obj.id = id;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error('yanıt gelmedi (zaman aşımı)'));
      }, timeoutMs);
      this.pending.set(id, {
        until,
        ok: (v) => { clearTimeout(timer); ok(v); },
        fail: (e) => { clearTimeout(timer); fail(e); },
      });
      this.ws.send(JSON.stringify(obj));
    });
  }

  /**
   * @param clientKey önceden alınmış anahtar; yoksa TV ekranında onay istenir.
   * `this.manifest` hangi manifestle eşleşildiğini söyler ('imzali' | 'imzasiz').
   */
  async register(clientKey, opts = {}) {
    try {
      return await this._register(clientKey, opts);
    } catch (e) {
      // Beklemedeki TV 3001'i açık tutar, eşleşme mesajını alıp yanıtsız kapatır (ölçüldü). "Bağlantı kapandı"
      // tek başına neden söylemiyor.
      if (e.message !== 'Bağlantı kapandı') throw e;
      const h = new Error(`${this.ip}: TV eşleşmeyi yanıtsız kapattı — büyük olasılıkla beklemede (ekran kapalı). `
        + 'Önce TV\'yi aç: kumandayla, kumanda arayüzünden ya da Wake-on-LAN ile (net/wol.mjs → wolGonder).');
      h.kod = 'beklemede';
      h.cause = e;
      throw h;
    }
  }

  async _register(clientKey, { timeoutMs = 90000, onFallback = () => {} } = {}) {
    const attempt = (payload) => {
      if (clientKey) payload['client-key'] = clientKey;
      return this._send({ type: 'register', payload }, { until: 'registered', timeoutMs });
    };
    try {
      const res = await attempt(structuredClone(HANDSHAKE));
      this.manifest = 'imzali';
      return res['client-key'];
    } catch (e) {
      if (!BLACKLISTED.test(String(e.message || e))) throw e;
      onFallback();
      if (!this.ws || this.ws.closed) await this.connect(this._connectOpts);
      const res = await attempt(unsignedHandshake());
      this.manifest = 'imzasiz';
      return res['client-key'];
    }
  }

  request(uri, payload, { timeoutMs } = {}) {
    return this._send({ type: 'request', uri, ...(payload ? { payload } : {}) }, timeoutMs ? { timeoutMs } : {});
  }

  close() { try { this.ws?.close(); } catch { /* yok say */ } }
}

/**
 * Ham kanal kaydını sade biçime çevirir. Alan adları modele göre değişebildiği
 * için birden çok aday denenir; hiçbiri tutmazsa alan null kalır ve ham kayıt
 * `_raw` içinde saklanır (passthrough ilkesi).
 */
export function normalizeChannel(c, idx) {
  const pick = (...names) => {
    for (const n of names) if (c[n] !== undefined && c[n] !== null && c[n] !== '') return c[n];
    return null;
  };
  const num = (v) => (v === null ? null : Number(v));
  const isRadio = c.Radio === true || /radio/i.test(String(c.channelType || ''));
  return {
    idx,
    channelId: pick('channelId', 'channelID'),
    number: num(pick('majorNumber', 'channelNumber', 'displayChannelNumber')),
    majorNumber: num(pick('majorNumber')),
    minorNumber: num(pick('minorNumber')),
    name: pick('channelName', 'channelNameAlias'),
    type: pick('channelType', 'channelTypeName'),
    isRadio,
    physicalNumber: num(pick('physicalNumber')),
    frequency: num(pick('Frequency', 'frequency')),
    satelliteName: pick('satelliteName'),
    SVCID: num(pick('SVCID', 'serviceId', 'programNum')),
    TSID: num(pick('TSID', 'transportStreamId')),
    ONID: num(pick('ONID', 'originalNetworkId')),
    scrambled: c.scrambled === true,
    skipped: c.skipped === true,
    locked: c.locked === true,
    invisible: c.Invisible === true,
    serviceType: num(pick('serviceType')),
    _raw: c,
  };
}

export function fieldCoverage(rows) {
  const keys = ['SVCID', 'TSID', 'ONID', 'frequency', 'majorNumber', 'minorNumber', 'physicalNumber', 'satelliteName'];
  const out = {};
  for (const k of keys) out[k] = rows.filter((r) => r[k] !== null && r[k] !== undefined).length;
  return out;
}

/**
 * Tek çağrıda: bağlan → eşleş → oku.
 * @returns {{sonuc: object, clientKey: string}}
 */
export async function readTv(ip, { clientKey = null, probe = false, allowAnyCertificate = false, onStatus = () => {} } = {}) {
  const tv = new LgSsap(ip);
  onStatus({ asama: 'baglaniyor', ip });
  const info = await tv.connect({ allowAnyCertificate });
  onStatus({ asama: 'baglandi', url: info.url, sertifika: info.certificateText });

  if (!clientKey) onStatus({ asama: 'onay-bekleniyor' });
  const newKey = await tv.register(clientKey, { onFallback: () => onStatus({ asama: 'imzasiz-manifest' }) });
  onStatus({ asama: 'eslesti', manifest: tv.manifest });

  const sonuc = {
    tv: ip,
    marka: 'lg',
    okunmaZamani: new Date().toISOString(),
    kaynak: 'ssap',
    baglanti: { url: info.url, sertifika: info.certificateText },
  };

  for (const [key, uri] of Object.entries(READ_ENDPOINTS)) {
    try {
      sonuc[key] = await tv.request(uri);
      onStatus({ asama: 'uc-ok', uri });
    } catch (e) {
      sonuc[key] = { _hata: String(e.message || e) };
      onStatus({ asama: 'uc-hata', uri, hata: String(e.message || e) });
    }
  }

  const raw = sonuc.channelList?.channelList || sonuc.channelList?.channels || [];
  sonuc.kanallar = raw.map((c, i) => normalizeChannel(c, i));
  sonuc.alanKapsami = fieldCoverage(sonuc.kanallar);
  sonuc.model = sonuc.systemInfo?.modelName || sonuc.swInfo?.model_name || null;
  sonuc.firmware = sonuc.swInfo?.major_ver ? `${sonuc.swInfo.major_ver}.${sonuc.swInfo.minor_ver}` : null;

  if (probe) {
    sonuc.kesif = {};
    for (const uri of PROBE_ENDPOINTS) {
      try {
        sonuc.kesif[uri] = { var: true, ornek: await tv.request(uri) };
      } catch (e) {
        sonuc.kesif[uri] = { var: false, hata: String(e.message || e) };
      }
    }
  }

  tv.close();
  return { sonuc, clientKey: newKey || clientKey };
}
