/* Detail (/detail) — ajanın izleme kaydından: üstte her TV'nin şu anki durumu, altında seçili günün saatlik
   grafiği ve ne izlendiği; istenirse gün / hafta / ay geçmişi (özet, zaman çizelgesi, kanal → program, uygulama
   içeriği, oturumlar). Veri: GET /api/tv/tvler + GET /api/tv/izleme.
   Bütün metin textContent ile basılır (rehberden ve Apple TV'den gelen adlar dış veridir). Saatler kumandanın
   saat diliminde (saat.js). */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const L = window.L || ((m, d) => (typeof m !== 'string' ? m : (d ? m.replace(/\|[^|]*$/, '').replace(/\{(\w+)\}/g, (h, a) => (a in d ? String(d[a]) : h)) : m.replace(/\|[^|]*$/, ''))));
  const Saat = window.Saat;
  const YEREL = window.i18n && window.i18n.dil() === 'en' ? 'en-GB' : 'tr-TR';
  const GUN = 24 * 3600e3;
  const SVG = 'http://www.w3.org/2000/svg';

  const S = { tvler: [], tv: null, aralik: 'gun', gun: null, veri: null, ytKimlik: new Map(), tvDurum: [], bugun: null, gunGorunum: null, gunVeri: null, sira: 'yeni', grup: false };
  // Gün listesinin sırası: varsayılan en yeni → en eski; seçim tarayıcıda hatırlanır. Liste varsayılan gruplamasız.
  try { if (localStorage.getItem('izleme_sira') === 'uzun') S.sira = 'uzun'; } catch { /* özel pencere */ }
  try { S.grup = localStorage.getItem('izleme_grup') === '1'; } catch { /* özel pencere */ }
  const ytKaydet = (ks) => { for (const k of ks) if (k.youtube && k.program) S.ytKimlik.set(k.program, k.youtube); };

  // ── yardımcılar ───────────────────────────────────────────────────────
  const iki = (n) => String(n).padStart(2, '0');
  const trGun = (ms) => Saat.gun(ms);
  const trSaat = (ms) => Saat.saat(ms);
  const gunBasi = (gun) => Saat.gunBasi(gun);
  const gunEkle = (gun, n) => Saat.gunEkle(gun, n);
  const haftaGunu = (gun) => Saat.haftaGunu(gun);
  const gunUzun = (gun) => Saat.tarihYaz(gun, { day: 'numeric', month: 'long', weekday: 'long' }, YEREL);
  const gunKisa = (gun) => Saat.tarihYaz(gun, { day: 'numeric', month: 'short' }, YEREL);
  const haftaKisa = (gun) => Saat.tarihYaz(gun, { weekday: 'short' }, YEREL);
  const ayYil = (gun) => Saat.tarihYaz(gun, { month: 'long', year: 'numeric' }, YEREL);
  const sure = (ms) => {
    const dk = Math.round(ms / 60000);
    if (dk < 1) return ms > 0 ? L('<1 dk') : L('0 dk');
    const s = Math.floor(dk / 60);
    return s ? L('{s} sa {d} dk', { s, d: iki(dk % 60) }) : L('{d} dk', { d: dk });
  };
  const el = (etiket, sinif, metin) => { const e = document.createElement(etiket); if (sinif) e.className = sinif; if (metin != null) e.textContent = metin; return e; };
  const svgEl = (etiket, ozellik = {}) => { const e = document.createElementNS(SVG, etiket); for (const [k, v] of Object.entries(ozellik)) e.setAttribute(k, v); return e; };
  let toastT;
  function toast(m) { const t = $('toast'); t.textContent = m; t.className = 'toast show error'; clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 5000); }
  async function getir(yol) {
    const r = await fetch(`/api/tv${yol}`, { cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; throw new Error(L('giriş gerekli')); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? L(String(j.error)) : `HTTP ${r.status}`);
    return j;
  }

  // ── kategori (kaynak) ─────────────────────────────────────────────────
  // İç anahtarlar Türkçe sabitlerdir (renk ve gruplama için); ekranda katAdi() ile seçili dilde görünür.
  const PASIF = 'Pasif';   // TV açık ama oynayan yok: duraklatılmış ya da bekleme ekranı (ajan kesitte `pasif` işaretler)
  const PASIF_SOLUK = 'rgba(175,175,195,.34)';
  // YouTube kırmızı, Netflix turuncu: grafikte birbirinden ayırt edilsin.
  const RENK = { 'Canlı TV': '#58c9fb', YouTube: '#ff2a2a', Netflix: '#ff9500', 'Prime Video': '#00a8e1', 'Disney+': '#4f6bff', 'Apple TV': '#c9c9d4', 'Diğer': '#a68be0', [PASIF]: '#6b6b7e' };
  const yedekRenk = ['#f5b041', '#6fd07a', '#ff8fb1', '#7dd3c0', '#c39bff'];
  const renk = (k) => RENK[k] || yedekRenk[[...k].reduce((a, c) => a + c.charCodeAt(0), 0) % yedekRenk.length];
  const KAT_ADI = { 'Canlı TV': L('Canlı TV'), 'Diğer': L('Diğer|kaynak'), [PASIF]: L('Pasif') };
  const katAdi = (k) => KAT_ADI[k] || k;   // uygulama adları (YouTube, Netflix…) çevrilmez
  function kategori(k) {
    if (k.kaynak === 'canli') return 'Canlı TV';
    if (k.kaynak === 'netflix') return 'Netflix';
    if (k.kaynak === 'prime') return 'Prime Video';
    if (k.kaynak === 'disney') return 'Disney+';
    const u = k.uygulama || '';
    if (/youtube/i.test(u)) return 'YouTube';
    if (/netflix/i.test(u)) return 'Netflix';
    if (/prime video|aiv/i.test(u)) return 'Prime Video';
    if (/disney/i.test(u)) return 'Disney+';
    if (u && !/hdmi|apple ott|^apple tv/i.test(u)) return u;
    return k.kaynak === 'apple' ? 'Apple TV' : 'Diğer';
  }
  // Zamanın türü: duraklatılmış oynatma ayrı sayılır (TV açık ama izlenmiyor).
  const tur = (k) => (k.pasif ? PASIF : k.kat);
  const izlenenMs = (ks) => ks.reduce((a, k) => a + (k.pasif ? 0 : k.bit - k.bas), 0);
  // İçerik adı bilinmeyen satır: Apple TV'de oynayan ama uygulaması tanımlanamayan → "Apple TV (undetected)";
  // Netflix içerik adı vermez → yalnız "Netflix".
  const TANIMSIZ = 'Apple TV (undetected)';
  const bosIcerik = (kat) => (kat === 'Apple TV' ? TANIMSIZ : kat === 'Netflix' ? 'Netflix' : L('(menüde / içerik bilgisi yok)'));
  const tvAdi = (id) => (S.tvler.find((t) => t.id === id) || {}).ad || id;

  // ── veri ──────────────────────────────────────────────────────────────
  function aralik() {
    const g = S.gun;
    if (S.aralik === 'gun') return { son: g, gunSayisi: 1 };
    if (S.aralik === 'hafta') {
      const pzt = gunEkle(g, -((haftaGunu(g) + 6) % 7));
      return { son: gunEkle(pzt, 6), gunSayisi: 7 };
    }
    const [y, m] = g.split('-').map(Number);
    const gunler = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { son: `${y}-${iki(m)}-${iki(gunler)}`, gunSayisi: gunler };
  }

  /** Aynı TV'de aynı içeriğin art arda kesitlerini birleştirir (ajan yeniden başlayınca bölünür). */
  function birlestir(kesitler) {
    const sirali = kesitler.slice().sort((a, b) => String(a.tv).localeCompare(String(b.tv)) || a.bas - b.bas);
    const sonuc = [];
    for (const k of sirali) {
      const o = sonuc[sonuc.length - 1];
      const ayni = o && o.tv === k.tv && o.kaynak === k.kaynak && (o.kanal?.no ?? null) === (k.kanal?.no ?? null)
        && o.program === k.program && o.uygulama === k.uygulama && !!o.ekranKapali === !!k.ekranKapali && (o.pasif || null) === (k.pasif || null);
      if (ayni && k.bas - o.bit <= 120000) { o.bit = Math.max(o.bit, k.bit); o.acik = o.acik || k.acik; }
      else sonuc.push({ ...k });
    }
    return sonuc.sort((a, b) => a.bas - b.bas);
  }

  /** Ajan yanıtı → birleştirilmiş, aralığa kırpılmış, kategorili kesitler. */
  const hazirla = (j) => birlestir((j.kesitler || []).filter((k) => k && Number.isFinite(k.bas) && Number.isFinite(k.bit)))
    .map((k) => ({ ...k, bas: Math.max(k.bas, j.bas), bit: Math.min(k.bit, j.bit), kat: kategori(k) })).filter((k) => k.bit > k.bas);

  async function yukle() {
    const a = aralik();
    $('icerik').classList.add('yukleniyor');
    try {
      const q = new URLSearchParams({ gun: a.son, gunSayisi: String(a.gunSayisi), ...(S.tv && S.tv !== 'hepsi' ? { tv: S.tv } : {}) });
      const j = await getir(`/izleme?${q}`);
      S.veri = { bas: j.bas, bit: j.bit, kesitler: hazirla(j) };
      ciz();
    } catch (e) {
      toast(L('İzleme geçmişi alınamadı · {hata}', { hata: e.message }));
    } finally {
      $('icerik').classList.remove('yukleniyor');
    }
  }

  // ── çizim ─────────────────────────────────────────────────────────────
  function etiketYaz() {
    const a = aralik();
    let metin;
    if (S.aralik === 'gun') metin = gunUzun(S.gun);
    else if (S.aralik === 'hafta') metin = `${gunKisa(gunEkle(a.son, -6))} – ${gunKisa(a.son)}`;
    else metin = ayYil(S.gun);
    $('tarihEtiket').textContent = metin;
    $('sonraki').disabled = a.son >= trGun(Date.now()) && (S.aralik !== 'gun' || S.gun >= trGun(Date.now()));
  }

  function topla(kesitler, anahtar) {
    const m = new Map();
    for (const k of kesitler) { const a = anahtar(k); if (a == null) continue; m.set(a, (m.get(a) || 0) + (k.bit - k.bas)); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  function ozetCiz(ks) {
    const kap = $('ozetler');
    kap.replaceChildren();
    const toplam = ks.reduce((a, k) => a + (k.bit - k.bas), 0);
    const izlenen = izlenenMs(ks);
    const kart = (ad, deger, alt, sinif, nokta) => {
      const o = el('div', 'ozet' + (sinif ? ` ${sinif}` : ''));
      const a = el('div', 'ad');
      if (nokta) { const n = el('span', 'nokta'); n.style.background = nokta; a.append(n); }
      a.append(document.createTextNode(ad));
      o.append(a, el('div', 'deger', deger));
      if (alt) o.append(el('div', 'alt', alt));
      kap.append(o);
    };
    const cokTv = S.tv === 'hepsi' && S.tvler.length > 1;
    const altlar = [];
    if (izlenen !== toplam) altlar.push(L('izlenen {sure}', { sure: sure(izlenen) }));
    if (S.aralik !== 'gun') altlar.push(L('günde ort. {sure}', { sure: sure(toplam / aralik().gunSayisi) }));
    kart(cokTv ? L("TV açık (TV'lerin toplamı)") : L('TV açık'), sure(toplam), altlar.join(' · ') || null, 'ana');
    for (const [kat, ms] of topla(ks, tur)) {
      kart(kat === PASIF ? `⏸ ${katAdi(kat)}` : katAdi(kat), sure(ms), kat === PASIF ? L('duraklatılmış ya da bekleme ekranı') : (toplam ? `%${Math.round((ms / toplam) * 100)}` : null), null, renk(kat));
    }
    const ses = ks.filter((k) => k.ekranKapali).reduce((a, k) => a + (k.bit - k.bas), 0);
    if (ses) kart(L('Yalnız ses (ekran kapalı)'), sure(ses));
    if (ks.length) {
      const enUzun = ks.reduce((a, k) => (k.bit - k.bas > a.bit - a.bas ? k : a));
      kart(L('Oturum'), String(ks.length), L('en uzun {sure}', { sure: sure(enUzun.bit - enUzun.bas) }));
      if (S.aralik === 'gun') kart(L('İlk açılış · son kapanış'), `${trSaat(ks[0].bas)} – ${trSaat(Math.max(...ks.map((k) => k.bit)))}`, ks.some((k) => k.acik) ? L('şu an açık') : null);
    }
    // kaynak şeridi + lejant
    const serit = $('kaynakSerit');
    const lejant = $('kaynakLejant');
    serit.replaceChildren();
    lejant.replaceChildren();
    for (const [kat, ms] of topla(ks, tur)) {
      const p = el('span');
      p.style.width = `${(ms / toplam) * 100}%`;
      p.style.background = kat === PASIF ? `repeating-linear-gradient(135deg, ${renk(kat)} 0 4px, rgba(255,255,255,.18) 4px 7px)` : renk(kat);
      p.title = `${katAdi(kat)} · ${sure(ms)}`;
      serit.append(p);
      const l = el('span');
      const n = el('span', 'nokta');
      n.style.background = renk(kat);
      l.append(n, document.createTextNode(`${katAdi(kat)} ${sure(ms)}`));
      lejant.append(l);
    }
    $('ozetBaslik').textContent = { gun: L('Günün özeti'), hafta: L('Haftanın özeti'), ay: L('Ayın özeti') }[S.aralik];
  }

  const ipucu = $('ipucu');
  function ipucuGoster(e, satirlar) {
    ipucu.replaceChildren(...satirlar.map((s, i) => el(i ? 'div' : 'b', null, s)));
    ipucu.hidden = false;
    const x = Math.min(window.innerWidth - 270, e.clientX + 12);
    ipucu.style.left = `${Math.max(8, x)}px`;
    ipucu.style.top = `${e.clientY + 14}px`;
  }
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('[data-ipucu]')) ipucu.hidden = true; });
  const kanalAdi = (k) => (k.kanal && (k.kanal.ad || String(k.kanal.no))) || '?';
  const kesitIpucu = (k) => [
    katAdi(k.kat) + (k.kanal ? ` · ${kanalAdi(k)}` : '') + (k.pasif ? ` · ⏸ ${L('duraklatıldı')}` : ''),
    ...(k.program ? [k.program] : []),
    `${trSaat(k.bas)} – ${k.acik ? L('sürüyor') : trSaat(k.bit)} · ${sure(k.bit - k.bas)}`,
    tvAdi(k.tv) + (k.ekranKapali ? ` · ${L('ekran kapalı')}` : ''),
  ];

  function zamanCiz(ks) {
    const kap = $('zamanCizelge');
    kap.replaceChildren();
    // Grafikler kabın gerçek piksel genişliğinde çizilir: yazılar telefonda da okunur boyda kalır.
    const W = Math.max(260, kap.clientWidth || 600);
    if (S.aralik === 'gun') {
      $('zamanBaslik').textContent = L('Zaman çizelgesi');
      const tvler = S.tv === 'hepsi' ? S.tvler.map((t) => t.id) : [S.tv];
      for (const id of tvler) {
        kap.append(el('div', 'zc-tv', tvAdi(id)));
        const svg = svgEl('svg', { viewBox: `0 0 ${W} 48`, height: '48' });
        svg.append(svgEl('rect', { x: 0, y: 6, width: W, height: 24, rx: 6, fill: 'rgba(255,255,255,0.05)' }));
        const adim = W < 500 ? 6 : 3;
        for (let s = 0; s <= 24; s += adim) {
          const x = (s / 24) * W;
          svg.append(svgEl('line', { x1: x, x2: x, y1: 4, y2: 32, stroke: 'rgba(255,255,255,0.08)', 'stroke-width': 1 }));
          const t = svgEl('text', { x, y: 45, 'text-anchor': s === 0 ? 'start' : s === 24 ? 'end' : 'middle' });
          t.textContent = `${iki(s % 24)}:00`;
          svg.append(t);
        }
        for (const k of ks.filter((x) => x.tv === id)) {
          const x = ((k.bas - S.veri.bas) / GUN) * W;
          const w = Math.max(2, ((k.bit - k.bas) / GUN) * W);
          const r = svgEl('rect', { x, y: 6, width: w, height: 24, rx: 3, fill: renk(tur(k)), opacity: k.ekranKapali ? 0.45 : 1, 'data-ipucu': '1' });
          r.style.cursor = 'pointer';
          r.addEventListener('pointerdown', (e) => ipucuGoster(e, kesitIpucu(k)));
          r.addEventListener('pointerenter', (e) => ipucuGoster(e, kesitIpucu(k)));
          r.addEventListener('pointerleave', () => { ipucu.hidden = true; });
          svg.append(r);
        }
        kap.append(svg);
      }
      return;
    }
    // Hafta / ay: günlük süre, kaynağa göre yığılmış sütunlar
    $('zamanBaslik').textContent = S.aralik === 'hafta' ? L('Günlere göre') : L('Ayın günleri');
    const a = aralik();
    const gunler = Array.from({ length: a.gunSayisi }, (_, i) => gunEkle(a.son, -(a.gunSayisi - 1 - i)));
    const kats = topla(ks, tur).map(([k]) => k).sort((x, y) => (x === PASIF) - (y === PASIF));
    const gunde = gunler.map((g) => {
      const b = gunBasi(g); const e = gunBasi(gunEkle(g, 1));
      const m = {};
      for (const k of ks) { const ms = Math.min(k.bit, e) - Math.max(k.bas, b); if (ms > 0) m[tur(k)] = (m[tur(k)] || 0) + ms; }
      return { g, m, toplam: Object.values(m).reduce((x, y) => x + y, 0) };
    });
    const enCok = Math.max(3600e3, ...gunde.map((d) => d.toplam));
    const H = 190; const alt = 22; const sw = W / gunler.length;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: String(H) });
    const sa = Math.ceil(enCok / 3600e3);
    for (let s = Math.max(1, Math.ceil(sa / 4)); s <= sa; s += Math.max(1, Math.ceil(sa / 4))) {
      const y = H - alt - (s * 3600e3 / enCok) * (H - alt - 10);
      svg.append(svgEl('line', { x1: 0, x2: W, y1: y, y2: y, stroke: 'rgba(255,255,255,0.07)' }));
      const t = svgEl('text', { x: W, y: y - 3, 'text-anchor': 'end' }); t.textContent = L('{s} sa', { s }); svg.append(t);
    }
    gunde.forEach((d, i) => {
      let y = H - alt;
      for (const kat of kats) {
        const ms = d.m[kat]; if (!ms) continue;
        const h = (ms / enCok) * (H - alt - 10);
        y -= h;
        const r = svgEl('rect', { x: i * sw + sw * 0.15, y, width: sw * 0.7, height: h, fill: renk(kat), rx: 2, 'data-ipucu': '1' });
        r.style.cursor = 'pointer';
        const bilgi = [`${gunKisa(d.g)} ${haftaKisa(d.g)}`, L('Toplam {sure}', { sure: sure(d.toplam) }), ...kats.filter((k) => d.m[k]).map((k) => `${katAdi(k)}: ${sure(d.m[k])}`)];
        r.addEventListener('pointerenter', (e) => ipucuGoster(e, bilgi));
        r.addEventListener('pointerleave', () => { ipucu.hidden = true; });
        r.addEventListener('click', () => { S.gun = d.g; S.aralik = 'gun'; secimleriCiz(); yukle(); });
        svg.append(r);
      }
      const her = gunler.length <= 7 ? 1 : W < 500 ? 5 : 2;
      if (i % her === 0 || i === gunler.length - 1) {
        const t = svgEl('text', { x: i * sw + sw / 2, y: H - 6, 'text-anchor': 'middle' });
        t.textContent = gunler.length <= 7 ? haftaKisa(d.g) : String(Number(d.g.slice(8)));
        svg.append(t);
      }
    });
    kap.append(svg);
  }

  // ── YouTube bağlantısı: ajan videoyu birebir bulduysa (kimlik) doğrudan video, bulamadıysa YouTube araması.
  // Program metni "Başlık (Kanal)" biçimindedir.
  const ytAyir = (program) => { const m = /^(.*\S) \(([^()]+)\)$/.exec(program || ''); return m ? [m[1], m[2]] : [program || '']; };
  /**
   * Kaynağın ikonu — her izlemenin solunda: YouTube oynat simgesi, Netflix "N", Canlı TV televizyon; Apple TV /
   * Prime / Disney+ harf rozeti; bilinmeyen uygulama için renkli genel oynat. Hepsi satır içi SVG (görüntü dosyası
   * yok; markaların logoları depoda taşınmaz). Renkler RENK ile aynı.
   */
  function kaynakIkonu(kat, boy = 18) {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', width: String(boy), height: String(boy), 'aria-hidden': 'true', class: 'ikon' });
    const kutu = (fill) => svgEl('rect', { x: 1.5, y: 1.5, width: 21, height: 21, rx: 5.5, fill });
    const yazi = (metin, boyut = 10) => {
      const t = svgEl('text', { x: 12, y: 12, 'text-anchor': 'middle', 'dominant-baseline': 'central' });
      t.textContent = metin;
      Object.assign(t.style, { fill: '#fff', fontSize: `${boyut}px`, fontWeight: '800' });
      return t;
    };
    if (kat === 'YouTube') svg.append(svgEl('rect', { x: 1, y: 4, width: 22, height: 16, rx: 5, fill: RENK.YouTube }), svgEl('path', { d: 'M10 8.3v7.4l6.3-3.7z', fill: '#fff' }));
    else if (kat === 'Netflix') svg.append(kutu('#141414'), svgEl('path', { d: 'M8 5h2.7l3.1 8.1V5h2.6v14h-2.6l-3.2-8.2V19H8z', fill: RENK.Netflix }));
    else if (kat === 'Canlı TV') svg.append(svgEl('rect', { x: 2, y: 4.5, width: 20, height: 13, rx: 2.5, fill: 'none', stroke: RENK['Canlı TV'], 'stroke-width': 2 }), svgEl('path', { d: 'M8 21h8M12 17.5V21', stroke: RENK['Canlı TV'], 'stroke-width': 2, 'stroke-linecap': 'round' }));
    else if (kat === 'Apple TV') svg.append(kutu('#2b2b33'), yazi('tv', 10));
    else if (kat === 'Prime Video') svg.append(kutu(RENK['Prime Video']), yazi('P', 12));
    else if (kat === 'Disney+') svg.append(kutu(RENK['Disney+']), yazi('D+', 9));
    else if (kat === PASIF) svg.append(kutu('#4a4a5c'), svgEl('path', { d: 'M9 7.5v9M15 7.5v9', stroke: '#d8d8e4', 'stroke-width': 2.4, 'stroke-linecap': 'round' }));
    else svg.append(svgEl('circle', { cx: 12, cy: 12, r: 10.5, fill: renk(kat) }), svgEl('path', { d: 'M10 7.8v8.4l6.6-4.2z', fill: '#fff' }));
    return svg;
  }
  function ytBag(program) {
    const id = S.ytKimlik.get(program);
    const kimlik = !!id && /^[A-Za-z0-9_-]{11}$/.test(id);
    const a = document.createElement('a');
    a.className = kimlik ? 'yt' : 'yt ara';
    a.href = kimlik
      ? `https://www.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/results?search_query=${encodeURIComponent(ytAyir(program).join(' '))}`;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = kimlik ? L("Videoyu YouTube'da aç") : L("YouTube'da ara (video birebir bulunamadı)");
    a.setAttribute('aria-label', a.title);
    a.textContent = '🔗';
    a.addEventListener('click', (e) => e.stopPropagation());
    return a;
  }
  const ytMi = (kat, program) => kat === 'YouTube' && !!program && !program.startsWith('(');

  function satir(ad, ms, toplam, renkKodu, alt, ek, ikonKat = null, onZaman = null) {
    const s = el('div', 'satir');
    const a = el('div', 'ad');
    if (onZaman != null) a.append(el('span', 'zaman', onZaman));   // izlenme saati satırın en başında
    if (ikonKat) a.append(kaynakIkonu(ikonKat));
    a.append(el('span', 'metin', ad));
    if (ek) a.append(ek);
    if (alt) a.append(el('small', null, alt));
    a.title = ad + (alt ? ` ${alt}` : '');
    const c = el('div', 'cubuk');
    const i = el('i');
    i.style.width = `${toplam ? Math.max(2, (ms / toplam) * 100) : 0}%`;
    i.style.background = renkKodu;
    c.append(i);
    s.append(a, el('div', 'sure', sure(ms)), c);
    return s;
  }

  function kanalCiz(ks) {
    const kap = $('kanalListe');
    kap.replaceChildren();
    const canli = ks.filter((k) => k.kat === 'Canlı TV');
    if (!canli.length) { kap.append(el('div', 'bos', L('Bu aralıkta canlı yayın izlenmedi.'))); return; }
    const kanallar = topla(canli, kanalAdi);
    const enCok = kanallar[0][1];
    for (const [kanal, ms] of kanallar) {
      const d = el('details', 'kanal');
      const ozet = el('summary');
      ozet.append(satir(kanal, ms, enCok, RENK['Canlı TV'], null, null, 'Canlı TV'));
      d.append(ozet);
      const alt = el('div', 'alt-liste');
      const programlar = topla(canli.filter((k) => kanalAdi(k) === kanal), (k) => k.program || L('(program bilgisi yok)'));
      for (const [p, pms] of programlar) alt.append(satir(p, pms, ms, 'rgba(88,201,251,.55)'));
      d.append(alt);
      kap.append(d);
    }
  }

  const icerikAdi = (k) => k.program || bosIcerik(k.kat);

  function icerikCiz(ks) {
    const kap = $('icerikListe');
    kap.replaceChildren();
    const uyg = ks.filter((k) => k.kat !== 'Canlı TV');
    const izlenenler = uyg.filter((k) => !k.pasif);
    if (!izlenenler.length) { kap.append(el('div', 'bos', uyg.length ? L('Uygulama açıktı ama oynatma hep duraklatılmıştı.') : L('Bu aralıkta uygulama kullanılmadı.'))); return; }
    // Süreler yalnız izlenen kısım; duraklatılmış kalan süre yanında ⏸ ile.
    const durakta = (liste) => new Map(topla(liste.filter((k) => k.pasif), icerikAdi));
    const kats = topla(izlenenler, (k) => k.kat);
    const enCok = kats[0][1];
    for (const [kat, ms] of kats) {
      const d = el('details', 'kanal');
      d.open = kats.length <= 2;
      const ozet = el('summary');
      const katPasif = uyg.filter((k) => k.kat === kat && k.pasif).reduce((a, k) => a + (k.bit - k.bas), 0);
      ozet.append(satir(katAdi(kat), ms, enCok, renk(kat), katPasif ? `⏸ ${sure(katPasif)}` : null, null, kat));
      d.append(ozet);
      const alt = el('div', 'alt-liste');
      const pasifler = durakta(uyg.filter((k) => k.kat === kat));
      const icerikler = topla(izlenenler.filter((k) => k.kat === kat), icerikAdi);
      for (const [p, pms] of icerikler) alt.append(satir(p, pms, ms, renk(kat), pasifler.get(p) ? `⏸ ${sure(pasifler.get(p))}` : null, ytMi(kat, p) ? ytBag(p) : null, kat));
      d.append(alt);
      kap.append(d);
    }
  }

  function saatCiz(ks) {
    const kap = $('saatDagilim');
    kap.replaceChildren();
    const saat = new Array(24).fill(0);
    for (const k of ks.filter((x) => !x.pasif)) {
      // Saat başlarına böl: her parçanın saati bölgedeki duvar saatinden (yaz saati geçişi dahil).
      for (let t = k.bas; t < k.bit;) {
        const p = Saat.parca(t);
        const sonraki = Math.min(k.bit, t + (60 - p.dk) * 60000 - p.sn * 1000 - (t % 1000));
        saat[p.sa] += Math.max(0, sonraki - t);
        t = sonraki > t ? sonraki : t + 60000;
      }
    }
    const enCok = Math.max(...saat, 1);
    const W = Math.max(260, kap.clientWidth || 600); const H = 130; const alt = 18; const sw = W / 24;
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, height: String(H) });
    saat.forEach((ms, i) => {
      const h = (ms / enCok) * (H - alt - 6);
      const r = svgEl('rect', { x: i * sw + 1.5, y: H - alt - h, width: sw - 3, height: Math.max(h, ms ? 2 : 0), rx: 3, fill: i >= 22 || i < 7 ? '#a68be0' : '#58c9fb', 'data-ipucu': '1' });
      r.addEventListener('pointerenter', (e) => ipucuGoster(e, [`${iki(i)}:00 – ${iki((i + 1) % 24)}:00`, sure(ms)]));
      r.addEventListener('pointerleave', () => { ipucu.hidden = true; });
      svg.append(r);
      if (i % (W < 500 ? 6 : 3) === 0) { const t = svgEl('text', { x: i * sw + sw / 2, y: H - 4, 'text-anchor': 'middle' }); t.textContent = iki(i); svg.append(t); }
    });
    kap.append(svg);
  }

  function tvCiz(ks) {
    const kap = $('tvListe');
    kap.replaceChildren();
    const tvler = topla(ks, (k) => k.tv);
    if (!tvler.length) { kap.append(el('div', 'bos', L('Kayıt yok.'))); return; }
    const enCok = tvler[0][1];
    for (const [id, ms] of tvler) {
      const kats = topla(ks.filter((k) => k.tv === id), tur).map(([k, v]) => `${k === PASIF ? '⏸' : katAdi(k)} ${sure(v)}`).join(' · ');
      kap.append(satir(tvAdi(id), ms, enCok, '#7fd6fc', kats));
    }
  }

  function oturumCiz(ks) {
    const kap = $('oturumListe');
    kap.replaceChildren();
    if (!ks.length) { kap.append(el('div', 'bos', S.gun === trGun(Date.now()) && S.aralik === 'gun' ? L('Bugün henüz TV açılmadı (ya da kayıt yeni başladı).') : L('Bu aralıkta kayıt yok.'))); return; }
    for (const k of ks.slice().reverse().slice(0, 300)) {
      const s = el('div', 'oturum');
      const zaman = S.aralik === 'gun' ? `${trSaat(k.bas)}–${k.acik ? '' : trSaat(k.bit)}` : `${gunKisa(trGun(k.bas))} ${trSaat(k.bas)}`;
      s.append(el('div', 'saat', zaman));
      const ne = el('div', 'ne');
      const b = el('b');
      b.append(el('span', 'metin', k.kat === 'Canlı TV' ? `${(k.kanal && (k.kanal.ad || k.kanal.no)) || katAdi('Canlı TV')}${k.program ? ` · ${k.program}` : ''}` : `${katAdi(k.kat)}${k.program ? ` · ${k.program}` : ''}`));
      if (ytMi(k.kat, k.program)) b.append(ytBag(k.program));
      if (k.pasif) b.append(el('span', 'pasif-rozet', `⏸ ${L('DURAKLATILDI')}`));
      if (k.acik) b.append(el('span', 'canli-rozet', L('ŞİMDİ')));
      b.prepend(kaynakIkonu(k.pasif ? PASIF : k.kat));
      ne.append(b, el('small', null, `${tvAdi(k.tv)}${k.ekranKapali ? ` · ${L('ekran kapalı (yalnız ses)')}` : ''}`));
      s.append(ne, el('div', 'sure', sure(k.bit - k.bas)));
      kap.append(s);
    }
  }

  function ciz() {
    etiketYaz();
    const ks = S.veri ? S.veri.kesitler : [];
    ytKaydet(ks);
    ozetCiz(ks);
    zamanCiz(ks);
    kanalCiz(ks);
    icerikCiz(ks);
    saatCiz(ks);
    tvCiz(ks);
    oturumCiz(ks);
  }

  function secimleriCiz() {
    const tvKap = $('tvSecim');
    tvKap.replaceChildren();
    // Her TV kendi içinde (TV'leri toplamak anlamlı bir süre vermiyor).
    for (const t of S.tvler) {
      const b = el('button', t.id === S.tv ? 'secik' : '', String(t.ad).split(/\s+/)[0]);
      b.type = 'button';
      b.title = t.ad;
      b.addEventListener('click', () => { S.tv = t.id; secimleriCiz(); yukle(); });
      tvKap.append(b);
    }
    for (const b of document.querySelectorAll('#aralikSecim button')) b.classList.toggle('secik', b.dataset.aralik === S.aralik);
  }

  // ── Sade görünüm: "Şu an" (her TV ne yapıyor) + seçili gün (her TV'de zaman nereye gitti) ─────────────
  const dkSn = (sn) => { sn = Math.max(0, Math.round(sn)); const s = Math.floor(sn / 3600); const d = Math.floor((sn % 3600) / 60); return `${s ? `${s}:${iki(d)}` : d}:${iki(sn % 60)}`; };
  const simdiKat = (d) => kategori({ kaynak: d.kaynak, uygulama: (d.oynayan && d.oynayan.uygulama) || (d.kaynak === 'canli' ? null : d.uygulamaAdi) });
  /** Ajanın izleme kaydındaki program metniyle aynı biçim (YouTube bağlantısı bu metinle eşlenir). */
  const oynayanMetni = (o) => {
    const dizi = o.dizi ? `${o.dizi}${o.sezon ? ` S${o.sezon}` : ''}${o.bolum ? `B${o.bolum}` : ''}` : null;
    const ad = [dizi, o.baslik].filter(Boolean).join(' — ');
    return ad ? `${ad}${o.sanatci && !o.dizi ? ` (${o.sanatci})` : ''}` : null;
  };
  function programIlerleme(p) {
    if (!p || !p.bas || !p.bit) return null;
    const dk = (x) => { const [h, m] = String(x).split(':').map(Number); return h * 60 + m; };
    const t = Saat.parca(Date.now());
    let b = dk(p.bas); let e = dk(p.bit); let n = t.sa * 60 + t.dk;
    if (![b, e, n].every(Number.isFinite)) return null;
    if (e <= b) e += 1440;
    if (n < b) n += 1440;
    return Math.min(1, Math.max(0, (n - b) / (e - b)));
  }
  function simdiCiz() {
    const kap = $('simdi');
    kap.replaceChildren();
    $('simdiSaat').textContent = L('{saat} itibarıyla', { saat: trSaat(Date.now()) });
    const bugunKs = S.bugun ? S.bugun.kesitler : [];
    if (!S.tvDurum.length) { kap.append(el('div', 'bos', L('TV durumu alınamadı.'))); return; }
    for (const d of S.tvDurum) {
      const kart = el('section', 'tv-kart glass');
      const ust = el('div', 'tv-ust');
      ust.append(el('div', 'tv-ad', `${d.kilit ? '🔒 ' : ''}${d.ad || d.id}`));
      const tvKs = bugunKs.filter((k) => k.tv === d.id);
      if (!d.acik) {
        ust.append(el('span', 'hap', L('Kapalı')));
        const son = tvKs[tvKs.length - 1];
        kart.append(ust, el('div', 'kapali-ne', L('TV kapalı')),
          el('div', 'simdi-alt', son
            ? L("Bugün en son {saat}'e kadar açıktı — {ne}", { saat: trSaat(Math.max(...tvKs.map((k) => k.bit))), ne: `${katAdi(son.kat)}${son.kanal ? ` · ${kanalAdi(son)}` : ''}` })
            : L('Bugün hiç açılmadı.')));
        kap.append(kart);
        continue;
      }
      const kat = simdiKat(d);
      const o = d.oynayan || null;
      kart.style.setProperty('--vurgu', renk(kat));
      const oynamiyor = !!o && !['playing', 'loading', 'seeking'].includes(o.durum);
      if (oynamiyor) kart.style.setProperty('--vurgu', '#6b6b7e');
      ust.append(el('span', oynamiyor ? 'hap' : 'hap acik', !o ? katAdi(kat) : oynamiyor ? (o.durum === 'paused' ? `⏸ ${L('Duraklatıldı')}` : `⏸ ${L('Oynamıyor')}`) : `▶ ${katAdi(kat)}`));
      kart.append(ust);
      const ne = el('div', 'simdi-ne');
      ne.append(kaynakIkonu(kat, 24));
      const altlar = [];
      let ilerleme = null;
      if (d.kaynak === 'canli' && d.kanal) {
        ne.append(el('span', 'metin', d.kanal.ad || L('Kanal {no}', { no: d.kanal.no })));
        const p = d.kanal.program;
        if (p && p.ad) { altlar.push(`${p.ad}${p.bas && p.bit ? ` · ${p.bas}–${p.bit}` : ''}`); ilerleme = programIlerleme(p); }
      } else if (o && o.baslik) {
        const metin = oynayanMetni(o);
        ne.append(el('span', 'metin', o.dizi ? metin : o.baslik));
        if (ytMi(kat, metin)) ne.append(ytBag(metin));
        if (o.sanatci && !o.dizi) altlar.push(o.sanatci);
        if (o.konum != null && o.sure) { altlar.push(`${dkSn(o.konum)} / ${dkSn(o.sure)}`); ilerleme = o.konum / o.sure; }
      } else {
        ne.append(el('span', 'metin', o && o.tahmin ? TANIMSIZ : kat === 'Apple TV' ? L('Apple TV ana ekranı') : katAdi(kat)));
        if (o && o.tahmin) altlar.push(L('oynatılıyor — uygulama tanımlanamadı'));
        else if (o && o.durum === 'playing') altlar.push(L('oynatılıyor — uygulama başlık bilgisi vermiyor'));
      }
      if (d.ekranKapali) altlar.push(L('ekran kapalı (yalnız ses)'));
      kart.append(ne);
      if (altlar.length) kart.append(el('div', 'simdi-alt', altlar.join(' · ')));
      if (ilerleme != null) {
        const b = el('div', 'ilerleme');
        const i = el('i');
        i.style.width = `${Math.round(ilerleme * 100)}%`;
        b.append(i);
        kart.append(b);
      }
      const acikKesit = tvKs.filter((k) => k.acik).pop();
      const tvToplam = tvKs.reduce((a, k) => a + (k.bit - k.bas), 0);
      const dip = el('div', 'simdi-dip');
      dip.append(el('span', null, acikKesit ? L("{saat}'den beri ({sure})", { saat: trSaat(acikKesit.bas), sure: sure(Date.now() - acikKesit.bas) }) : ''),
        el('span', null, tvToplam ? L('bugün {sure} açık', { sure: sure(tvToplam) }) : ''));
      kart.append(dip);
      kap.append(kart);
    }
  }

  /** Saatlik grafik: 24 sütun, her biri o saatte kaç dk; renkli izlenen, gri soluk pasif. */
  function saatGrafigi(tks, gun) {
    const saatler = Array.from({ length: 24 }, () => new Map());
    // Saat başları bölgedeki duvar saatiyle (yaz saati geçişinde gün 23/25 saat olabilir).
    const [y, m, d] = gun.split('-').map(Number);
    const baslar = Array.from({ length: 25 }, (_, h) => (h < 24 ? Saat.yerelAn(y, m, d, h, 0) : gunBasi(gunEkle(gun, 1))));
    for (const k of tks) {
      for (let h = 0; h < 24; h++) {
        const ms = Math.min(k.bit, baslar[h + 1]) - Math.max(k.bas, baslar[h]);
        if (ms > 0) saatler[h].set(tur(k), (saatler[h].get(tur(k)) || 0) + ms);
      }
    }
    const sira = topla(tks, tur).map(([k]) => k).filter((k) => k !== PASIF);   // en çok izlenen altta
    const kap = el('div', 'sg');
    const alan = el('div', 'sg-alan');
    for (const [oran, ad] of [[0, L('60 dk')], [0.5, L('30 dk')]]) {
      const c = el('div', 'sg-cizgi');
      c.style.top = `${oran * 100}%`;
      c.append(el('span', null, ad));
      alan.append(c);
    }
    saatler.forEach((mp, h) => {
      const sutun = el('div', 'sg-sutun');
      sutun.dataset.ipucu = '1';
      for (const kat of [...sira, PASIF]) {
        const ms = mp.get(kat);
        if (!ms) continue;
        const i = el('i');
        i.style.height = `${Math.min(100, (ms / 3600e3) * 100)}%`;
        i.style.background = kat === PASIF ? PASIF_SOLUK : renk(kat);
        sutun.append(i);
      }
      const izlenen = [...mp].filter(([k]) => k !== PASIF).reduce((a, [, v]) => a + v, 0);
      const bilgi = [`${iki(h)}:00 – ${iki((h + 1) % 24)}:00`,
        mp.size ? L('izlendi {sure}', { sure: sure(izlenen) }) + (mp.get(PASIF) ? ` · ${L('pasif {sure}', { sure: sure(mp.get(PASIF)) })}` : '') : L('kapalı'),
        ...sira.filter((k) => mp.get(k)).map((k) => `${katAdi(k)}: ${sure(mp.get(k))}`)];
      sutun.addEventListener('pointerenter', (e) => ipucuGoster(e, bilgi));
      sutun.addEventListener('pointerdown', (e) => ipucuGoster(e, bilgi));
      sutun.addEventListener('pointerleave', () => { ipucu.hidden = true; });
      alan.append(sutun);
    });
    const eksen = el('div', 'sg-eksen');
    for (const h of [0, 6, 12, 18]) { const x = el('span', null, iki(h)); x.style.left = `${(h / 24) * 100}%`; eksen.append(x); }
    const lejant = el('div', 'sg-lejant');
    for (const kat of [...sira, ...(tks.some((k) => k.pasif) ? [PASIF] : [])]) {
      const l = el('span');
      const n = el('span', 'nokta');
      n.style.background = kat === PASIF ? PASIF_SOLUK : renk(kat);
      l.append(n, document.createTextNode(kat === PASIF ? L('Pasif (duraklatılmış / bekleme)') : katAdi(kat)));
      lejant.append(l);
    }
    kap.append(alan, eksen, lejant);
    return kap;
  }

  /** Kesitleri anahtara göre toplar → [{ ad, ms, son, acik }], seçili sıraya göre (en yeni: son izleme; en uzun: süre). */
  function grupla(ks, anahtar) {
    const m = new Map();
    for (const k of ks) {
      const a = anahtar(k);
      if (a == null) continue;
      const g = m.get(a) || { ad: a, ms: 0, son: 0, acik: false };
      g.ms += k.bit - k.bas;
      g.son = Math.max(g.son, k.bit);
      g.acik = g.acik || !!k.acik;
      m.set(a, g);
    }
    return [...m.values()].sort(S.sira === 'yeni' ? (x, y) => y.son - x.son || y.ms - x.ms : (x, y) => y.ms - x.ms);
  }

  /** "+N daha" bağlantısı: gizli satırları açar. */
  function dahaBaglantisi(liste, kalan) {
    const dd = el('div', 'daha', L('+{n} daha', { n: kalan }));
    dd.addEventListener('click', () => { for (const x of liste.querySelectorAll('[hidden]')) x.hidden = false; dd.remove(); });
    return dd;
  }

  /** Gruplamasız liste: her içerik (kanal / video / bölüm) tek satır, kaynak ikonu solda, seçili sıraya göre. */
  function duzListe(kart, aktif) {
    const icerik = (k) => (k.kat === 'Canlı TV' ? kanalAdi(k) : icerikAdi(k));
    const ogeler = grupla(aktif, (k) => `${k.kat}\u0000${icerik(k)}`);
    if (!ogeler.length) return;
    const enCok = Math.max(...ogeler.map((o) => o.ms));
    const liste = el('div', 'ogeler duz');
    const SINIR = 8;
    ogeler.forEach((o, i) => {
      const [kat, ad] = o.ad.split('\u0000');
      const zaman = S.sira === 'yeni' ? (o.acik ? L('şimdi') : trSaat(o.son)) : null;
      const parca = [satir(ad, o.ms, enCok, renk(kat), null, ytMi(kat, ad) ? ytBag(ad) : null, kat, zaman)];
      if (kat === 'Canlı TV') {
        const progs = grupla(aktif.filter((k) => k.kat === kat && kanalAdi(k) === ad && k.program), (k) => k.program).map((p) => `${p.ad} (${sure(p.ms)})`);
        if (progs.length) parca.push(el('div', 'prog', progs.join(' · ')));
      }
      for (const x of parca) { if (i >= SINIR) x.hidden = true; liste.append(x); }
    });
    if (ogeler.length > SINIR) liste.append(dahaBaglantisi(liste, ogeler.length - SINIR));
    kart.append(liste);
  }

  function siraCiz() {
    $('grupDugme').classList.toggle('secik', S.grup);
    $('grupDugme').setAttribute('aria-pressed', String(S.grup));
    for (const b of document.querySelectorAll('#siraSecim button')) {
      b.classList.toggle('secik', b.dataset.sira === S.sira);
      b.setAttribute('aria-checked', String(b.dataset.sira === S.sira));
    }
  }

  /** Seçili günün (00:00–23:59) her TV'si için: toplam, saatlik grafik, kaynak → kanal/video kırılımı. */
  function bugunCiz() {
    const kap = $('bugun');
    kap.replaceChildren();
    const v = S.gunVeri;
    const ks = v ? v.kesitler : [];
    const bugunMu = S.gunGorunum === trGun(Date.now());
    for (const t of S.tvler) {
      const tks = ks.filter((k) => k.tv === t.id);
      const kart = el('section', 'tv-kart glass');
      const ust = el('div', 'tv-ust');
      ust.append(el('div', 'tv-ad', t.ad));
      kart.append(ust);
      if (!tks.length) { kart.append(el('div', 'bos', bugunMu ? L('Bugün açılmadı.') : L('Bu gün açılmadı.'))); kap.append(kart); continue; }
      const tt = tks.reduce((a, k) => a + (k.bit - k.bas), 0);
      const iz = izlenenMs(tks);
      const son = tks.some((k) => k.acik) ? L('şimdi') : trSaat(Math.max(...tks.map((k) => k.bit)));
      const ozet = el('div', 'bugun-toplam');
      ozet.append(el('b', null, sure(iz)), el('span', null, L('izlendi')));
      kart.append(ozet, el('div', 'bugun-ozet', `${L('{sure} açık', { sure: sure(tt) })}${tt !== iz ? ` · ${L('{sure} pasif', { sure: sure(tt - iz) })}` : ''} · ${trSaat(tks[0].bas)}–${son}`));
      kart.append(saatGrafigi(tks, S.gunGorunum));
      if (!S.grup) duzListe(kart, tks.filter((k) => !k.pasif));
      else for (const { ad: kat, ms } of grupla(tks.filter((k) => !k.pasif), (k) => k.kat)) {
        const b = el('div', 'kat-baslik');
        const n = el('span', 'nokta');
        n.style.background = renk(kat);
        b.append(n, el('span', null, katAdi(kat)), el('span', 'sure', sure(ms)));
        kart.append(b);
        const grup = tks.filter((k) => !k.pasif && k.kat === kat);
        const canli = kat === 'Canlı TV';
        const ogeler = grupla(grup, canli ? kanalAdi : icerikAdi);
        const liste = el('div', 'ogeler');
        ogeler.forEach(({ ad, ms: oms, son: osn, acik: oacik }, i) => {
          // En yeni sırasında satırda en son ne zaman izlendiği de yazar.
          const zaman = S.sira === 'yeni' ? (oacik ? L('şimdi') : trSaat(osn)) : null;
          const parca = [satir(ad, oms, ms, renk(kat), null, ytMi(kat, ad) ? ytBag(ad) : null, kat, zaman)];
          if (canli) {
            const progs = grupla(grup.filter((k) => kanalAdi(k) === ad && k.program), (k) => k.program).map((p) => `${p.ad} (${sure(p.ms)})`);
            if (progs.length) parca.push(el('div', 'prog', progs.join(' · ')));
          }
          for (const x of parca) { if (i >= 5) x.hidden = true; liste.append(x); }
        });
        if (ogeler.length > 5) liste.append(dahaBaglantisi(liste, ogeler.length - 5));
        kart.append(liste);
      }
      const pasif = tt - iz;
      if (pasif > 0) {
        const b = el('div', 'kat-baslik');
        const n = el('span', 'nokta');
        n.style.background = PASIF_SOLUK;
        b.append(n, el('span', null, `⏸ ${L('Pasif — duraklatılmış / bekleme ekranı')}`), el('span', 'sure', sure(pasif)));
        kart.append(b);
      }
      const ses = tks.filter((k) => k.ekranKapali).reduce((a, k) => a + (k.bit - k.bas), 0);
      if (ses) kart.append(el('div', 'simdi-alt', L('Bunun {sure} kadarı ekran kapalı, yalnız ses.', { sure: sure(ses) })));
      kap.append(kart);
    }
  }

  function gunEtiketYaz() {
    const g = S.gunGorunum;
    const bugun = trGun(Date.now());
    $('gunBaslik').textContent = g === bugun ? L('Bugün') : g === gunEkle(bugun, -1) ? L('Dün') : L('Gün');
    $('gunEtiket').textContent = gunUzun(g);
    $('gunSonraki').disabled = g >= bugun;
    $('gunBugun').hidden = g === bugun;
  }

  async function gunYukle() {
    gunEtiketYaz();
    if (S.gunGorunum === trGun(Date.now())) { S.gunVeri = S.bugun; bugunCiz(); return; }
    $('bugun').classList.add('yukleniyor');
    try {
      const j = await getir(`/izleme?gun=${S.gunGorunum}&gunSayisi=1`);
      S.gunVeri = { bas: j.bas, bit: j.bit, kesitler: hazirla(j) };
      ytKaydet(S.gunVeri.kesitler);
      bugunCiz();
    } catch (e) {
      toast(L('Gün yüklenemedi · {hata}', { hata: e.message }));
    } finally {
      $('bugun').classList.remove('yukleniyor');
    }
  }

  async function simdiYukle() {
    const [d, b] = await Promise.allSettled([getir('/tvler'), getir(`/izleme?gun=${trGun(Date.now())}&gunSayisi=1`)]);
    if (d.status === 'fulfilled') { S.tvDurum = d.value.tvler || []; S.tvler = S.tvDurum.map((t) => ({ id: t.id, ad: t.ad })); }
    if (!S.tv && S.tvler.length) S.tv = S.tvler[0].id;   // geçmiş görünümü: her TV kendi içinde
    if (b.status === 'fulfilled') { S.bugun = { bas: b.value.bas, bit: b.value.bit, kesitler: hazirla(b.value) }; ytKaydet(S.bugun.kesitler); }
    if (d.status === 'rejected' && b.status === 'rejected') toast(L('TV bilgisi alınamadı · {hata}', { hata: d.reason.message }));
    else if (b.status === 'rejected' && !S.izlemeHatasiGosterildi) {   // ör. ajanda izleme kaydı kapalı: bir kez söyle
      S.izlemeHatasiGosterildi = true;
      toast(L('İzleme geçmişi alınamadı · {hata}', { hata: b.reason.message }));
    }
    simdiCiz();
    if (S.gunGorunum === trGun(Date.now())) { S.gunVeri = S.bugun; gunEtiketYaz(); bugunCiz(); }
  }

  // ── başlat ────────────────────────────────────────────────────────────
  for (const b of document.querySelectorAll('#aralikSecim button')) {
    b.addEventListener('click', () => { S.aralik = b.dataset.aralik; secimleriCiz(); yukle(); });
  }
  const kaydir = (yon) => {
    if (S.aralik === 'gun') S.gun = gunEkle(S.gun, yon);
    else if (S.aralik === 'hafta') S.gun = gunEkle(S.gun, 7 * yon);
    else { const [y, m] = S.gun.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + yon, 1)); S.gun = `${d.getUTCFullYear()}-${iki(d.getUTCMonth() + 1)}-01`; }
    if (S.gun > trGun(Date.now())) S.gun = trGun(Date.now());
    yukle();
  };
  $('onceki').addEventListener('click', () => kaydir(-1));
  $('sonraki').addEventListener('click', () => kaydir(1));
  $('bugunBtn').addEventListener('click', () => { S.gun = trGun(Date.now()); yukle(); });

  // Ayrıntılı geçmiş (gün/hafta/ay) yalnız istenince yüklenir.
  const gecmisAcik = () => !$('gecmis').hidden;
  $('gecmisAc').addEventListener('click', () => {
    const g = $('gecmis');
    g.hidden = !g.hidden;
    $('gecmisAc').setAttribute('aria-expanded', String(!g.hidden));
    $('gecmisAc').textContent = g.hidden ? `📊 ${L('Geçmiş — gün · hafta · ay')}` : `▴ ${L('Geçmişi gizle')}`;
    if (!g.hidden) { secimleriCiz(); if (S.veri) ciz(); else yukle(); }
  });

  // Liste sırası: en yeni → en eski (varsayılan) ya da en uzun → en kısa.
  for (const b of document.querySelectorAll('#siraSecim button')) {
    b.addEventListener('click', () => {
      S.sira = b.dataset.sira;
      try { localStorage.setItem('izleme_sira', S.sira); } catch { /* özel pencere */ }
      siraCiz();
      bugunCiz();
    });
  }
  $('grupDugme').addEventListener('click', () => {
    S.grup = !S.grup;
    try { localStorage.setItem('izleme_grup', S.grup ? '1' : '0'); } catch { /* özel pencere */ }
    siraCiz();
    bugunCiz();
  });
  siraCiz();

  // Gün seçimi (sade görünüm): her günün kendi saatlik grafiği.
  $('gunOnceki').addEventListener('click', () => { S.gunGorunum = gunEkle(S.gunGorunum, -1); gunYukle(); });
  $('gunSonraki').addEventListener('click', () => { const b = trGun(Date.now()); S.gunGorunum = S.gunGorunum >= b ? b : gunEkle(S.gunGorunum, 1); gunYukle(); });
  $('gunBugun').addEventListener('click', () => { S.gunGorunum = trGun(Date.now()); gunYukle(); });

  (async () => {
    await Saat.yukle();   // saat dilimi geçitten (gün sınırları ve saatler bu bölgeye göre)
    S.gun = trGun(Date.now());
    S.gunGorunum = S.gun;
    gunEtiketYaz();
    await simdiYukle();
  })();
  // Genişlik değişince (telefon döndürme) geçmiş grafiklerini yeniden çiz (saatlik grafik CSS ile ölçeklenir).
  let boyutT;
  window.addEventListener('resize', () => { clearTimeout(boyutT); boyutT = setTimeout(() => { if (S.veri && gecmisAcik()) ciz(); }, 150); });
  // "Şu an" 15 sn'de bir; açık geçmiş bugünü gösteriyorsa dakikada bir tazelenir.
  setInterval(() => { if (document.visibilityState === 'visible' && S.gun) simdiYukle(); }, 15000);
  setInterval(() => { if (document.visibilityState === 'visible' && S.gun && gecmisAcik() && aralik().son >= trGun(Date.now())) yukle(); }, 60000);
})();
