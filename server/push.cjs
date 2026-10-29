'use strict';
// ── Web Push: kumandanın bildirimleri (planlı yayın başladı, reklam bitti, görev yapılamadı, engel, kilit) ──
//
// Abonelikler küçük bir JSON dosyasında: <veri dizini>/abonelikler.json (git dışı). Veri dizini KUMANDA_VERI
// (örnek systemd birimi: /var/lib/lg-remote), yoksa deponun data/ klasörü. VAPID anahtarları ortamdan:
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   üretmek:  npx web-push generate-vapid-keys
//   VAPID_SUBJECT                          mailto: ya da https: adresi (push servisleri ister)
// Anahtar yoksa bildirim kapalıdır (anahtar() boş döner, kumanda düğmeyi "ayarlı değil" diye gösterir).
// Ölü abonelikler (404/410) gönderimde silinir. 403 silinmez: çoğunlukla sunucu tarafı yetki hatasıdır
// (VAPID anahtarı/konusu değişti, sunucu saati kaydı) — silmek düzelince geri gelmeyen sessiz veri kaybı olurdu.

const fs = require('fs');
const path = require('path');

const veriDizini = () => process.env.KUMANDA_VERI || path.join(__dirname, '..', 'data');

function olustur({
  dosya = path.join(veriDizini(), 'abonelikler.json'),
  publicKey = process.env.VAPID_PUBLIC_KEY || '',
  privateKey = process.env.VAPID_PRIVATE_KEY || '',
  subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  webpush = null,
  log = console.log,
  enCok = 50,              // abonelik sayısı sınırı: dolunca en eskisi düşer
  zamanAsimiMs = 10000,    // push servisi yanıtsız kalırsa bekleme (yoksa sonuç izleyici kalıcı takılırdı)
  simdi = Date.now,
} = {}) {
  const hazir = !!(publicKey && privateKey);
  let wp = webpush;
  if (hazir && !wp) {
    wp = require('web-push');
    wp.setVapidDetails(subject, publicKey, privateKey);
  }

  // Okunamayan dosya boş liste SAYILMAZ (yoksa sonraki ekle() eski abonelikleri iz bırakmadan silerdi):
  // dosya yoksa boş; okunamıyorsa hata; bozuksa kenara alınır, günlüğe yazılır ve boş listeyle devam edilir.
  const oku = () => {
    let ham;
    try { ham = fs.readFileSync(dosya, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') return [];
      log(`[bildirim] ⚠️ abonelik dosyası okunamadı: ${e.code || e.message}`);
      throw e;
    }
    try { const j = JSON.parse(ham); if (Array.isArray(j)) return j; } catch { /* aşağıda */ }
    const yedek = `${dosya}.bozuk-${simdi()}`;
    try {
      fs.renameSync(dosya, yedek);
      log(`[bildirim] ⚠️ abonelik dosyası bozuk — ${path.basename(yedek)} olarak kenara alındı, boş listeyle devam`);
    } catch (e) {
      log(`[bildirim] ⚠️ abonelik dosyası bozuk ve kenara alınamadı: ${e.code || e.message}`);
    }
    return [];
  };
  const yaz = (liste) => {
    fs.mkdirSync(path.dirname(dosya), { recursive: true });
    fs.writeFileSync(dosya + '.tmp', JSON.stringify(liste, null, 1), { mode: 0o600 });
    fs.renameSync(dosya + '.tmp', dosya);
  };
  const sil = (endpoint) => yaz(oku().filter((x) => x.endpoint !== endpoint));

  async function gonder(s, govde) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: s.keys }, govde, { TTL: 3600, urgency: 'high', timeout: zamanAsimiMs });
      return 'ok';
    } catch (e) {
      const kod = e.statusCode || e.status;
      if (kod === 404 || kod === 410) {
        try { sil(s.endpoint); } catch (h) { log(`[bildirim] ölü abonelik silinemedi: ${h.code || h.message}`); }
        return 'silindi';
      }
      if (kod === 403) log('[bildirim] 403 — VAPID anahtarı/konusu ya da sunucu saati uyuşmuyor olabilir; abonelik silinmedi');
      else log(`[bildirim] gönderim hatası (${kod || '?'}): ${e.message}`);
      return 'hata';
    }
  }

  return {
    anahtar: () => (hazir ? publicKey : ''),
    ekle(sub) {
      const liste = oku().filter((x) => x.endpoint !== sub.endpoint);
      liste.push({ endpoint: sub.endpoint, keys: sub.keys, eklendi: simdi() });
      while (liste.length > enCok) liste.shift();
      yaz(liste);
    },
    sil,
    varMi: (endpoint) => oku().some((x) => x.endpoint === endpoint),
    async dene(endpoint) {
      if (!hazir) return 'not-configured';
      const s = oku().find((x) => x.endpoint === endpoint);
      if (!s) return 'yok';
      return gonder(s, JSON.stringify({ title: '🔔 Bildirimler açık', body: 'Planlı yayın başlayınca ve reklam bitince buraya bildirim gelecek.', tag: 'kumanda-deneme' }));
    },
    /** Herkese gönderir; sonuç izleyici ve kaba kuvvet kilidi kullanır. */
    async herkese(baslik, mesaj, tag = 'kumanda') {
      if (!hazir) return { gonderilen: 0 };
      const govde = JSON.stringify({ title: baslik, body: mesaj, tag });
      const sonuc = await Promise.all(oku().map((s) => gonder(s, govde)));
      return { gonderilen: sonuc.filter((x) => x === 'ok').length };
    },
  };
}

module.exports = { olustur, veriDizini };
