/**
 * LG webOS — ekran görüntüsü.
 *
 * `ssap://tv/executeOneShot` TV'nin o anki ekranını (video + ARAYÜZ katmanı
 * birlikte) 960×540 JPEG olarak verir. Gerçek cihazda ölçüldü: OLED G5,
 * webOS 26 — ekrandaki bildirim balonu görüntüde çıktı.
 *
 * Ağdan yazmanın eksik parçası buydu: kumanda kanalı tuş gönderebiliyordu ama
 * menünün nerede olduğu görülemiyordu. Bununla döngü kapanıyor:
 * tuş gönder → ekranı gör → `getChannelList` ile doğrula.
 */

import https from 'node:https';
import { looksLikeLgCertificate } from '../ws-client.mjs';

/** Görüntü adresinden JPEG'i indirir; sunucunun LG cihaz sertifikası sunduğunu doğrular. */
function fetchImage(uri, { timeoutMs = 8000, allowAnyCertificate = false } = {}) {
  return new Promise((ok, fail) => {
    // `agent: false`: her indirme yeni TLS bağlantısı. Uzun ömürlü süreçte (tv-ajan) Node'un
    // ortak ajanı bağlantıyı/oturumu yeniden kullanıyor ve devam ettirilen TLS oturumunda
    // `getPeerCertificate()` boş dönüyor — sertifika denetimi ikinci görüntüden itibaren
    // haksız yere reddediyordu (ölçüldü).
    const req = https.get(uri, { rejectUnauthorized: false, timeout: timeoutMs, agent: false }, (res) => {
      const cert = res.socket.getPeerCertificate?.();
      if (!allowAnyCertificate && !looksLikeLgCertificate(cert)) {
        res.destroy();
        fail(new Error('Ekran görüntüsü sunucusu LG cihaz sertifikası sunmadı.'));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`Ekran görüntüsü alınamadı (HTTP ${res.statusCode})`));
        return;
      }
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => ok(Buffer.concat(parts)));
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('ekran görüntüsü zaman aşımı')));
    req.on('error', fail);
  });
}

/**
 * @param {LgSsap} ssap eşleşmiş oturum
 * @returns {Promise<Buffer>} JPEG
 */
export async function captureScreen(ssap, opts = {}) {
  const r = await ssap.request('ssap://tv/executeOneShot');
  if (!r?.imageUri) throw new Error('TV ekran görüntüsü adresi vermedi.');
  // Adres TV'nin kendisini göstermeli; başka bir konağa istek atmayız.
  if (new URL(r.imageUri).hostname !== ssap.ip) throw new Error('Ekran görüntüsü adresi TV\'nin kendi adresi değil.');
  const buf = await fetchImage(r.imageUri, opts);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('Gelen veri JPEG değil.');
  return buf;
}
