/* Engeller ve kilit (/engel) — YouTube engel kuralları ve TV kilidi evdeki ajanda; bu sayfa listeler, ekler, siler.
   Kanal · kelime · video ayrı bölümlerde. TV'de görünen metinler (kilit mesajı, engel mesajı ve uyarısı) buradan
   değiştirilir. Ad ve başlıklar dış veridir (YouTube'dan): yalnız textContent ile basılır. Saatler kumandanın saat
   diliminde (saat.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const L = window.L || ((m, d) => (typeof m !== 'string' ? m : (d ? m.replace(/\|[^|]*$/, '').replace(/\{(\w+)\}/g, (h, a) => (a in d ? String(d[a]) : h)) : m.replace(/\|[^|]*$/, ''))));
  const Saat = window.Saat;
  const YEREL = window.i18n && window.i18n.dil() === 'en' ? 'en-GB' : 'tr-TR';
  const el = (etiket, sinif, metin) => { const e = document.createElement(etiket); if (sinif) e.className = sinif; if (metin != null) e.textContent = metin; return e; };
  const iki = (n) => String(n).padStart(2, '0');
  const sure = (ms) => {
    const dk = Math.round(ms / 60000);
    if (dk < 1) return ms > 0 ? L('<1 dk') : L('0 dk');
    const s = Math.floor(dk / 60);
    return s ? L('{s} sa {d} dk', { s, d: iki(dk % 60) }) : L('{d} dk', { d: dk });
  };
  const trGun = (ms) => Saat.gun(ms);
  const saatYaz = (ms) => Saat.saat(ms);
  /** Bugünse yalnız saat, değilse "18 Eki 21:05". */
  const zamanYaz = (ms) => {
    const g = trGun(ms);
    return `${g === trGun(Date.now()) ? '' : `${Saat.tarihYaz(g, { day: 'numeric', month: 'short' }, YEREL)} `}${saatYaz(ms)}`;
  };

  const S = { tur: '', veri: null, kilit: null, secim: {}, kilitTv: null, izlenenYuklendi: false, tvAdlari: {} };   // secim: tv → { dk, kapsam }
  const tvAdi = (id) => S.tvAdlari[id] || id;

  let toastT;
  function toast(m, hata = false) { const t = $('toast'); t.textContent = m; t.className = `toast show${hata ? ' error' : ''}`; clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 4000); }

  // ── Modal (kilit onayı · engelleme seçenekleri) ──────────────────────────
  function modalAc({ baslik, govde, dugmeler }) {
    $('modalBaslik').textContent = baslik;
    const g = $('modalGovde');
    g.replaceChildren(typeof govde === 'string' ? document.createTextNode(govde) : govde);
    const d = $('modalDugmeler');
    d.replaceChildren();
    for (const btn of dugmeler || []) {
      const b = el('button', `modal-dugme${btn.sinif ? ` ${btn.sinif}` : ''}`, btn.ad);
      b.type = 'button';
      b.addEventListener('click', () => { if (btn.kapat !== false) modalKapat(); if (btn.islev) btn.islev(); });
      d.append(b);
    }
    $('modal').hidden = false;
    const ilk = d.querySelector('button');
    if (ilk) ilk.focus();
  }
  function modalKapat() { $('modal').hidden = true; }
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) modalKapat(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) modalKapat(); });
  const ozetSatir = (et, dg) => { const s = el('div', 'satir'); s.append(el('span', 'et', et), el('span', 'dg', dg)); return s; };

  // "Başlık (Kanal)" → [başlık, kanal]; parantez yoksa yalnız başlık (izleme.js ile aynı).
  const ytAyir = (program) => { const m = /^(.*\S) \(([^()]+)\)$/.exec(program || ''); return m ? [m[1], m[2]] : [program || '']; };
  // Video adı tıklanabilir: kimlik varsa doğrudan video, yoksa başlık + kanal ile YouTube araması
  // (Apple TV video kimliği vermiyor; engellenen olaylarda da kimlik yok).
  const ytKimlikMi = (id) => !!id && /^[A-Za-z0-9_-]{11}$/.test(id);
  function ytAdBaglantisi(baslik, { id = null, kanal = null } = {}) {
    const a = el('a', 'yt-ad', baslik || L('video'));
    a.href = ytKimlikMi(id) ? `https://www.youtube.com/watch?v=${id}` : `https://www.youtube.com/results?search_query=${encodeURIComponent([baslik, kanal].filter(Boolean).join(' '))}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = ytKimlikMi(id) ? L("Videoyu YouTube'da aç") : L("YouTube'da ara");
    return a;
  }
  const SURELER = [[L('30 dk'), 30], [L('1 saat'), 60], [L('2 saat'), 120], [L("07:00'e kadar"), 'sabah'], [L('Süresiz'), null]];
  /** "Sabaha kadar": kumandanın saat dilimiyle bir sonraki 07:00'ye kalan dakika. */
  const sabahaDk = () => {
    const t = Saat.parca(Date.now());
    let dk = (7 * 60) - (t.sa * 60 + t.dk);
    if (dk <= 0) dk += 1440;
    return dk;
  };
  const IPUCU = {
    '': L('Video linki → o video · kanal linki (youtube.com/@…) → o kanal · düz yazı → anahtar kelime.'),
    kanal: L('Kanal linki, kanalın adı ya da kanaldan bir VİDEO linki (o videonun kanalı engellenir).'),
    kelime: L('Video başlığında ya da kanal adında geçen sözcük ("dino" → "Dinozorlar…" da engellenir).'),
  };

  async function istek(yol, secenek = {}) {
    const r = await fetch(`/api/tv${yol}`, { cache: 'no-store', ...secenek, headers: { 'Content-Type': 'application/json', ...(secenek.headers || {}) } });
    if (r.status === 401) { location.href = '/login'; throw new Error(L('giriş gerekli')); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? L(String(j.error)) : `HTTP ${r.status}`);
    return j;
  }

  // ── TV'de görünen çok satırlı metinler ──────────────────────────────────
  // Ajan en çok 5 satır gösterir (satır başına 80 karakter); aradaki boş satır ayırıcıdır ve korunur. Satır
  // başı boşlukları atılır (TV'nin uyarı penceresi onları zaten siliyor), baştaki/sondaki boş satırlar da.
  const EN_COK_SATIR = 5;
  const SATIR_UZUNLUGU = 80;
  function satirlar(kutu) {
    const s = kutu.value.split('\n').map((x) => x.trim());
    while (s.length && !s[0]) s.shift();
    while (s.length && !s[s.length - 1]) s.pop();
    return s;
  }
  /** Kutudaki metni doğrular; sorun varsa uyarıp null döner. Boş kutu [] verir: ajan varsayılan metne döner. */
  function metinAl(kutu) {
    const s = satirlar(kutu);
    if (s.length > EN_COK_SATIR) { toast(L('En çok {n} satır', { n: EN_COK_SATIR }), true); return null; }
    if (s.some((x) => x.length > SATIR_UZUNLUGU)) { toast(L('Satır başına en çok {n} karakter', { n: SATIR_UZUNLUGU }), true); return null; }
    return s;
  }
  // 30 sn'lik tazeleme, kaydedilmemiş düzenlemeyi ezmesin: kutu düzenlendiyse (kirli) ya da odaktaysa yazılmaz.
  const kutuyaYaz = (kutu, liste) => { if (document.activeElement !== kutu && !kutu.dataset.kirli && Array.isArray(liste)) kutu.value = liste.join('\n'); };
  const temizle = (...kutular) => { for (const k of kutular) delete k.dataset.kirli; };
  for (const id of ['kilitMesaj', 'engelMesaj', 'engelUyari']) $(id).addEventListener('input', (e) => { e.target.dataset.kirli = '1'; });

  function silDugmesi(kural, ne) {
    const b = el('button', 'sil', '✕');
    b.type = 'button';
    b.setAttribute('aria-label', L('{ne} engelini kaldır', { ne }));
    b.addEventListener('click', async () => {
      if (!confirm(L('"{ne}" engeli kaldırılsın mı?', { ne }))) return;
      b.disabled = true;
      try { S.veri = await istek(`/engel/${kural.id}`, { method: 'DELETE' }); ciz(); toast(L('Engel kaldırıldı')); } catch (e) { b.disabled = false; toast(L('Kaldırılamadı · {hata}', { hata: e.message }), true); }
    });
    return b;
  }

  function baglanti(href, metin) {
    const a = el('a', null, metin);
    a.href = /^https:\/\//.test(String(href || '')) ? href : '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function ciz() {
    const v = { acik: false, kurallar: [], olaylar: [], ...(S.veri || {}) };
    const kurallar = Array.isArray(v.kurallar) ? v.kurallar : [];
    const olaylar = Array.isArray(v.olaylar) ? v.olaylar : [];
    $('acikDugme').setAttribute('aria-checked', String(!!v.acik));
    $('durumMetni').textContent = v.acik ? L("Açık — {n} kural bütün TV'lerde geçerli", { n: kurallar.length }) : L('KAPALI — kurallar duruyor ama uygulanmıyor');
    kutuyaYaz($('engelMesaj'), v.mesaj);
    kutuyaYaz($('engelUyari'), v.uyari);

    const kanallar = kurallar.filter((k) => k.tur === 'kanal');
    const kelimeler = kurallar.filter((k) => k.tur === 'kelime');
    const videolar = kurallar.filter((k) => k.tur === 'video');
    $('kanalSayi').textContent = kanallar.length;
    $('kelimeSayi').textContent = kelimeler.length;
    $('videoSayi').textContent = videolar.length;

    const kl = $('kanalListe');
    kl.replaceChildren();
    if (!kanallar.length) kl.append(el('div', 'bos', L('Engelli kanal yok.')));
    for (const k of kanallar) {
      const s = el('div', 'kural');
      const ne = el('div', 'ne');
      ne.append(el('b', null, k.deger));
      const alt = el('small');
      if (k.link) alt.append(baglanti(k.link, String(k.link).replace(/^https:\/\/www\.youtube\.com\//, 'youtube.com/')));
      if (k.ornek) alt.append(document.createTextNode(`${k.link ? ' · ' : ''}${L('örnek: {ornek}', { ornek: k.ornek })}`));
      if (alt.childNodes.length) ne.append(alt);
      s.append(ne, silDugmesi(k, k.deger));
      kl.append(s);
    }

    const wl = $('kelimeListe');
    wl.replaceChildren();
    if (!kelimeler.length) wl.append(el('div', 'bos', L('Engelli kelime yok.')));
    for (const k of kelimeler) {
      const c = el('span', 'kelime');
      c.append(el('span', null, k.deger), silDugmesi(k, k.deger));
      wl.append(c);
    }

    const vl = $('videoListe');
    vl.replaceChildren();
    if (!videolar.length) vl.append(el('div', 'bos', L('Tek tek engellenmiş video yok.')));
    for (const k of videolar) {
      const s = el('div', 'kural');
      const ne = el('div', 'ne');
      ne.append(el('b', null, k.baslik || k.videoId));
      const alt = el('small');
      if (k.kanal) alt.append(document.createTextNode(`${k.kanal} · `));
      alt.append(baglanti(k.link || (ytKimlikMi(k.videoId) ? `https://www.youtube.com/watch?v=${k.videoId}` : ''), L("YouTube'da aç")));
      ne.append(alt);
      s.append(ne, silDugmesi(k, k.baslik || k.videoId));
      vl.append(s);
    }

    const ol = $('olayListe');
    ol.replaceChildren();
    if (!olaylar.length) ol.append(el('div', 'bos', L('Henüz engellenen bir şey olmadı.')));
    for (const o of olaylar.slice(0, 30)) {
      const s = el('div', 'olay');
      s.append(el('div', 'zaman', zamanYaz(o.zaman)));
      const ne = el('div');
      ne.append(ytAdBaglantisi(o.baslik, { kanal: o.kanal }));
      const kural = o.kural ? ({ kanal: L('kanal: {deger}', { deger: o.kural.deger }), kelime: L('kelime: {deger}', { deger: o.kural.deger }), video: L('listedeki video') }[o.kural.tur] || '') : '';
      ne.append(el('small', null, [tvAdi(o.tv), o.kanal, kural].filter(Boolean).join(' · ')));
      s.append(ne);
      ol.append(s);
    }
    islemCiz();
  }

  // ── İşlem kaydı: kilit olayları + engel değişiklikleri, en yeniden eskiye ──
  // Kaynak: ajan geçitten gelen isteği (X-Istemci: panel) "panel", doğrudan komutla yapılanı "dogrudan" yazar.
  const KAYNAK = { panel: L('kumandadan'), dogrudan: L('komutla') };
  const kapsamMetni = (kapsam) => (kapsam === 'tv' ? L('Yalnız TV') : L('TV + Apple TV'));
  function islemCiz() {
    const kap = $('islemListe');
    kap.replaceChildren();
    const satirlarListe = [];
    for (const o of (S.kilit && S.kilit.olaylar) || []) {
      const d = { tv: tvAdi(o.tv) };
      const ne = {
        kilitlendi: `🔒 ${L('{tv} kilitlendi ({sure}, {kapsam})', { ...d, sure: o.dk ? L('{d} dk', { d: o.dk }) : L('süresiz'), kapsam: kapsamMetni(o.kapsam).toLocaleLowerCase(YEREL) })}`,
        acildi: `🔓 ${L('{tv} kilidi açıldı', d)}`,
        'suresi-doldu': `⏰ ${L('{tv} kilidinin süresi doldu', d)}`,
        kapatildi: `⛔ ${L('{tv} kilitliyken açıldı, kapatıldı', d)}`,
      }[o.ne || 'kapatildi'];
      if (ne) satirlarListe.push({ zaman: o.zaman, ne, kaynak: o.kaynak });
    }
    for (const i of (S.veri && S.veri.islemler) || []) {
      const tur = { kanal: L('kanal'), kelime: L('kelime'), video: L('video') }[i.tur] || '';
      const ne = {
        eklendi: `➕ ${L('Engel eklendi — {tur}: {deger}', { tur, deger: i.deger })}`,
        silindi: `➖ ${L('Engel kaldırıldı — {tur}: {deger}', { tur, deger: i.deger })}`,
        acildi: `🚫 ${L('YouTube engelleme açıldı')}`,
        kapatildi: `⚪ ${L('YouTube engelleme kapatıldı')}`,
        'mesaj-degisti': `✏️ ${L('Engel mesajı (1. kademe) değiştirildi')}`,
        'uyari-degisti': `✏️ ${L('Engel uyarısı (2. kademe) değiştirildi')}`,
      }[i.ne];
      if (ne) satirlarListe.push({ zaman: i.zaman, ne, kaynak: i.kaynak });
    }
    satirlarListe.sort((a, b) => b.zaman - a.zaman);
    if (!satirlarListe.length) { kap.append(el('div', 'bos', L('Henüz kayıt yok.'))); return; }
    for (const r of satirlarListe.slice(0, 25)) {
      const s = el('div', 'olay');
      s.append(el('div', 'zaman', zamanYaz(r.zaman)));
      const ne = el('div');
      ne.append(el('b', null, r.ne));
      if (r.kaynak) ne.append(el('small', null, KAYNAK[r.kaynak] || r.kaynak));
      s.append(ne);
      kap.append(s);
    }
  }

  // ── TV kilidi ───────────────────────────────────────────────────────────
  // Kapsam seçimi için TV seçici gibi 2'li segment düğme.
  function ikiliDugme(secenekler, secili, sec) {
    const kap = el('div', 'oda-sec ikili');
    for (const [ad, deger] of secenekler) {
      const b = el('button', `oda-sec-btn${deger === secili ? ' secik' : ''}`);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(deger === secili));
      b.append(el('span', 'oda-ad', ad));
      b.addEventListener('click', () => sec(deger));
      kap.append(b);
    }
    return kap;
  }
  function secenekDugmeleri(liste, secili, sec) {
    const kap = el('div', 'secenekler');
    for (const [ad, deger] of liste) {
      const b = el('button', deger === secili ? 'secik' : '', ad);
      b.type = 'button';
      b.addEventListener('click', () => sec(deger));
      kap.append(b);
    }
    return kap;
  }

  // Seçili süre düğmesinin (SURELER'deki ham değer) okunur karşılığı.
  const sureMetniTam = (dk) => (dk == null ? L('Süresiz') : dk === 'sabah' ? L("Sabah 07:00'ye kadar") : dk % 60 === 0 ? L('{n} saat', { n: dk / 60 }) : L('{n} dakika', { n: dk }));

  // TV seçimi tek segmentli düğmeyle; süre / kapsam / kilitle tek kopya — seçili TV'ye uygulanır.
  function kilitCiz() {
    const k = S.kilit;
    const kap = $('kilitListe');
    kap.replaceChildren();
    if (!k) { kap.append(el('div', 'bos', L('Kilit bilgisi alınamadı.'))); return; }
    const tvler = Array.isArray(k.tvler) ? k.tvler : [];
    const kilitler = k.kilitler || {};
    for (const t of tvler) if (t && t.id) S.tvAdlari[t.id] = t.ad || t.id;
    if (!tvler.length) { kap.append(el('div', 'bos', L('TV bulunamadı.'))); return; }
    if (!S.kilitTv || !tvler.some((t) => t.id === S.kilitTv)) S.kilitTv = tvler[0].id;

    const seg = el('div', 'oda-sec');
    seg.setAttribute('role', 'tablist');
    for (const t of tvler) {
      const kilitli = !!kilitler[t.id];
      const b = el('button', `oda-sec-btn${t.id === S.kilitTv ? ' secik' : ''}${kilitli ? ' kilitli' : ''}`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === S.kilitTv));
      b.append(el('span', 'oda-ad', t.ad || t.id), el('span', 'oda-dur', kilitli ? `🔒 ${L('Kilitli')}` : L('Kilitsiz')));
      b.addEventListener('click', () => { S.kilitTv = t.id; kilitCiz(); });
      seg.append(b);
    }
    kap.append(seg);

    const t = tvler.find((x) => x.id === S.kilitTv);
    const ad = t.ad || t.id;
    const kilit = kilitler[t.id];
    const panel = el('div', 'kilit-panel');
    if (kilit) {
      const ne = kilit.bitis ? L("{saat}'e kadar", { saat: zamanYaz(kilit.bitis) }) : L('süresiz');
      panel.append(el('div', 'kilit-durum kilitli', `🔒 ${L('Kilitli')} · ${ne} · ${kapsamMetni(kilit.kapsam).toLocaleLowerCase(YEREL)}`));
      const ac = el('button', 'kucuk-dugme yesil genis', L('Kilidi aç'));
      ac.type = 'button';
      ac.addEventListener('click', async () => {
        ac.disabled = true;
        try { S.kilit = await istek(`/kilit/${encodeURIComponent(t.id)}`, { method: 'DELETE' }); kilitCiz(); toast(L('{tv}: kilit açıldı', { tv: ad })); } catch (e) { ac.disabled = false; toast(L('Açılamadı · {hata}', { hata: e.message }), true); }
      });
      panel.append(ac);
    } else {
      const s = S.secim[t.id] || (S.secim[t.id] = { dk: null, kapsam: 'tv+apple' });
      panel.append(ikiliDugme([[L('TV + Apple TV'), 'tv+apple'], [L('Yalnız TV'), 'tv']], s.kapsam, (d) => { s.kapsam = d; kilitCiz(); }));
      panel.append(el('div', 'kilit-durum', L('Kilitsiz — süre seçip kilitle.')));
      panel.append(secenekDugmeleri(SURELER, s.dk, (d) => { s.dk = d; kilitCiz(); }));
      const kilitle = el('button', 'kucuk-dugme kirmizi genis', `🔒 ${L('Kilitle')}`);
      kilitle.type = 'button';
      kilitle.addEventListener('click', () => kilitOnayAc(t, s));
      panel.append(kilitle);
    }
    kap.append(panel);

    kutuyaYaz($('kilitMesaj'), k.mesaj);
    islemCiz();
  }

  // Kilitle → onay ekranı (tarayıcının confirm'ü yerine: süre ve kapsam bir bakışta görünsün).
  function kilitOnayAc(t, s) {
    const ad = t.ad || t.id;
    const dk = s.dk === 'sabah' ? sabahaDk() : s.dk;
    const metin = sureMetniTam(s.dk) + (s.dk === 'sabah' ? ` (${saatYaz(Date.now() + dk * 60000)})` : '');
    const g = el('div');
    g.append(el('p', 'onay-satir', L('{tv} kilitlensin mi?', { tv: ad })));
    const ozet = el('div', 'onay-ozet');
    ozet.append(ozetSatir(L('TV'), ad), ozetSatir(L('Süre'), metin), ozetSatir(L('Kapsam'), kapsamMetni(s.kapsam)));
    g.append(ozet);
    g.append(el('p', 'onay-not', L('TV açıksa ekranda kilit mesajı gösterilir ve birkaç saniye içinde (seçiliyse Apple TV de uyutularak) kapanır. Kilitli TV kendi kumandasıyla açılamaz.')));
    modalAc({
      baslik: `🔒 ${L('Kilit onayı')}`,
      govde: g,
      dugmeler: [
        { ad: L('Vazgeç'), sinif: 'sade' },
        { ad: `🔒 ${L('Kilitle')}`, sinif: 'kirmizi', islev: () => kilitUygula(t, dk, s.kapsam, metin) },
      ],
    });
  }
  async function kilitUygula(t, dk, kapsam, metin) {
    try {
      S.kilit = await istek('/kilit', { method: 'POST', body: JSON.stringify({ tv: t.id, dk, kapsam }) });
      kilitCiz();
      toast(L('{tv} kilitlendi ({sure})', { tv: t.ad || t.id, sure: metin.toLocaleLowerCase(YEREL) }));
    } catch (e) { toast(L('Kilitlenemedi · {hata}', { hata: e.message }), true); }
  }

  $('mesajKaydet').addEventListener('click', async () => {
    const mesaj = metinAl($('kilitMesaj'));
    if (!mesaj) return;
    try { S.kilit = await istek('/kilit/ayar', { method: 'POST', body: JSON.stringify({ mesaj }) }); temizle($('kilitMesaj')); kilitCiz(); toast(L('Kilit mesajı kaydedildi')); } catch (e) { toast(L('Kaydedilemedi · {hata}', { hata: e.message }), true); }
  });

  // Engel metinleri: 1. kademe mesajı (`mesaj`) ve 2. kademe uyarısı (`uyari`). Yalnız düzenlenen kutu gönderilir
  // (ajan her değişikliği işlem kaydına yazar); boşaltılan kutu varsayılan metne döner.
  $('engelMetinKaydet').addEventListener('click', async () => {
    const govde = {};
    for (const [alan, kutu] of [['mesaj', $('engelMesaj')], ['uyari', $('engelUyari')]]) {
      if (!kutu.dataset.kirli) continue;
      const s = metinAl(kutu);
      if (!s) { kutu.focus(); return; }
      govde[alan] = s;
    }
    if (!Object.keys(govde).length) { toast(L('Değişiklik yok')); return; }
    try { S.veri = await istek('/engel/ayar', { method: 'POST', body: JSON.stringify(govde) }); temizle($('engelMesaj'), $('engelUyari')); ciz(); toast(L('Engel metinleri kaydedildi')); } catch (e) { toast(L('Kaydedilemedi · {hata}', { hata: e.message }), true); }
  });

  // ── Engellenmeyen (izlenen) YouTube videoları ─────────────────────────────
  // İzleme geçmişi (GET /api/tv/izleme) → oynatılan YouTube videoları; her satırda "Engelle".
  const ytIzleme = (k) => !k.pasif && !!k.program && !String(k.program).startsWith('(') && /youtube/i.test(k.uygulama || '');
  // Başlıktan anahtar kelime önerisi: ilk anlamlı sözcük, kesme işaretinden önce, küçük harf.
  function anahtarOner(baslik) {
    const kelimeler = String(baslik || '').split(/[\s,.!?;:()[\]"'’”“\-–—…/|]+/).filter(Boolean);
    for (const w of kelimeler) {
      const kok = w.split(/['’]/)[0];
      if (kok.length >= 3 && /[a-zA-ZğüşıöçĞÜŞİÖÇ]/.test(kok)) return kok.toLocaleLowerCase('tr');
    }
    return (kelimeler[0] || '').toLocaleLowerCase('tr');
  }

  async function izlenenYukle() {
    const kap = $('izlenenListe');
    kap.replaceChildren(el('div', 'bos', L('Yükleniyor…')));
    try {
      const j = await istek(`/izleme?gun=${trGun(Date.now())}&gunSayisi=7`);
      S.izlenenYuklendi = true;
      izlenenCiz(j);
    } catch (e) {
      kap.replaceChildren(el('div', 'bos', L('İzleme geçmişi alınamadı · {hata}', { hata: e.message })));
    }
  }

  function izlenenCiz(j) {
    const kap = $('izlenenListe');
    kap.replaceChildren();
    const engelliVideo = new Set(((S.veri && S.veri.kurallar) || []).filter((k) => k.tur === 'video' && k.videoId).map((k) => k.videoId));
    const m = new Map();
    for (const k of (j.kesitler || []).filter(ytIzleme)) {
      const id = ytKimlikMi(k.youtube) ? k.youtube : null;
      if (id && engelliVideo.has(id)) continue;   // zaten engelli videoyu gösterme
      const anahtar = id || `p:${k.program}`;
      const o = m.get(anahtar) || { id, program: k.program, tv: k.tv, son: 0, ms: 0 };
      o.ms += Math.max(0, k.bit - k.bas);
      if (k.bit >= o.son) { o.son = k.bit; o.tv = k.tv; }
      m.set(anahtar, o);
    }
    const liste = [...m.values()].sort((a, b) => b.son - a.son);
    if (!liste.length) { kap.append(el('div', 'bos', L('Son 7 günde engellenmemiş YouTube videosu bulunamadı.'))); return; }
    const SINIR = 40;
    for (const o of liste.slice(0, SINIR)) kap.append(izlenenSatir(o));
    if (liste.length > SINIR) {
      const dd = el('div', 'daha', L('+{n} daha', { n: liste.length - SINIR }));
      dd.addEventListener('click', () => { dd.remove(); for (const o of liste.slice(SINIR)) kap.append(izlenenSatir(o)); });
      kap.append(dd);
    }
  }

  function izlenenSatir(o) {
    const [baslik, kanal] = ytAyir(o.program);
    const s = el('div', 'olay izlenen');
    s.append(el('div', 'zaman', zamanYaz(o.son)));
    const ne = el('div');
    ne.append(ytAdBaglantisi(baslik, { id: o.id, kanal }));
    ne.append(el('small', null, [tvAdi(o.tv), kanal, `⏱ ${sure(o.ms)}`].filter(Boolean).join(' · ')));
    const btn = el('button', 'kucuk-dugme kirmizi engelle-btn', L('Engelle'));
    btn.type = 'button';
    btn.addEventListener('click', () => engelleSecenekAc(o, baslik, kanal));
    s.append(ne, btn);
    return s;
  }

  // Engelle → seçenekler: yalnız bu video · bu kanal · anahtar kelime (önerili).
  function engelleSecenekAc(o, baslik, kanal) {
    const link = o.id ? `https://www.youtube.com/watch?v=${o.id}` : null;
    const g = el('div');
    g.append(el('p', 'onay-satir', baslik));
    if (kanal) g.append(el('p', 'onay-not', L('Kanal: {kanal}', { kanal })));
    const sec = el('div', 'engel-secenekler');

    const bVideo = el('button', 'engel-sec');
    bVideo.type = 'button';
    bVideo.append(document.createTextNode(`🎬 ${L('Sadece bu video')}`), el('small', null, link ? L('Yalnız bu video engellenir') : L('Video kimliği yok — kullanılamaz')));
    bVideo.disabled = !link;
    if (link) bVideo.addEventListener('click', () => engelleUygula({ metin: link, tur: 'video' }, L('video: {ad}', { ad: baslik })));

    const bKanal = el('button', 'engel-sec');
    bKanal.type = 'button';
    bKanal.append(document.createTextNode(`📺 ${L('Bu kanal')}${kanal ? ` · ${kanal}` : ''}`), el('small', null, link ? L('Kanalın tüm videoları engellenir') : L('Video kimliği yok — kullanılamaz')));
    bKanal.disabled = !link;
    if (link) bKanal.addEventListener('click', () => engelleUygula({ metin: link, tur: 'kanal' }, kanal ? L('kanal: {deger}', { deger: kanal }) : L('kanal')));

    const etiket = el('div', 'engel-kelime-etiket', `🔤 ${L('Anahtar kelimeyle engelle (önerildi, değiştirilebilir):')}`);
    const kutu = el('div', 'engel-kelime');
    const inp = el('input');
    inp.type = 'text'; inp.value = anahtarOner(baslik); inp.maxLength = 60; inp.autocapitalize = 'off'; inp.spellcheck = false;
    inp.setAttribute('aria-label', L('Anahtar kelime'));
    const bKelime = el('button', 'engel-sec kelime-onay', L('Engelle'));
    bKelime.type = 'button';
    bKelime.addEventListener('click', () => { const w = inp.value.trim(); if (!w) { inp.focus(); return; } engelleUygula({ metin: w, tur: 'kelime' }, L('kelime: {deger}', { deger: w })); });
    kutu.append(inp, bKelime);

    sec.append(bVideo, bKanal, etiket, kutu);
    g.append(sec);
    modalAc({ baslik: L('Nasıl engellensin?'), govde: g, dugmeler: [{ ad: L('Vazgeç'), sinif: 'sade' }] });
  }

  async function engelleUygula(govde, etiket) {
    modalKapat();
    try {
      S.veri = await istek('/engel', { method: 'POST', body: JSON.stringify(govde) });
      ciz();
      toast(S.veri.varmis ? L('Zaten engelli — {ne}', { ne: etiket }) : L('Engellendi — {ne}', { ne: etiket }));
      if (S.izlenenYuklendi) izlenenYukle();   // engellenen video listeden düşsün
    } catch (e) {
      toast(L('Engellenemedi · {hata}', { hata: e.message }), true);
    }
  }

  // ── Sekmeler: Engellenenler ↔ Engellenmeyenler ──
  for (const b of document.querySelectorAll('.sekme')) {
    b.addEventListener('click', () => {
      const sek = b.dataset.sekme;
      for (const x of document.querySelectorAll('.sekme')) { const a = x === b; x.classList.toggle('secik', a); x.setAttribute('aria-selected', String(a)); }
      $('olayPanel').hidden = sek !== 'olay';
      $('izlenenPanel').hidden = sek !== 'izlenen';
      if (sek === 'izlenen' && !S.izlenenYuklendi) izlenenYukle();
    });
  }

  async function yukle() {
    // Önce kilit: TV adları (olay ve işlem satırlarında) oradan gelir.
    const [k, e] = await Promise.allSettled([istek('/kilit'), istek('/engel')]);
    if (k.status === 'fulfilled') { S.kilit = k.value; kilitCiz(); } else { kilitCiz(); toast(L('Kilit bilgisi alınamadı · {hata}', { hata: k.reason.message }), true); }
    if (e.status === 'fulfilled') { S.veri = e.value; ciz(); } else toast(L('Engel listesi alınamadı · {hata}', { hata: e.reason.message }), true);
  }

  // ── olaylar ───────────────────────────────────────────────────────────
  for (const b of document.querySelectorAll('#turSecim button')) {
    b.addEventListener('click', () => {
      S.tur = b.dataset.tur;
      for (const x of document.querySelectorAll('#turSecim button')) x.classList.toggle('secik', x === b);
      $('turIpucu').textContent = IPUCU[S.tur];
    });
  }
  $('turIpucu').textContent = IPUCU[''];

  $('ekleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const metin = $('metin').value.trim();
    if (!metin) return;
    $('ekleBtn').disabled = true;
    try {
      const j = await istek('/engel', { method: 'POST', body: JSON.stringify({ metin, ...(S.tur ? { tur: S.tur } : {}) }) });
      S.veri = j;
      ciz();
      $('metin').value = '';
      const k = j.kural || {};
      const turAdi = { kanal: L('kanal'), kelime: L('kelime'), video: L('video') }[k.tur] || k.tur || '';
      const ne = k.tur === 'video' ? L('video: {ad}', { ad: k.baslik || k.videoId }) : `${turAdi}: ${k.deger}`;
      toast(j.varmis ? L('Zaten engelli — {ne}', { ne }) : L('Engellendi — {ne}', { ne }));
    } catch (err) {
      toast(L('Eklenemedi · {hata}', { hata: err.message }), true);
    } finally {
      $('ekleBtn').disabled = false;
    }
  });

  $('acikDugme').addEventListener('click', async () => {
    const acik = $('acikDugme').getAttribute('aria-checked') !== 'true';
    if (!acik && !confirm(L('Engelleme kapatılsın mı? Kurallar silinmez, yalnız uygulanmaz.'))) return;
    try { S.veri = await istek('/engel/ayar', { method: 'POST', body: JSON.stringify({ acik }) }); ciz(); toast(acik ? L('Engelleme açıldı') : L('Engelleme kapatıldı')); } catch (e) { toast(L('Değiştirilemedi · {hata}', { hata: e.message }), true); }
  });

  (async () => {
    await Saat.yukle();   // saat dilimi geçitten
    await yukle();
  })();
  setInterval(() => { if (document.visibilityState === 'visible') yukle(); }, 30000);
})();
