/* TV kumandası (ana sayfa). Sunucu: server/tvKumanda.cjs → agent/tv-ajan.mjs.
   Yerleşim: en üstte kaynak geçişi + TV seçimi; önizleme (sayfa açıkken canlı akış) ve sağında
   ⏻ · 🔇 · Ekran · Ch / Vol; ⏱ Geri dön · 💬 Mesaj · 📅 Program; favori kanallar (logo, ad, şu anki yayın,
   ilerleme); menü ve renk tuşları + 👋🏻 (mesaj, bildirimler, Detail, Engeller ve kilit, dil, çıkış). Ana
   ekranda yön tuşu yok: menüde gezinmek için TV'nin kendi kumandası ya da Ayarlar penceresi. Program tam ekran
   pencerede (yayın akışı + "başlayınca aç" + görevler), ✕ ile kapanır.
   Saatler kumandanın saat diliminde (saat.js; geçitte KUMANDA_TZ). */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  // Arayüz dili (i18n.js): kullanıcıya görünen her metin L() ile. i18n.js yüklenemezse Türkçe kalır
  // (yer tutucular yine doldurulur, 'metin|bağlam' anahtarının yalnız metni görünür).
  const L = window.L || ((m, d) => {
    if (typeof m !== 'string') return m;
    const s = m.replace(/\|[^|]*$/, '');
    return d ? s.replace(/\{(\w+)\}/g, (h, a) => (a in d ? String(d[a]) : h)) : s;
  });
  const S = {
    tvler: [], secili: null, favoriler: {}, diger: {}, epg: {}, ekranSayac: 0, aciliyor: new Set(),
    uyari: {},                                       // TV → kanal listesi o TV kapalıyken mi okundu (uyarı TV'ye bağlı)
    zaman: { gorevler: [], gecmis: [], fark: 0, yuklendi: false, hata: null },   // fark: sunucu saati − telefon saati
    canli: null,                                     // { tv, yenile } — sayfa açıkken akış
    akis: { tv: null, kanallar: {}, secili: null },  // Program penceresi: favorilerin yayın akışı
  };

  // Mesaj penceresindeki hazır mesajlar: seçilen dilde görünür ve TV'ye o dilde gider.
  const HAZIR_MESAJLAR = [L('Yemek hazır'), L('Yatma vakti'), L('Kapıya bakar mısın?'), L('Telefonuna bak'), L('Sesi biraz kısar mısın?'), L('5 dk sonra çıkıyoruz')];
  const GUN_ADLARI = ['', L('Pzt'), L('Sal'), L('Çar'), L('Per'), L('Cum'), L('Cmt'), L('Paz')];

  // ── yardımcılar ───────────────────────────────────────────────────────
  let toastT;
  // `sabit`: uzun süren iş (TV açılıyor) bitene kadar ekranda kalır; sonraki toast onu değiştirir.
  function toast(mesaj, hata, { sabit = false } = {}) {
    const t = $('toast');
    t.textContent = mesaj;
    t.className = 'toast show' + (hata ? ' error' : '');
    clearTimeout(toastT);
    if (!sabit) toastT = setTimeout(() => { t.className = 'toast'; }, hata ? 6000 : 2400);
  }

  // Komut gönderilen TV hatırlanır: açılışta ikisi de açıksa o seçilir. İmleç/ses sürüklemesi (saniyede
  // birkaç istek) ve başka TV'ye görev kurmak "son kontrol edilen TV"yi değiştirmez.
  const HATIRLANMAYAN = new Set(['/isaretci', '/ses', '/zamanlayici']);
  let sonHatirlanan = null;
  async function api(yol, govde) {
    if (govde && govde.tv && !HATIRLANMAYAN.has(yol) && govde.tv !== sonHatirlanan) { sonHatirlanan = govde.tv; hatirla.yaz('tvSonKontrol', govde.tv); }
    const r = await fetch('/api/tv' + yol, govde
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde) }
      : { cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; throw new Error(L('giriş gerekli')); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? L(String(j.error)) : 'HTTP ' + r.status);   // bilinen sunucu hataları çevrilir
    return j;
  }

  // Seçili TV tarayıcıda hatırlanır (yalnız kolaylık; kaybolursa ilk TV seçilir).
  const hatirla = {
    al(a) { try { return localStorage.getItem(a); } catch (e) { return null; } },
    yaz(a, v) { try { localStorage.setItem(a, v); } catch (e) { /* özel pencere */ } },
  };

  const seciliTv = () => S.tvler.find((t) => t.id === S.secili) || null;
  const tvAdi = (id) => (S.tvler.find((t) => t.id === id) || {}).ad || id;
  const simdiSunucu = () => Date.now() + S.zaman.fark;
  const ikiHane = (n) => String(n).padStart(2, '0');
  const sureYaz = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${ikiHane(s % 60)}`; };
  // Saat ve tarih kumandanın saat diliminde (geçitten; varsayılan Europe/Istanbul) — telefonun bölgesi değil.
  const Saat = window.Saat;
  const trSaat = (ms) => Saat.saat(ms);
  const trTarih = (ms) => Saat.gun(ms);
  const kisaTarih = (ms) => trTarih(ms).split('-').reverse().slice(0, 2).join('.');

  // ── çizim ─────────────────────────────────────────────────────────────
  function seciciCiz() {
    const nav = $('tvSecici');
    nav.innerHTML = '';
    for (const t of S.tvler) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = t.id === S.secili ? 'secili' : '';
      b.setAttribute('aria-pressed', t.id === S.secili ? 'true' : 'false');
      const n = document.createElement('span');
      n.className = 'nokta' + (t.acik ? ' acik' : '');
      // Üst satırda kaynak geçişi + seçim + Program yan yana: kısa ad olduğu gibi ("TV 1"), uzunsa ilk
      // kelimesi ("Living room" → "Living") — iki TV'nin ilk kelimesi aynıysa yine tam ad. Kilitli TV 🔒 ile.
      b.title = t.ad;
      const ilk = String(t.ad).split(/\s+/)[0];
      const ayniIlk = S.tvler.filter((x) => String(x.ad).split(/\s+/)[0] === ilk).length > 1;
      b.append(n, document.createTextNode(`${t.kilit ? '🔒 ' : ''}${String(t.ad).length <= 8 || ayniIlk ? t.ad : ilk}`));
      b.addEventListener('click', () => tvSec(t.id));
      nav.append(b);
    }
  }

  /** TV'nin o an hangi kaynakta olduğu. Ajan `kaynak` verir; eski ajan için uygulama kimliğinden. */
  function kaynakOf(t) {
    if (!t || !t.acik) return null;
    if (t.kaynak) return t.kaynak;
    if (t.uygulama === 'com.webos.app.livetv') return 'canli';
    if (/apple/i.test(t.uygulamaAdi || '')) return 'apple';
    return 'diger';
  }

  function durumCiz() {
    const t = seciliTv();
    gucCiz();
    girisCiz();
    ekranGucCiz();
    const serit = $('durumSerit');
    if (!t) serit.textContent = '';
    else if (t.kilit && !t.acik) serit.textContent = L('🔒 Kilitli — açılamaz · kilit: 👋🏻 → Engeller ve kilit');
    else if (!t.acik && S.aciliyor.has(t.id)) serit.textContent = L('Açılıyor… (30-40 sn sürebilir)');
    else if (!t.acik) serit.textContent = t.acilabilir ? L('Kapalı · kanala ya da ⏻\'a basınca açılır') : L('Kapalı');
    else if (t.ekranKapali) serit.textContent = L('Ekran kapalı · ses devam ediyor');
    else if (t.kanal) serit.textContent = `${t.kanal.ad}${t.kanal.program ? ` · ${t.kanal.program.ad}` : ''}`;
    else serit.textContent = t.uygulamaAdi || t.uygulama || '';
    for (const b of document.querySelectorAll('.kanal-btn')) {
      b.classList.toggle('aktif', !!(t && t.acik && t.kanal && Number(b.dataset.no) === t.kanal.no));
    }
    geriDonCiz();
    canliDenetle();
  }

  // Kaynak düğmesi: o anki kaynağı yazar, basınca menü açılır. TV kapalıyken de seçilebilir — ajan önce
  // açar (kanal düğmeleri gibi: düğme her durumda istenen yere götürsün).
  const KAYNAK_ADI = { canli: L('Canlı yayın'), apple: 'Apple TV', netflix: 'Netflix', prime: 'Amazon Prime', disney: 'Disney+' };
  function girisCiz() {
    const b = $('girisBtn');
    const t = seciliTv();
    const k = kaynakOf(t);
    b.classList.toggle('canli', k === 'canli');
    b.classList.toggle('apple', !!k && k !== 'canli');
    b.disabled = !t || S.girisSuruyor;
    $('girisNe').textContent = !t ? '—' : !t.acik ? (S.aciliyor.has(t.id) ? L('Açılıyor…') : L('TV kapalı')) : (KAYNAK_ADI[k] || t.uygulamaAdi || L('Uygulama'));
    $('girisAlt').textContent = S.girisSuruyor ? L('geçiliyor…') : (t && t.acik && t.cihaz === 'apple' && k !== 'apple' ? 'Apple TV ▾' : L('kaynak ▾'));
    for (const o of document.querySelectorAll('#kaynakListe [data-kaynak]')) o.classList.toggle('secik', !!t && t.acik && o.dataset.kaynak === k);
    uygulamaModuCiz(t, k);
  }
  // Uygulamadayken (Netflix, Apple TV…) favori listesinin yerine uygulama kumandası.
  function uygulamaModuCiz(t, k) {
    const mod = !!(t && t.acik && k && k !== 'canli');
    document.body.classList.toggle('uygulama-modu', mod);
    $('uygKumanda').hidden = !mod;
    const apple = mod && t.cihaz === 'apple';
    if (mod) $('uygBaslik').textContent = L('{ad} kumandası', { ad: KAYNAK_ADI[k] || t.uygulamaAdi || L('Uygulama') }) + (apple && k !== 'apple' ? ' · Apple TV' : '');
    $('uygMetin').hidden = !apple;   // arama kutusuna yazı yalnız Apple TV'de (Companion klavyesi)
  }


  // Güç düğmesi TV'nin durumuna göre: kapalıyken "Aç", açıkken "Kapat".
  function gucCiz() {
    const b = document.querySelector('[data-eylem="guc"]');
    const t = seciliTv();
    const kapali = !!t && !t.acik;
    b.classList.toggle('kapat', !kapali);
    b.classList.toggle('ac', kapali);
    b.setAttribute('aria-label', kapali ? L('TV\'yi aç') : L('TV\'yi kapat'));
    b.disabled = !!t && S.aciliyor.has(t.id);
  }

  function ekranGucCiz() {
    const b = $('ekranGucBtn');
    const t = seciliTv();
    const kapali = !!(t && t.ekranKapali);
    b.classList.toggle('ekran-kapali', kapali);
    $('ekranGucYazi').textContent = kapali ? L('aç') : L('kapat');
    b.setAttribute('aria-label', kapali ? L('Ekranı aç') : L('Ekranı kapat (ses devam eder)'));
    b.disabled = !t || !t.acik;
  }

  /** Yayının ne kadarı geçti (0-1). Rehber başlangıcı "20:00" + bitişi ms olarak verir. Sunucu saatiyle
   *  (telefon saati ileri/geri olsa da çubuk ve "program bitti" kararı kaymasın). */
  function ilerleme(p, simdi = simdiSunucu()) {
    if (!p || !p.bitis || !p.bas || !p.bit) return null;
    const dk = (x) => { const [h, m] = String(x).split(':').map(Number); return h * 60 + m; };
    const sure = ((dk(p.bit) - dk(p.bas)) + 1440) % 1440 || 1440;   // gece yarısını geçen program
    const bas = p.bitis - sure * 60000;
    return Math.min(1, Math.max(0, (simdi - bas) / (sure * 60000)));
  }

  /** Uzun yayın adı kendi alanında sola-sağa kayar; logo ve saat sabit. */
  function kaydir(prog) {
    const ic = prog.firstChild;
    const tasma = ic.scrollWidth - prog.clientWidth;
    prog.classList.toggle('kayan', tasma > 2);
    if (tasma > 2) {
      prog.style.setProperty('--kay', `-${tasma + 4}px`);
      prog.style.setProperty('--kay-sure', `${Math.max(5, tasma / 25 + 3).toFixed(1)}s`);
    }
  }

  function favorileriCiz() {
    const kap = $('favoriler');
    kap.innerHTML = '';
    const liste = S.favoriler[S.secili] || [];
    const t = seciliTv();
    const epg = S.epg[S.secili] || {};
    const progler = [];
    for (const k of liste) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kanal-btn';
      b.setAttribute('aria-label', k.ad);
      if (k.no != null) { b.dataset.no = String(k.no); b.title = L('{ad} · Kanal {no}', { ad: k.ad, no: k.no }); } else b.title = k.ad;
      // Solda logo (ad yazılmaz); logo yoksa ya da yüklenmezse ad.
      const logoKutu = document.createElement('span');
      logoKutu.className = 'logo-kutu';
      const adYaz = () => { const a = document.createElement('span'); a.className = 'logo-ad'; a.textContent = k.ad; logoKutu.replaceChildren(a); };
      if (k.logo) {
        const img = document.createElement('img');
        img.className = 'logo';
        img.src = k.logo;
        img.alt = '';
        img.onerror = adYaz;
        logoKutu.append(img);
      } else adYaz();
      const e = epg[k.ad];
      const simdi = e && e.simdi;
      // Ortada şu anki yayın — yalnız rehberde gerçekten süren program varsa; yoksa kanal adı soluk.
      const prog = document.createElement('span');
      prog.className = 'prog' + (simdi ? '' : ' bos');
      const ic = document.createElement('span');
      ic.textContent = simdi ? simdi.ad : k.ad;
      prog.append(ic);
      progler.push(prog);
      const saat = document.createElement('span');
      saat.className = 'saat';
      saat.textContent = simdi ? `${simdi.bas}–${simdi.bit}` : '';
      const cubuk = document.createElement('span');
      cubuk.className = 'cubuk';
      const dolu = document.createElement('i');
      cubuk.append(dolu);
      const oran = ilerleme(simdi);
      cubuk.hidden = oran == null;
      if (oran != null) { dolu.style.width = `${Math.round(oran * 100)}%`; cubuk.dataset.kanal = k.ad; }
      if (e && e.sonraki) b.title += ' · ' + L('Sonra {bas}: {ad}', { bas: e.sonraki.bas, ad: e.sonraki.ad });
      b.append(logoKutu, prog, saat, cubuk);
      if (t && t.acik && t.kanal && k.no === t.kanal.no) b.classList.add('aktif');
      kanalDugmesiBagla(b, k);
      kap.append(b);
    }
    requestAnimationFrame(() => progler.forEach(kaydir));
    const uy = $('favoriUyari');
    uy.hidden = !S.uyari[S.secili];
    uy.textContent = uy.hidden ? '' : L('Kanal listesi TV kapalıyken okunamıyor — basınca TV açılıp kanal açılır.');
    digerCiz();
  }

  // Diğer sık kullanılan kanallar: yalnız logo, ızgara. Basınca favorideki gibi açar (TV kapalıysa önce
  // açar). Bu TV'de bulunmayan kanalı sunucu zaten göndermez.
  function digerCiz() {
    const kap = $('digerKanallar');
    const liste = (S.diger && S.diger[S.secili]) || [];
    const t = seciliTv();
    kap.replaceChildren();
    $('digerBaslik').hidden = !liste.length;
    for (const k of liste) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kanal-btn';
      b.setAttribute('aria-label', k.ad);
      if (k.no != null) { b.dataset.no = String(k.no); b.title = L('{ad} · Kanal {no}', { ad: k.ad, no: k.no }); } else b.title = k.ad;
      const adYaz = () => { const a = document.createElement('span'); a.className = 'logo-ad'; a.textContent = k.ad; b.replaceChildren(a); };
      if (k.logo) {
        const img = document.createElement('img');
        img.className = 'logo';
        img.src = k.logo;
        img.alt = '';
        img.onerror = adYaz;
        b.append(img);
      } else adYaz();
      if (t && t.acik && t.kanal && k.no != null && k.no === t.kanal.no) b.classList.add('aktif');
      kanalDugmesiBagla(b, k);
      kap.append(b);
    }
  }

  // Çubuklar yerinde ilerler (ağ isteği yok); biten program varsa akış yeniden istenir — en çok 2 dk'da bir
  // (rehber programı geç güncellerse her 30 sn'de bütün listeyi yeniden kurmasın).
  let sonBitenYukleme = 0;
  function cubuklariGuncelle() {
    const epg = S.epg[S.secili] || {};
    const simdi = simdiSunucu();
    let biten = false;
    for (const c of document.querySelectorAll('.kanal-btn .cubuk[data-kanal]')) {
      const p = epg[c.dataset.kanal] && epg[c.dataset.kanal].simdi;
      const oran = ilerleme(p, simdi);
      if (oran != null) c.firstChild.style.width = `${Math.round(oran * 100)}%`;
      if (p && p.bitis && simdi > p.bitis) biten = true;
    }
    if (biten && S.secili && Date.now() - sonBitenYukleme > 2 * 60000) { sonBitenYukleme = Date.now(); epgYukle(S.secili); }
  }

  // ── veri ──────────────────────────────────────────────────────────────
  // Açılışta hangi TV: yalnız biri açıksa o; ikisi de açıksa (ya da hiçbiri)
  // en son komut gönderilen TV, o yoksa en son seçilen. Uygulama 10 dk'dan uzun arka planda kaldıysa
  // öne gelince yeniden karar verilir (iPhone uygulamayı kapatmadan saklar — "açış" orada da olur).
  function varsayilanTv() {
    const son = hatirla.al('tvSonKontrol') || hatirla.al('tvSecili');
    const aciklar = S.tvler.filter((t) => t.acik);
    const havuz = aciklar.length ? aciklar : S.tvler;
    return (havuz.find((t) => t.id === son) || havuz[0] || {}).id || null;
  }

  // Sıra numarası: 20 sn yoklaması, birazSonraTazele ve öne gelme aynı anda uçabilir; bir işlemden sonra
  // yazılan iyimser durumu, ondan ÖNCE başlamış bir /tvler yanıtı ezmesin (titreme).
  let durumNo = 0;
  async function durumYenile() {
    const no = ++durumNo;
    try {
      const j = await api('/tvler');
      if (no !== durumNo) return;
      S.tvler = j.tvler || [];
      const ilkSecim = !S.secili;
      if (S.otoSec || !S.tvler.some((t) => t.id === S.secili)) {
        S.otoSec = false;
        const yeni = varsayilanTv();
        if (S.secili && yeni && yeni !== S.secili) { tvSec(yeni); return; }
        S.secili = yeni;
        // İlk başarılı yanıtta liste yüklenir — açılıştaki /tvler düştüyse sonraki yoklama da getirsin.
        if (ilkSecim && yeni) favorileriYukle(yeni).then(() => epgYukle(yeni));
      }
      seciciCiz();
      durumCiz();
    } catch (e) {
      if (no === durumNo) $('durumSerit').textContent = L('TV ajanına ulaşılamadı · {hata}', { hata: e.message });
    }
  }

  async function favorileriYukle(tv, { zorla = false } = {}) {
    const onceki = S.favoriler[tv];
    if (onceki && !zorla && onceki.every((k) => k.no != null)) { favorileriCiz(); return; }
    try {
      const j = await api('/favoriler?tv=' + encodeURIComponent(tv));
      S.favoriler[tv] = j.kanallar || [];
      S.diger[tv] = j.diger || [];
      S.uyari[tv] = !!j.uyari;
    } catch (e) {
      toast(e.message, true);
    }
    if (tv === S.secili) favorileriCiz();
  }

  async function epgYukle(tv) {
    try {
      const j = await api('/epg?tv=' + encodeURIComponent(tv));
      const m = {};
      for (const k of j.kanallar || []) m[k.ad] = k;
      S.epg[tv] = m;
    } catch (e) {
      S.epg[tv] = S.epg[tv] || {};   // akış gelmese de düğmeler çalışır
    }
    if (tv === S.secili) favorileriCiz();
  }

  async function zamanYukle() {
    try {
      zamanUygula(await api('/zamanlayici'));
    } catch (e) {
      // Kumanda yine çalışır; ama Program penceresi "henüz program yok" diye yanıltmasın.
      S.zaman.hata = e.message;
      if (!$('programPop').hidden) programCiz();
    }
  }

  function zamanUygula(j) {
    if (!j || !Array.isArray(j.gorevler)) return;
    S.zaman.gorevler = j.gorevler;
    S.zaman.gecmis = j.gecmis || [];
    S.zaman.yuklendi = true;
    S.zaman.hata = null;
    if (j.simdi) S.zaman.fark = j.simdi - Date.now();
    geriDonCiz();
    if (!$('programPop').hidden) { programCiz(); if (S.akis.tv === S.secili) akisCiz(); }
  }

  // ── önizleme: sayfa açıkken canlı akış ────────────────────────────────
  // Ekran açık olduğu sürece canlı görüntü, ayrı bir tuşa gerek kalmadan. Ajan bir akışı en çok 180 sn tutar;
  // sayfa görünür kaldıkça 170 sn'de bir yenilenir. TV kapalıyken, ekranı kapalıyken ve sayfa arka plandayken
  // akış yok (mobil veri ve TV boşuna yorulmasın).
  const AKIS_SN = 180;
  const AKIS_FPS = 0.34;   // 3 sn'de bir kare (~2,8 MB/dk)
  const AKIS_BEKLE = [4000, 8000, 16000, 60000];   // akış kopunca yeniden deneme aralıkları (geri çekilme)
  function canliDenetle() {
    const t = seciliTv();
    const olmali = !!(t && t.acik && !t.ekranKapali && document.visibilityState === 'visible');
    if (olmali && (!S.canli || S.canli.tv !== t.id)) canliBaslat(t);
    else if (!olmali) canliDurdur(t);   // akış yoksa da "TV kapalı / Ekran kapalı" yazısı güncellensin
  }
  function canliBaslat(t) {
    canliDurdur();
    const img = $('ekranImg');
    const bos = $('ekranBos');
    bos.hidden = false;
    bos.textContent = L('Ekran yükleniyor…');
    const bas = () => {
      img.src = `/api/tv/ekran-akis?tv=${encodeURIComponent(t.id)}&sn=${AKIS_SN}&fps=${AKIS_FPS}&t=${Date.now()}`;
    };
    S.canli = { tv: t.id, yenile: setInterval(bas, (AKIS_SN - 10) * 1000), hata: 0, tekrarT: null };
    img.onload = () => { bos.hidden = true; img.classList.remove('yukleniyor'); if (S.canli) S.canli.hata = 0; };
    img.onerror = () => {   // akış koptu: artan aralıklarla yeniden dene (durum yoklaması da düzeltir)
      const c = S.canli;
      if (!c || c.tv !== t.id) return;
      c.hata++;
      if (c.hata >= 2) { bos.hidden = false; bos.textContent = L('Önizleme alınamadı · yeniden deneniyor'); }
      clearTimeout(c.tekrarT);
      c.tekrarT = setTimeout(() => { if (S.canli === c) bas(); }, AKIS_BEKLE[Math.min(c.hata, AKIS_BEKLE.length) - 1]);
    };
    bas();
  }
  function canliDurdur(t) {
    if (S.canli) { clearInterval(S.canli.yenile); clearTimeout(S.canli.tekrarT); }
    S.canli = null;
    const img = $('ekranImg');
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');                    // akış bağlantısını kapatır
    const bos = $('ekranBos');
    bos.hidden = false;
    bos.textContent = !t ? '' : !t.acik ? L('TV kapalı') : t.ekranKapali ? L('Ekran kapalı') : '';
    if (!bos.textContent) bos.hidden = true;
  }

  // Bir işlemden sonra durum kısa gecikmeyle tazelenir (art arda basışlarda bir kez).
  let tazeT;
  function birazSonraTazele(ms = 1400) {
    clearTimeout(tazeT);
    tazeT = setTimeout(durumYenile, ms);
  }

  // ── eylemler ──────────────────────────────────────────────────────────
  async function tvSec(id) {
    if (id === S.secili) return;
    S.secili = id;
    hatirla.yaz('tvSecili', id);
    seciciCiz();
    $('ekranBos').hidden = false;
    $('ekranBos').textContent = L('Ekran yükleniyor…');
    durumCiz();                                    // akışı yeni TV'ye taşır
    favorileriCiz();
    favorileriYukle(id).then(() => epgYukle(id));
  }

  async function tusGonder(tus, cihaz = null) {
    if (!S.secili) return;
    try {
      await api('/tus', { tv: S.secili, tus, ...(cihaz ? { cihaz } : {}) });
      if (/^VOLUME/.test(tus) && acikPop === 'chvolPop') { clearTimeout(SES.okuT); SES.okuT = setTimeout(sesOku, 400); }
      birazSonraTazele();
    } catch (e) {
      toast(e.message, true);
      birazSonraTazele(500);   // basılı tutmada her hata ayrı bir durum sorgusu açmasın
    }
  }

  // ── İkinci doğrulama ─────────────────────────────────────────────────────
  // Kapalı TV'yi açacak her komut 22:00–07:00 arasında (kumandanın saat dilimiyle) onay ister — gece
  // yanlışlıkla açılmasın; gündüz sormaz. Kapatma her zaman onay ister.
  const geceSaatiMi = (saat) => saat >= 22 || saat < 7;
  const trSaatNo = (ms) => Saat.saatNo(ms);
  let onayBitir = null;   // açık onay kutusunun kapatıcısı (Esc ve yeni onay için)
  function onayIste({ baslik, metin = '', evet = L('Evet'), tehlike = false }) {
    if (onayBitir) onayBitir(false);   // önceki onayın sözü askıda kalmasın
    return new Promise((coz) => {
      $('onayBaslik').textContent = baslik;
      $('onayMetin').textContent = metin;
      $('onayEvet').textContent = evet;
      $('onayEvet').classList.toggle('tehlike', tehlike);
      $('onayKap').hidden = false;
      const bitir = (v) => {
        if (onayBitir !== bitir) return;
        onayBitir = null;
        $('onayKap').hidden = true;
        $('onayEvet').onclick = $('onayHayir').onclick = $('onayKap').onclick = null;
        coz(v);
      };
      onayBitir = bitir;
      $('onayEvet').onclick = () => bitir(true);
      $('onayHayir').onclick = () => bitir(false);
      $('onayKap').onclick = (e) => { if (e.target === $('onayKap')) bitir(false); };
      $('onayHayir').focus();
    });
  }
  /** Kapalı TV'yi şimdi açacak komuttan önce: gece ise onay. */
  async function acmaOnayi(t, ne) {
    if (!t || t.acik || !geceSaatiMi(trSaatNo(simdiSunucu()))) return true;
    return onayIste({ baslik: L('{ad} kapalı — açılsın mı?', { ad: t.ad }), metin: L('Gece saati (22:00–07:00). {ne} için TV açılacak.', { ne }), evet: L('Aç') });
  }
  /** "TV kapalıysa aç" görevi gece çalışacaksa kurmadan önce onay. `saat`: görevin çalışacağı saat (0-23). */
  async function gorevOnayi(tvId, saat, saatYazi, tvKapaliysa) {
    if (tvKapaliysa !== 'ac' || !geceSaatiMi(saat)) return true;
    return onayIste({ baslik: L('Gece saatinde görev'), metin: L('Çalışma zamanı: {zaman}. O sırada {tv} kapalıysa açılacak.', { zaman: saatYazi, tv: tvAdi(tvId) }), evet: L('Kur') });
  }

  // Kanal düğmesi her durumda o kanalı açar: TV kapalıysa ajan önce açar, sonra kanalı açar.
  async function kanalAc(ad, dugme) {
    const t = seciliTv();
    if (!t) return;
    if (S.aciliyor.has(t.id)) { toast(L('{ad} açılıyor…', { ad: t.ad })); return; }   // ikinci uzun istek uçmasın
    if (!(await acmaOnayi(t, ad))) return;
    const kapali = !t.acik;
    dugme && dugme.classList.add('basildi');
    if (kapali) { uyanmaBasla(t.id); toast(L('{tv} açılıyor, {ne} açılacak…', { tv: t.ad, ne: ad }), false, { sabit: true }); }
    try {
      const j = await api('/kanal', { tv: t.id, ad });
      toast(`${j.kanal.acildi ? L('{ad} açıldı', { ad: t.ad }) + ' · ' : ''}${j.kanal.no} · ${j.kanal.ad}`);
      // Ajan "açıldı" dediyse durum sorgusunu beklemeden göster (yoksa birkaç sn "Kapalı" kalıyor).
      tvGuncelle(t.id, { acik: true, kaynak: 'canli', ekranKapali: false, kanal: { no: j.kanal.no, ad: j.kanal.ad, program: null } });
      if (j.kanal.acildi) favorileriYukle(t.id, { zorla: true });
      birazSonraTazele(j.kanal.acildi ? 3000 : 1800);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (kapali) uyanmaBitti(t.id);
      dugme && setTimeout(() => dugme.classList.remove('basildi'), 200);
    }
  }

  // Bekleme sırasında durum yoklaması S.tvler'i yeni nesnelerle değiştirmiş olabilir: kimlikle bul.
  function tvGuncelle(id, alanlar) {
    const g = S.tvler.find((x) => x.id === id);
    if (g) Object.assign(g, alanlar);
    seciciCiz();
    durumCiz();
  }

  function uyanmaBasla(id) { S.aciliyor.add(id); durumCiz(); }
  function uyanmaBitti(id) { S.aciliyor.delete(id); durumCiz(); }

  async function ac() {
    const t = seciliTv();
    if (!t || S.aciliyor.has(t.id)) return;
    if (!(await acmaOnayi(t, L('Güç tuşu')))) return;
    uyanmaBasla(t.id);
    toast(L('{ad} açılıyor…', { ad: t.ad }), false, { sabit: true });
    try {
      const j = await api('/ac', { tv: t.id });
      toast(j.uyandirildi ? L('{ad} açıldı', { ad: t.ad }) : L('{ad} zaten açık', { ad: t.ad }));
      tvGuncelle(t.id, { acik: true });
      favorileriYukle(t.id, { zorla: true });
      birazSonraTazele(3000);
    } catch (e) {
      toast(e.message, true);
    } finally {
      uyanmaBitti(t.id);
    }
  }

  async function kaynakSec(hedef) {
    const t = seciliTv();
    popKapat();
    if (!t || S.girisSuruyor) return;
    if (S.aciliyor.has(t.id)) { toast(L('{ad} açılıyor…', { ad: t.ad })); return; }
    if (t.acik && kaynakOf(t) === hedef) return;
    if (!(await acmaOnayi(t, KAYNAK_ADI[hedef]))) return;
    const kapali = !t.acik;
    S.girisSuruyor = true;
    if (kapali) { uyanmaBasla(t.id); toast(L('{tv} açılıyor, {ne} açılacak…', { tv: t.ad, ne: KAYNAK_ADI[hedef] }), false, { sabit: true }); }
    girisCiz();
    try {
      const j = await api('/giris', { tv: t.id, hedef });
      tvGuncelle(t.id, {
        acik: true, ekranKapali: false,
        cihaz: j.cihaz || (hedef === 'apple' ? 'apple' : 'lg'),
        kaynak: j.kaynak || hedef,
        uygulama: j.uygulama || null,
        uygulamaAdi: KAYNAK_ADI[hedef],
        kanal: hedef === 'canli' ? t.kanal : null,
      });
      if (j.not) toast(L(String(j.not)), true);
      else toast(`${KAYNAK_ADI[hedef]}${j.cihaz === 'apple' && hedef !== 'apple' ? ' · Apple TV' : ''}`);
      birazSonraTazele(hedef === 'canli' ? 1800 : 3500);
    } catch (e) {
      toast(e.message, true);
    } finally {
      if (kapali) uyanmaBitti(t.id);
      S.girisSuruyor = false;
      durumCiz();
    }
  }


  // Ekranı kapat, ses açık. Tekrar basınca ekran açılır.
  async function ekranGucDegistir() {
    const t = seciliTv();
    if (!t || !t.acik) return;
    const kapali = !t.ekranKapali;
    try {
      await api('/ekran-guc', { tv: t.id, kapali });
      tvGuncelle(t.id, { ekranKapali: kapali });
      toast(kapali ? L('Ekran kapatıldı · ses devam ediyor') : L('Ekran açıldı'));
    } catch (e) {
      toast(e.message, true);
    }
  }

  function guc() {
    const t = seciliTv();
    if (!t) return;
    if (t.acik) kapat(); else ac();
  }

  async function kapat() {
    const t = seciliTv();
    if (!t) return;
    if (!(await onayIste({ baslik: L('{ad} kapatılsın mı?', { ad: t.ad }), evet: L('Kapat|güç'), tehlike: true }))) return;
    try {
      await api('/kapat', { tv: t.id });
      toast(L('{ad} kapatıldı', { ad: t.ad }));
      tvGuncelle(t.id, { acik: false });
      birazSonraTazele(2500);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ── ⏱ Geri dön (reklam arası) ─────────────────────────────────────────
  const seciliGeriDon = () => S.zaman.gorevler.find((g) => g.tur === 'geri-don' && g.tv === S.secili) || null;
  const kanalYaz = (k) => (k && (k.ad || (k.no != null ? L('Kanal {no}', { no: k.no }) : null))) || '—';
  let geriDonT;
  // Vakti geçen sayaç için TEK bekleyen tazeleme. Ajan TV'yi uyandırıp kanalı doğrularken görev bir süre
  // listede kalır; her çizimde yeni bir zamanlayıcı kurulsaydı her tazeleme iki yenisini doğurur, istekler
  // saniyeler içinde binlere çıkardı. Ajan hâlâ çalışıyorsa aralık 1,5 → 3 → 6 … en çok 15 sn.
  let gdTazeT = null;
  let gdGecikme = 1500;

  function geriDonCiz() {
    const g = seciliGeriDon();
    $('gdBant').hidden = !g;
    clearInterval(geriDonT);
    if (!g) gdGecikme = 1500;
    if (g) {
      $('gdKanal').textContent = kanalYaz(g.kanal);
      const isle = () => {
        const kalan = g.an - simdiSunucu();
        $('gdKalan').textContent = kalan > 0 ? sureYaz(kalan) : L('dönülüyor…');
        if (kalan < -4000) {
          clearInterval(geriDonT);
          if (!gdTazeT) {
            gdTazeT = setTimeout(() => { gdTazeT = null; zamanYukle(); durumYenile(); }, gdGecikme);
            gdGecikme = Math.min(15000, gdGecikme * 2);
          }
        }
      };
      isle();
      geriDonT = setInterval(isle, 1000);
    }
    // Son 3 dk içinde biten sayacın sonucu (bu TV için).
    const son = S.zaman.gecmis.find((x) => x.tur === 'geri-don' && x.tv === S.secili);
    const sonuc = $('gdSonuc');
    const yeni = !!(son && simdiSunucu() - son.bitti < 3 * 60000 && !g);
    sonuc.hidden = !yeni;
    if (yeni) {
      const ne = kanalYaz(son.kanal);
      sonuc.textContent = {
        ok: '✓ ' + L('{ne} kanalına dönüldü', { ne }),
        atlandi: L('TV kapalıydı, dönülmedi'),
        iptal: L('Geri dön iptal edildi'),
        hata: '✗ ' + L('Dönülemedi: {neden}', { neden: son.neden ? L(String(son.neden)) : '' }),
        kacirildi: '⚠ ' + L('Vakit kaçırıldı (ajan çalışmıyordu)'),
      }[son.sonuc] || son.sonuc;
    }
    const t = seciliTv();
    const canli = !!(t && t.acik && kaynakOf(t) === 'canli' && t.kanal);
    $('gdHedef').textContent = canli ? L('{kanal}: kaç dakika sonra bu kanala dönülsün?', { kanal: t.kanal.ad }) : L('Önce Canlı TV\'de dönülecek kanalı açın.');
    for (const c of document.querySelectorAll('#gdCipler .cip')) c.disabled = !canli;
    $('gdBaslat').disabled = !canli;
  }

  // Dakika tekerleği (1-120): kaydırınca ortadaki değer seçilir; hızlı seçim çipleri tekerleği oraya kaydırır.
  // Değer basış anında kaydırma konumundan okunur (tekerOku): kayma sürerken "Başlat"a basılırsa ortada
  // görünen değer gitsin, 80 ms önce durulmuş olan değil.
  const TEKER_SATIR = 36;
  let tekerDk = Number(hatirla.al('gdDk')) || 5;
  function tekerKur() {
    const tk = $('gdTeker');
    if (!tk.childElementCount) {
      for (let d = 1; d <= 120; d++) { const x = document.createElement('div'); x.textContent = d; tk.append(x); }
      let t2;
      tk.addEventListener('scroll', () => {
        clearTimeout(t2);
        t2 = setTimeout(() => {
          tekerDk = Math.min(120, Math.max(1, Math.round(tk.scrollTop / TEKER_SATIR) + 1));
          tekerIsaretle();
        }, 80);
      });
    }
    tk.scrollTop = (tekerDk - 1) * TEKER_SATIR;
    tekerIsaretle();
  }
  function tekerIsaretle() {
    const tk = $('gdTeker');
    [...tk.children].forEach((x, i) => x.classList.toggle('secik', i + 1 === tekerDk));
    cipSec('gdCipler', (c) => Number(c.dataset.dk) === tekerDk);
  }
  function tekerOku() {
    const tk = $('gdTeker');
    if (tk.childElementCount) tekerDk = Math.min(120, Math.max(1, Math.round(tk.scrollTop / TEKER_SATIR) + 1));
    return tekerDk;
  }
  function tekerGit(dk) {
    tekerDk = dk;
    $('gdTeker').scrollTo({ top: (dk - 1) * TEKER_SATIR, behavior: 'smooth' });
    tekerIsaretle();
  }

  async function geriDonKur(dk) {
    const t = seciliTv();
    if (!t) return;
    hatirla.yaz('gdDk', String(dk));
    popKapat();
    try {
      const j = await api('/zamanlayici', { islem: 'geri-don', tv: t.id, dk });
      zamanUygula(j);
      toast(L('{dk} dk sonra {kanal} açılacak', { dk, kanal: (j.sonuc && j.sonuc.kanal && j.sonuc.kanal.ad) || L('bu kanal') }));
    } catch (e) {
      toast(e.message, true);
    }
  }

  async function zamanIslem(islem, id, ek = {}) {
    if (islem === 'hemen') {   // "şimdi çalıştır": görev kapalı TV'yi açacaksa gece onay ister
      const g = S.zaman.gorevler.find((x) => x.id === id);
      const t = g && S.tvler.find((x) => x.id === g.tv);
      if (g && g.tvKapaliysa === 'ac' && !(await acmaOnayi(t, (g.kanal && g.kanal.ad) || L('Görev')))) return null;
    }
    try {
      const j = await api('/zamanlayici', { islem, ...(id ? { id } : {}), ...ek });
      zamanUygula(j);
      if (islem === 'hemen') birazSonraTazele(2500);
      return j;
    } catch (e) {
      toast(e.message, true);
      return null;
    }
  }

  // ── 💬 TV'ye mesaj ─────────────────────────────────────────────────────
  let mesajSn = 5;
  async function mesajGonder() {
    const t = seciliTv();
    const mesaj = $('mesajMetin').value.trim();
    if (!t || !mesaj) { toast(L('Mesaj yazın ya da seçin'), true); return; }
    try {
      await api('/bildirim', { tv: t.id, mesaj, sureSn: mesajSn });
      toast(L('Mesaj {tv} ekranında ({sure})', { tv: t.ad, sure: mesajSn >= 60 ? L('1 dk') : L('{n} sn', { n: mesajSn }) }));
      $('mesajMetin').value = '';
      popKapat();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ── açılır pencereler: dışarıya dokunuş kapatır ve YUTULUR ─────────────
  // (kapatmak için bir kanala dokunan kişi kanalı yanlışlıkla değiştirmesin)
  // Pencere açıkken arkada görünmez bir perde durur (#popPerde). NEDEN: iPhone, düğme olmayan yere
  // (önizleme, boşluk, liste kenarı) dokunuşta "click" üretmiyor; yalnız belge dinleyicisine güvenen
  // yalnız belge dinleyicisi orada pencereyi kapatamaz. Perde tıklanabilir bir öğe: dokunuş ona düşer.
  let acikPop = null;
  let yut = 0;   // kapatan dokunuşun anı; ardından gelen "click" yutulur (gelmezse bayrak bayatlar)
  // ── 🔔 Bildirimler: planlı yayın başlayınca / reklam bitince / engel ve kilit olaylarında telefona
  // (/api/bildirim → server/kumanda.cjs). Geçitte VAPID anahtarı yoksa düğme "ayarlı değil" der.
  // iPhone'da web bildirimi yalnız ana ekrana eklenmiş uygulamada çalışır (iOS 16.4+).
  const BIL = { anahtar: null, kayit: null, abonelik: null, acik: false, mesgul: false };
  const bilDestek = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const b64Bayt = (s) => {
    const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  };
  async function bilApi(yol, govde) {
    const r = await fetch('/api/bildirim' + yol, govde
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(govde) }
      : { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ? L(String(j.error)) : 'HTTP ' + r.status);   // bilinen sunucu hataları çevrilir
    return j;
  }
  function bildirimCiz() {
    $('bildirimDurum').textContent = BIL.mesgul ? '…' : BIL.acik ? L('açık') : L('kapalı');
    $('bildirimBtn').classList.toggle('acik', BIL.acik);
  }
  /** Abonelik, sunucunun şu anki VAPID anahtarıyla mı yapılmış (anahtar değişince eski abonelik reddedilir). */
  function ayniAnahtarMi(abonelik) {
    try {
      const a = new Uint8Array(abonelik.options.applicationServerKey || []);
      const b = b64Bayt(BIL.anahtar || '');
      return a.length === b.length && a.every((x, i) => x === b[i]);
    } catch (e) { return true; }   // tarayıcı seçenekleri vermiyorsa eski davranış
  }
  async function bildirimHazirla() {
    try { BIL.anahtar = (await bilApi('/anahtar')).key; } catch (e) { return; }   // bildirim altyapısı yok: düğme gizli
    $('bildirimBtn').hidden = false;
    if (bilDestek()) {
      try {
        BIL.kayit = await navigator.serviceWorker.register('/kumanda-sw.js');
        BIL.abonelik = await BIL.kayit.pushManager.getSubscription();
        if (BIL.abonelik && BIL.anahtar && !ayniAnahtarMi(BIL.abonelik)) BIL.abonelik = null;   // açarken yenisi alınır
        if (BIL.abonelik && Notification.permission === 'granted') {
          BIL.acik = (await bilApi('/durum?endpoint=' + encodeURIComponent(BIL.abonelik.endpoint))).abone;
        }
      } catch (e) { /* servis çalışanı kurulamadı — düğme basınca nedenini söyler */ }
    }
    bildirimCiz();
  }
  async function bildirimDegistir() {
    if (BIL.mesgul) return;
    if (!bilDestek()) { toast(L('Bildirim için kumandayı ana ekrana ekleyin (Safari → Paylaş → Ana Ekrana Ekle) ve oradan açın.'), true); return; }
    if (!BIL.anahtar) { toast(L('Sunucuda bildirim ayarı yok'), true); return; }
    BIL.mesgul = true;
    bildirimCiz();
    try {
      if (BIL.acik) {
        if (BIL.abonelik) {
          await bilApi('/birak', { endpoint: BIL.abonelik.endpoint });
          await BIL.abonelik.unsubscribe().catch(() => {});
        }
        BIL.abonelik = null;
        BIL.acik = false;
        toast(L('Bildirimler kapatıldı'));
      } else {
        // İzin isteği dokunuşun hemen ardından gelmeli (iOS başka türlü sormaz) — önünde await yok.
        const izin = await Notification.requestPermission();
        if (izin !== 'granted') throw new Error(L('Bildirim izni verilmedi (iPhone: Ayarlar → Bildirimler → LG Remote)'));
        BIL.kayit = BIL.kayit || await navigator.serviceWorker.register('/kumanda-sw.js');
        await navigator.serviceWorker.ready;
        let mevcut = await BIL.kayit.pushManager.getSubscription();
        // Sunucunun VAPID anahtarı değiştiyse eski abonelik push servisince reddedilir: bırakılıp yenisi alınır.
        if (mevcut && !ayniAnahtarMi(mevcut)) { await mevcut.unsubscribe().catch(() => {}); mevcut = null; }
        BIL.abonelik = mevcut || await BIL.kayit.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64Bayt(BIL.anahtar) });
        const j = await bilApi('/abone', { subscription: BIL.abonelik.toJSON() });
        BIL.acik = true;
        toast(j.deneme === 'ok' ? L('Bildirimler açık — deneme bildirimi gönderildi') : L('Bildirimler açık, ama deneme bildirimi gönderilemedi'), j.deneme !== 'ok');
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      BIL.mesgul = false;
      bildirimCiz();
    }
  }

  // ── Kanala basılı tutunca: o kanalın penceresi ─────────────────────────────────
  // "Kanala git: şimdi · X dk sonra · saat SS:DD'de". iPhone'da "basınç" ayrı bir olay değil; basılı
  // tutma (Haptic Touch) aynı jest — ≈0,45 sn. Parmak kayarsa (liste kaydırma) iptal.
  const UZUN_BAS_MS = 450;
  function kanalDugmesiBagla(b, k) {
    let t = null, x0 = 0, y0 = 0;
    const iptal = () => { clearTimeout(t); t = null; };
    b.addEventListener('pointerdown', (e) => {
      x0 = e.clientX; y0 = e.clientY;
      delete b.dataset.uzun;   // önceki uzun basışın click'i hiç gelmediyse bayrak bayatlamasın (dokunuş yutulmasın)
      iptal();
      t = setTimeout(() => { t = null; b.dataset.uzun = '1'; b.classList.remove('basildi'); kanalPopAc(k); }, UZUN_BAS_MS);
    });
    b.addEventListener('pointermove', (e) => { if (t && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) iptal(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, iptal);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (b.dataset.uzun) { delete b.dataset.uzun; return; }   // basılı tutma pencereyi açtı, kanal değişmesin
      kanalAc(k.ad, b);
    });
  }

  // ── Dokunmatik yüzey: sürükleme TV imlecini oynatır, dokunma tıklar (LG Magic Remote imleci) ──
  // Hareketler biriktirilir, aynı anda tek istek uçar: ağ gecikmesi (≈0,2 sn) sıralamayı bozmasın,
  // istek yığılmasın. Parmak px → TV px kazancı hızla artar (yavaş = hassas, hızlı = uzak).
  function dokunmatikKur(pad) {
    const I = { dx: 0, dy: 0, ucuyor: false, x: 0, y: 0, bas: 0, yol: 0, t: 0, parmak: null, hataGosterildi: false };
    const gonder = () => {
      const t = seciliTv();
      if (I.ucuyor || !t) return;
      const dx = Math.round(I.dx), dy = Math.round(I.dy);
      if (!dx && !dy) return;
      I.dx -= dx; I.dy -= dy;
      I.ucuyor = true;
      api('/isaretci', { tv: t.id, dx: Math.max(-2000, Math.min(2000, dx)), dy: Math.max(-2000, Math.min(2000, dy)) })
        .catch((e) => { if (!I.hataGosterildi) { I.hataGosterildi = true; toast(e.message, true); } })   // hareket başına bir kez
        .finally(() => { I.ucuyor = false; gonder(); });
    };
    pad.addEventListener('pointerdown', (e) => {
      Object.assign(I, { x: e.clientX, y: e.clientY, bas: Date.now(), yol: 0, t: performance.now(), parmak: e.pointerId, hataGosterildi: false });
      try { pad.setPointerCapture(e.pointerId); } catch { /* parmak yüzeyden çıksa da izlenir; olmazsa yüzey içinde */ }
      pad.classList.add('basili');
    });
    pad.addEventListener('pointermove', (e) => {
      if (I.parmak !== e.pointerId) return;
      const dx = e.clientX - I.x, dy = e.clientY - I.y;
      const simdi = performance.now();
      const hiz = Math.hypot(dx, dy) / Math.max(1, simdi - I.t);   // px/ms
      I.x = e.clientX; I.y = e.clientY; I.t = simdi;
      I.yol += Math.hypot(dx, dy);
      const kazanc = 1.6 + Math.min(3, hiz * 2.5);
      I.dx += dx * kazanc; I.dy += dy * kazanc;
      gonder();
    });
    const birak = (e) => {
      if (I.parmak !== e.pointerId) return;
      I.parmak = null;
      pad.classList.remove('basili');
      if (e.type === 'pointerup' && I.yol < 8 && Date.now() - I.bas < 350) {
        const t = seciliTv();
        if (t) api('/isaretci', { tv: t.id, tikla: true }).catch((err) => toast(err.message, true));
      }
    };
    pad.addEventListener('pointerup', birak);
    pad.addEventListener('pointercancel', birak);
  }

  // Kaydırmalı seçici (iPhone alarmındaki gibi): ortadaki değer seçilir. `git` görünür olduktan sonra çağrılır.
  function tekerYap(kap, degerler, { yaz = String, degisti } = {}) {
    kap.replaceChildren(...degerler.map((v) => { const x = document.createElement('div'); x.textContent = yaz(v); return x; }));
    let i = 0;
    const isaretle = () => [...kap.children].forEach((x, k) => x.classList.toggle('secik', k === i));
    let t2;
    kap.addEventListener('scroll', () => {
      clearTimeout(t2);
      t2 = setTimeout(() => {
        i = Math.min(degerler.length - 1, Math.max(0, Math.round(kap.scrollTop / TEKER_SATIR)));
        isaretle();
        if (degisti) degisti(degerler[i]);
      }, 80);
    });
    return {
      // Basış anında kaydırma konumundan: kayma sürerken ortada görünen değer (80 ms gecikmeli olan değil).
      deger: () => (kap.offsetParent ? degerler[Math.min(degerler.length - 1, Math.max(0, Math.round(kap.scrollTop / TEKER_SATIR)))] : degerler[i]),
      git(v) { i = Math.max(0, degerler.indexOf(v)); kap.scrollTop = i * TEKER_SATIR; isaretle(); },
    };
  }

  const KP = { kanal: null, mod: null };
  const kpDk = tekerYap($('kpDkTeker'), Array.from({ length: 180 }, (_, i) => i + 1), { degisti: () => kpCiz() });
  const kpSa = tekerYap($('kpSaTeker'), Array.from({ length: 24 }, (_, i) => i), { yaz: ikiHane, degisti: () => kpCiz() });
  const kpDa = tekerYap($('kpDaTeker'), Array.from({ length: 60 }, (_, i) => i), { yaz: ikiHane, degisti: () => kpCiz() });
  const kpSaatYaz = () => `${ikiHane(kpSa.deger())}:${ikiHane(kpDa.deger())}`;
  /** Seçilen saat bugün geçtiyse yarın (kumandanın saat dilimiyle; yaz saati geçişinde de doğru gün). */
  function kpAn() {
    const bugun = trTarih(simdiSunucu());
    const [y, m, d] = bugun.split('-').map(Number);
    let an = Saat.yerelAn(y, m, d, kpSa.deger(), kpDa.deger());
    if (an <= simdiSunucu()) {
      const [y2, m2, d2] = Saat.gunEkle(bugun, 1).split('-').map(Number);
      an = Saat.yerelAn(y2, m2, d2, kpSa.deger(), kpDa.deger());
    }
    return an;
  }
  function kanalPopAc(k) {
    KP.kanal = k;
    KP.mod = null;
    const logo = $('kpLogo');
    logo.replaceChildren();
    if (k.logo) { const img = document.createElement('img'); img.className = 'logo'; img.src = k.logo; img.alt = ''; logo.append(img); }
    $('kpAd').textContent = k.ad;
    const e = (S.epg[S.secili] || {})[k.ad];
    $('kpProg').textContent = e && e.simdi ? L('Şimdi: {ad}', { ad: e.simdi.ad }) : '';
    popAc('kanalPop');
    kpCiz();
  }
  function kpModSec(mod) {
    KP.mod = KP.mod === mod ? null : mod;
    kpCiz();
    if (KP.mod === 'sonra') kpDk.git(1);   // 1 dk'dan başlar, kaydırdıkça artar
    if (KP.mod === 'saat') {                // varsayılan: 1 dk sonrası
      const p = Saat.parca(simdiSunucu() + 60000);
      kpSa.git(p.sa);
      kpDa.git(p.dk);
    }
    kpCiz();
  }
  function kpCiz() {
    $('kpSonra').hidden = KP.mod !== 'sonra';
    $('kpSaat').hidden = KP.mod !== 'saat';
    $('kpKur').hidden = !KP.mod;
    $('kpSonraBtn').classList.toggle('secik', KP.mod === 'sonra');
    $('kpSaatBtn').classList.toggle('secik', KP.mod === 'saat');
    $('kpSonraYazi').textContent = KP.mod === 'sonra' ? L('{dk} dk sonra', { dk: kpDk.deger() }) : L('X dk sonra');
    $('kpSaatYazi').textContent = KP.mod === 'saat' ? L('Saat {saat}', { saat: kpSaatYaz() }) : L('Saat SS:DD');
    if (KP.mod === 'saat') {
      const an = kpAn();
      const yarin = trTarih(an) !== trTarih(simdiSunucu());
      $('kpKur').textContent = L('Kur · {zaman}', { zaman: yarin ? L('yarın {saat}', { saat: kpSaatYaz() }) : kpSaatYaz() });
    } else if (KP.mod === 'sonra') $('kpKur').textContent = L('Kur · {zaman}', { zaman: L('{dk} dk sonra', { dk: kpDk.deger() }) });
  }
  async function kpKur() {
    const t = seciliTv();
    const k = KP.kanal;
    if (!t || !k || !KP.mod) return;
    let zaman, tarif;
    if (KP.mod === 'sonra') {
      zaman = { tur: 'sonra', dk: kpDk.deger() };
      tarif = L('{dk} dk sonra', { dk: kpDk.deger() });
    } else {
      const an = kpAn();
      zaman = { tur: 'tek', tarih: trTarih(an), saat: kpSaatYaz() };
      tarif = trTarih(an) !== trTarih(simdiSunucu()) ? L('yarın saat {saat}', { saat: kpSaatYaz() }) : L('saat {saat}', { saat: kpSaatYaz() });
    }
    const an = KP.mod === 'sonra' ? simdiSunucu() + kpDk.deger() * 60000 : kpAn();
    if (!(await gorevOnayi(t.id, trSaatNo(an), L('Saat {saat}', { saat: trSaat(an) }), 'ac'))) return;
    $('kpKur').disabled = true;
    try {
      zamanUygula(await api('/zamanlayici', { islem: 'ekle', tv: t.id, kanal: k.ad, tvKapaliysa: 'ac', zaman }));
      popKapat();
      toast(L('{kanal} · {tarif} açılacak', { kanal: k.ad, tarif }));
    } catch (e) {
      toast(e.message, true);
    } finally {
      $('kpKur').disabled = false;
    }
  }

  // ── Ses şeridi (Ch / Vol penceresi): altta 0, üstte 100. GÖRELİ: dokunulan nokta sesi değiştirmez; parmak
  // dokunduğu yerden yukarı kaydıkça ses artar, aşağı kaydıkça azalır (SES_ADIM_PX piksel = 1 kademe) — yanlışlıkla
  // şeridin tepesine dokunmak sesi 100'e fırlatmasın. Sürüklerken istekler yığılmaz: aynı anda tek istek uçar,
  // bırakınca son değer gider. Harici ses çıkışında (ajan `seviye: null`) şerit kapalı görünür.
  const SES = { deger: null, gonderilen: null, ucuyor: false, bekleyen: null, okuT: null };
  const SES_ADIM_PX = 6;
  function sesCiz() {
    const v = SES.deger;
    $('sesDolu').style.height = `${v ?? 0}%`;
    $('sesDeger').textContent = v == null ? '–' : String(v);
    $('sesSerit').setAttribute('aria-valuenow', String(v ?? 0));
  }
  async function sesOku() {
    const t = seciliTv();
    const serit = $('sesSerit');
    if (!t || !t.acik) { SES.deger = null; serit.classList.add('kapali'); sesCiz(); return; }
    try {
      const j = await api('/ses?tv=' + encodeURIComponent(t.id));
      SES.deger = Number.isInteger(j.seviye) ? j.seviye : null;
      SES.gonderilen = SES.deger;
      serit.classList.toggle('kapali', SES.deger == null);
      serit.title = SES.deger == null ? L('Harici ses çıkışı — düzey buradan ayarlanamıyor') : '';
    } catch (e) {
      SES.deger = null;
      serit.classList.add('kapali');
    }
    sesCiz();
  }
  function sesGonder(v) {
    SES.bekleyen = v;
    const t = seciliTv();
    if (SES.ucuyor || !t) return;
    const gonder = SES.bekleyen;
    SES.bekleyen = null;
    if (gonder === SES.gonderilen) return;
    SES.ucuyor = true;
    api('/ses', { tv: t.id, seviye: gonder })
      .then(() => { SES.gonderilen = gonder; })
      .catch((e) => toast(e.message, true))
      .finally(() => { SES.ucuyor = false; if (SES.bekleyen != null) sesGonder(SES.bekleyen); });
  }
  function sesSeridiKur() {
    const s = $('sesSerit');
    let parmak = null;
    let basY = 0;
    let basDeger = 0;
    const ayarla = (v) => { if (v === SES.deger) return; SES.deger = v; sesCiz(); sesGonder(v); };
    s.addEventListener('pointerdown', (e) => {
      if (s.classList.contains('kapali') || SES.deger == null) return;
      parmak = e.pointerId;
      basY = e.clientY;
      basDeger = SES.deger;
      try { s.setPointerCapture(e.pointerId); } catch { /* yüzey içinde izlenir */ }
      e.preventDefault();
    });
    s.addEventListener('pointermove', (e) => {
      if (parmak !== e.pointerId) return;
      const kademe = Math.trunc((basY - e.clientY) / SES_ADIM_PX);   // yukarı = artı
      ayarla(Math.min(100, Math.max(0, basDeger + kademe)));
    });
    const birak = (e) => { if (parmak === e.pointerId) parmak = null; };
    s.addEventListener('pointerup', birak);
    s.addEventListener('pointercancel', birak);
    s.addEventListener('keydown', (e) => {
      const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (!d || SES.deger == null || s.classList.contains('kapali')) return;
      ayarla(Math.min(100, Math.max(0, SES.deger + d)));
      e.preventDefault();
    });
  }

  function popAc(id) {
    popKapat();
    acikPop = id;
    $(id).hidden = false;
    // Pencerenin kabı perdenin üstüne çıkar; perde geri kalan her yeri örter.
    const kap = $(id).closest('.tv-ust, .ust-blok, .kumanda');
    if (kap) kap.classList.add('pop-ustte');
    $('popPerde').hidden = false;
    const b = document.querySelector(`[data-pop="${id}"]`);
    if (b) b.setAttribute('aria-expanded', 'true');
    if (id === 'gdPop') { geriDonCiz(); tekerKur(); }
    if (id === 'chvolPop') sesOku();
  }
  function popKapat() {
    if (!acikPop) return;
    $(acikPop).hidden = true;
    for (const k of document.querySelectorAll('.pop-ustte')) k.classList.remove('pop-ustte');
    $('popPerde').hidden = true;
    const b = document.querySelector(`[data-pop="${acikPop}"]`);
    if (b) b.setAttribute('aria-expanded', 'false');
    acikPop = null;
  }
  function disariDokunus(e) {
    if (!acikPop || $('onayKap').contains(e.target)) return;   // pencerenin üstündeki onay kutusu dışarısı sayılmaz
    const pop = $(acikPop);
    const b = document.querySelector(`[data-pop="${acikPop}"]`);
    if (pop.contains(e.target) || (b && b.contains(e.target))) return;
    popKapat();
    yut = Date.now();
    e.preventDefault();
    e.stopPropagation();
  }
  document.addEventListener('pointerdown', disariDokunus, true);
  // Perdeye dokunuş: pointerdown bir sebeple gelmediyse click kapatır (yutulacak bir şey kalmaz).
  $('popPerde').addEventListener('click', () => popKapat());
  document.addEventListener('click', (e) => {
    if (!yut) return;
    const taze = Date.now() - yut < 800;
    yut = 0;
    if (!taze) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (onayBitir) { onayBitir(false); return; }   // önce onay kutusu kapanır
    popKapat();
    programKapat();
  });

  // ── 📅 Program (tam ekran pencere) ──────────────────────────────────────
  const P = { tur: 'tek', gunler: [], kapali: 'ac' };

  function programAc() {
    popKapat();
    $('programPop').hidden = false;
    document.body.style.overflow = 'hidden';
    programFormuDoldur();
    programCiz();
    zamanYukle();
    akisYukle();
  }
  function programKapat() {
    if ($('programPop').hidden) return;
    $('programPop').hidden = true;
    document.body.style.overflow = '';
  }

  function programFormuDoldur() {
    const tvS = $('pTv');
    const onceki = tvS.value || S.secili;
    tvS.innerHTML = '';
    for (const t of S.tvler) { const o = document.createElement('option'); o.value = t.id; o.textContent = t.ad; tvS.append(o); }
    tvS.value = S.tvler.some((t) => t.id === onceki) ? onceki : (S.secili || '');
    const kanalS = $('pKanal');
    const onc = kanalS.value;
    const tvId = S.favoriler[tvS.value] ? tvS.value : S.secili;
    const liste = [...(S.favoriler[tvId] || []), ...(S.diger[tvId] || [])];
    kanalS.innerHTML = '';
    for (const k of liste) { const o = document.createElement('option'); o.textContent = k.ad; kanalS.append(o); }
    if (onc && liste.some((k) => k.ad === onc)) kanalS.value = onc;
    // Uygulama günlerce bellekte kalabilir: dünde kalmış tarih bugüne çekilir (ajan "geçmişte" demesin).
    const bugun = trTarih(simdiSunucu());
    $('pTarih').min = bugun;
    if (!$('pTarih').value || $('pTarih').value < bugun) $('pTarih').value = bugun;
  }

  // ── Yayın akışı (Program penceresi): favori kanalların programları, "başlayınca aç" ──
  async function akisYukle() {
    const tv = S.secili;
    if (!tv) return;
    $('akisTv').textContent = tvAdi(tv);
    try {
      const j = await api('/akis?tv=' + encodeURIComponent(tv));
      const m = {};
      for (const k of j.kanallar || []) m[k.ad] = k.programlar || [];
      S.akis = { ...S.akis, tv, kanallar: m };   // seçili kanal ve "kaydır" işareti korunur
    } catch (e) {
      $('akisListe').innerHTML = '';
      const d = document.createElement('div');
      d.className = 'bos-not';
      d.textContent = L('Yayın akışı alınamadı · {hata}', { hata: e.message });
      $('akisListe').append(d);
      return;
    }
    akisCiz();
  }

  // Kanal şeridi iki satır, yatay kayar: solda favoriler, sağda ızgaradaki kanallar.
  function akisCiz() {
    const favs = S.favoriler[S.secili] || [];
    const diger = S.diger[S.secili] || [];
    const hepsi = [...favs, ...diger];
    if (!hepsi.length) {   // kanal listesi henüz yok (ya da ayarda yalnız ızgara): "Yükleniyor…"da kalmasın
      $('akisKanallar').replaceChildren();
      const d = document.createElement('div');
      d.className = 'bos-not';
      d.textContent = L('Kanal yok');
      $('akisListe').replaceChildren(d);
      return;
    }
    const t = seciliTv();
    if (!S.akis.secili || !hepsi.some((k) => k.ad === S.akis.secili)) {
      const acik = t && t.kanal && hepsi.find((k) => k.no === t.kanal.no);   // açık kanal önce
      S.akis.secili = (acik || hepsi[0]).ad;
    }
    const seritt = $('akisKanallar');
    const kaydirma = seritt.scrollLeft;
    seritt.innerHTML = '';
    for (const grup of [favs, diger]) {
      if (!grup.length) continue;
      const g = document.createElement('div');
      g.className = 'akis-grup';
      // Satır satır dolar (üst satır listenin ilk yarısı) — ana ekrandaki sırayla aynı okunur.
      g.style.gridTemplateColumns = `repeat(${Math.ceil(grup.length / 2)}, 66px)`;
      for (const k of grup) {
        const c = document.createElement('button');
        c.type = 'button';
        c.className = 'akis-cip' + (k.ad === S.akis.secili ? ' secik' : '');
        c.title = k.ad;
        c.setAttribute('aria-label', k.ad);
        if (k.logo) { const img = document.createElement('img'); img.src = k.logo; img.alt = ''; c.append(img); } else c.textContent = k.ad;
        c.addEventListener('click', () => { S.akis.secili = k.ad; akisCiz(); });
        g.append(c);
      }
      seritt.append(g);
    }
    seritt.scrollLeft = kaydirma;   // seçim değişince şerit başa sıçramasın
    if (S.akis.kaydir) {             // kanal penceresinden "yayın akışı" ile gelindi: o kanal görünsün
      S.akis.kaydir = false;
      const ortala = () => {
        const sec = seritt.querySelector('.secik');
        if (!sec) return;
        const a = sec.getBoundingClientRect(), k = seritt.getBoundingClientRect();
        seritt.scrollLeft += (a.left + a.width / 2) - (k.left + k.width / 2);
      };
      ortala();
      requestAnimationFrame(ortala);   // pencere yeni açıldıysa yerleşim bir kare sonra kesinleşir
    }
    const liste = $('akisListe');
    liste.innerHTML = '';
    const programlar = S.akis.kanallar[S.akis.secili] || [];
    if (!programlar.length) { liste.innerHTML = '<div class="bos-not">' + L('Bu kanal için yayın akışı yok.') + '</div>'; return; }
    const simdi = simdiSunucu();
    let sonGun = null;
    for (const p of programlar) {
      const gun = gunYaz(p.bas);
      if (gun !== sonGun) { sonGun = gun; const g = document.createElement('div'); g.className = 'akis-gun'; g.textContent = gun; liste.append(g); }
      const suruyor = p.bas <= simdi && simdi < p.bit;
      const satir = document.createElement('div');
      satir.className = 'akis-satir' + (suruyor ? ' simdi' : '');
      const sa = document.createElement('span'); sa.className = 'sa'; sa.textContent = trSaat(p.bas);
      const ad = document.createElement('span'); ad.className = 'ad'; ad.textContent = p.ad;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tus';
      // Dakika düzeyinde eşleşme: görevin anı dakikaya yuvarlı, rehber saniyeli olabilir.
      const kurulu = S.zaman.gorevler.find((g) => g.tur === 'tek' && g.tv === S.secili && g.kanal && g.kanal.ad === S.akis.secili
        && Math.floor(g.an / 60000) === Math.floor(p.bas / 60000));
      if (suruyor) {
        b.textContent = '▶ ' + L('Şimdi aç');
        b.addEventListener('click', () => { programKapat(); kanalAc(S.akis.secili); });
      } else if (kurulu) {
        b.textContent = '✓ ' + L('Kurulu');
        b.classList.add('kurulu');
        b.title = L('İptal etmek için dokunun');
        b.addEventListener('click', async () => { if (confirm(L('"{ad}" için kurulu açma iptal edilsin mi?', { ad: p.ad }))) { await zamanIslem('sil', kurulu.id); akisCiz(); } });
      } else {
        b.textContent = '🔔 ' + L('Başlayınca aç');
        b.addEventListener('click', () => baslayincaAc(S.akis.secili, p));
      }
      satir.append(sa, ad, b);
      liste.append(satir);
    }
  }

  async function baslayincaAc(kanal, p) {
    if (!(await gorevOnayi(S.secili, trSaatNo(p.bas), `${gunYaz(p.bas)} ${trSaat(p.bas)}`, 'ac'))) return;
    const j = await zamanIslem('ekle', null, {
      tv: S.secili, kanal, tvKapaliysa: 'ac', etiket: String(p.ad).slice(0, 80),
      zaman: { tur: 'tek', tarih: trTarih(p.bas), saat: trSaat(p.bas) },
    });
    if (j) { toast(L('{zaman} · {program} başlayınca {kanal} açılacak', { zaman: `${gunYaz(p.bas)} ${trSaat(p.bas)}`, program: p.ad, kanal })); akisCiz(); }
  }

  function gunYaz(ms) {
    const fark = Math.round((Date.parse(trTarih(ms)) - Date.parse(trTarih(simdiSunucu()))) / 86400e3);
    return fark === 0 ? L('Bugün') : fark === 1 ? L('Yarın') : kisaTarih(ms);
  }

  // Görevin "ne"si: kanal ya da TV ekranına mesaj (ör. her gün belli saatte "yatma vakti" mesajı).
  const gorevNe = (g) => (g.mesaj ? `💬 "${g.mesaj.metin}"` : kanalYaz(g.kanal));

  function programTarif(g) {
    const ne = gorevNe(g);
    const tv = tvAdi(g.tv);
    const kapali = g.mesaj ? L('TV açıksa gösterilir') : g.tvKapaliysa === 'atla' ? L('TV kapalıysa atla') : L('TV kapalıysa açar');
    const etiket = g.etiket && !g.mesaj;
    if (g.tur === 'geri-don') return { ust: `⏱ ${ne}`, alt: `${tv} · ${L('reklamdan sonra geri dön')} · ${L('{sure} sonra', { sure: sureYaz(g.an - simdiSunucu()) })}` };
    if (g.tur === 'tek') return { ust: `${gunYaz(g.an)} ${trSaat(g.an)} · ${ne}${etiket ? ` — ${g.etiket}` : ''}`, alt: `${tv} · ${etiket ? L('program başlayınca') : L('bir kez')} · ${kapali}` };
    const g7 = (g.gunler || []).join(',');
    const gunler = g7 === '1,2,3,4,5,6,7' ? L('Her gün') : g7 === '1,2,3,4,5' ? L('Hafta içi') : g7 === '6,7' ? L('Hafta sonu') : (g.gunler || []).map((x) => GUN_ADLARI[x]).join(' ');
    return { ust: `${gunler} ${g.saat} · ${ne}`, alt: `${tv} · ${g.etkin && g.an ? L('sıradaki: {zaman}', { zaman: `${gunYaz(g.an)} ${trSaat(g.an)}` }) : L('durduruldu')} · ${kapali}` };
  }

  function programCiz() {
    const liste = $('progListe');
    const g = S.zaman.gorevler;
    liste.replaceChildren();
    const not = (m) => { const d = document.createElement('div'); d.className = 'bos-not'; d.textContent = m; return d; };
    // Ajana ulaşılamıyorsa "henüz program yok" denmez: kullanıcı görevleri silindi sanıp yenisini eklemesin.
    if (S.zaman.hata) liste.append(not(L('Program listesi alınamadı · {hata}', { hata: S.zaman.hata })));
    else if (!S.zaman.yuklendi) liste.append(not(L('Yükleniyor…')));
    else if (!g.length) liste.append(not(L('Henüz program yok. Aşağıdan ekleyin; reklam arası için 👋🏻 → Reklamdan sonra geri dön.')));
    for (const x of g) {
      const d = programTarif(x);
      const satir = document.createElement('div');
      satir.className = 'gorev' + (x.etkin === false ? ' kapali' : '');
      const ust = document.createElement('div'); ust.className = 'ust'; ust.textContent = d.ust;
      const alt = document.createElement('div'); alt.className = 'alt'; alt.textContent = d.alt;
      const ey = document.createElement('div'); ey.className = 'eylemler';
      if (x.tur === 'haftalik') {
        const ac2 = document.createElement('button');
        ac2.type = 'button'; ac2.className = 'tus'; ac2.textContent = x.etkin ? L('Durdur') : L('Başlat');
        ac2.addEventListener('click', () => zamanIslem('etkin', x.id, { acik: !x.etkin }));
        ey.append(ac2);
      }
      const sil = document.createElement('button');
      sil.type = 'button'; sil.className = 'tus'; sil.textContent = L('Sil');
      sil.addEventListener('click', () => { if (confirm(L('Bu program silinsin mi?'))) zamanIslem('sil', x.id); });
      ey.append(sil);
      satir.append(ust, alt, ey);
      liste.append(satir);
    }
    const gecmis = $('progGecmis');
    const h = S.zaman.gecmis.slice(0, 10);
    gecmis.innerHTML = h.length ? '' : '<div class="bos-not">' + L('Henüz çalışan görev yok.') + '</div>';
    for (const x of h) {
      const isaret = { ok: '✓', atlandi: '–', iptal: '×', hata: '✗', kacirildi: '⚠' }[x.sonuc] || '·';
      const ne = gorevNe(x);
      const d = document.createElement('div');
      d.className = 'gecmis-satir';
      const b = document.createElement('b');
      b.textContent = `${isaret} ${kisaTarih(x.bitti)} ${trSaat(x.bitti)} · ${ne}${x.etiket && !x.mesaj ? ` — ${x.etiket}` : ''}`;
      const ne2 = { ok: L('yapıldı'), atlandi: L('TV kapalıydı, atlandı'), iptal: L('iptal'), hata: L('hata'), kacirildi: L('kaçırıldı') }[x.sonuc] || x.sonuc;
      d.append(b, document.createTextNode(` · ${tvAdi(x.tv)} · ${ne2}${x.neden && x.sonuc !== 'ok' ? ` (${L(String(x.neden))})` : ''}`));
      gecmis.append(d);
    }
  }

  function cipSec(kapId, sec) {
    for (const c of document.querySelectorAll(`#${kapId} .cip`)) c.classList.toggle('secik', sec(c));
  }

  async function programKaydet() {
    const tv = $('pTv').value;
    const kanal = $('pKanal').value;
    const saat = $('pSaat').value;
    if (!tv || !kanal || !saat) { toast(L('TV, kanal ve saat seçin'), true); return; }
    if (P.tur === 'haftalik' && !P.gunler.length) { toast(L('En az bir gün seçin'), true); return; }
    const zaman = P.tur === 'tek' ? { tur: 'tek', tarih: $('pTarih').value, saat } : { tur: 'haftalik', saat, gunler: P.gunler };
    if (!(await gorevOnayi(tv, Number(saat.slice(0, 2)), L('Saat {saat}', { saat }), P.kapali))) return;
    const j = await zamanIslem('ekle', null, { tv, kanal, zaman, tvKapaliysa: P.kapali });
    if (j) { toast(L('Program kaydedildi')); programCiz(); }
  }

  // Basılı tutunca tekrarlayan tuşlar (ses, yön, sarma): 400 ms sonra 220 ms'de bir — ama uçuşta istek varken
  // yenisi gönderilmez. Komut 220 ms'den uzun sürerse (Apple TV köprüsü) ajanda kuyruk birikir, parmak kalktıktan
  // sonra da odak/ses "kaymaya" devam ederdi.
  function tusBagla(b) {
    const tus = b.dataset.tus;
    const tekrar = b.hasAttribute('data-tekrar');
    // Uygulama kumandası Apple TV girişindeyken tuş Apple TV'ye gider (pyatv); Ayarlar penceresi hep TV'ye.
    const hedef = () => (b.closest('#uygKumanda') && (seciliTv() || {}).cihaz === 'apple' ? 'apple' : null);
    let bekle, aralik, ucuyor = false;
    const gonder = () => {
      if (ucuyor) return;
      ucuyor = true;
      tusGonder(tus, hedef()).finally(() => { ucuyor = false; });
    };
    const bitir = () => { clearTimeout(bekle); clearInterval(aralik); b.classList.remove('basildi'); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      b.classList.add('basildi');
      gonder();
      if (tekrar) bekle = setTimeout(() => { aralik = setInterval(gonder, 220); }, 400);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, bitir);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ── başlat ────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-tus]').forEach(tusBagla);
  document.querySelector('[data-eylem="guc"]').addEventListener('click', guc);
  for (const b of document.querySelectorAll('[data-kaynak]')) b.addEventListener('click', () => kaynakSec(b.dataset.kaynak));
  $('ekranGucBtn').addEventListener('click', ekranGucDegistir);
  for (const b of document.querySelectorAll('[data-pop]')) {
    b.addEventListener('click', () => (acikPop === b.dataset.pop ? popKapat() : popAc(b.dataset.pop)));
  }
  for (const c of document.querySelectorAll('#gdCipler .cip')) c.addEventListener('click', () => tekerGit(Number(c.dataset.dk)));
  $('gdBaslat').addEventListener('click', () => geriDonKur(tekerOku()));
  $('gdAc').addEventListener('click', () => popAc('gdPop'));
  for (const b of document.querySelectorAll('[data-gd]')) {
    b.addEventListener('click', () => { const g = seciliGeriDon(); if (g) zamanIslem(b.dataset.gd, g.id, b.dataset.gd === 'uzat' ? { dk: 1 } : {}); });
  }
  for (const m of HAZIR_MESAJLAR) {
    const c = document.createElement('button');
    c.type = 'button'; c.className = 'cip'; c.textContent = m;
    c.addEventListener('click', () => { $('mesajMetin').value = m; });
    $('hazirMesajlar').append(c);
  }
  for (const c of document.querySelectorAll('#mesajSureler .cip')) {
    c.addEventListener('click', () => { mesajSn = Number(c.dataset.sn); cipSec('mesajSureler', (x) => x === c); });
  }
  $('mesajGonder').addEventListener('click', mesajGonder);
  $('programBtn').addEventListener('click', programAc);
  $('mesajAc').addEventListener('click', () => popAc('mesajPop'));
  $('bildirimBtn').addEventListener('click', bildirimDegistir);
  sesSeridiKur();
  // 🌐 Dil (👋🏻 menüsü): Türkçe ↔ English; seçim tarayıcıda saklanır, sayfa yeniden yüklenir (i18n.js).
  if (window.i18n) {
    $('dilDurum').textContent = window.i18n.dil() === 'en' ? 'English' : 'Türkçe';
    $('dilBtn').addEventListener('click', () => window.i18n.dilSec(window.i18n.dil() === 'en' ? 'tr' : 'en'));
  } else $('dilBtn').hidden = true;   // i18n.js yüklenemedi: dil değiştirilemez
  $('kpAkis').addEventListener('click', () => {
    const k = KP.kanal;
    popKapat();
    if (!k) return;
    S.akis.secili = k.ad;     // Program penceresi doğrudan bu kanalın akışıyla açılır
    S.akis.kaydir = true;
    programAc();
  });
  // Ayarlar: TV'de ayar menüsünü açar, telefonda dokunmatik yüzey + yön tuşları penceresi açılır.
  $('ayarlarBtn').addEventListener('click', () => { if (acikPop === 'ayarPop') tusGonder('MENU'); });
  dokunmatikKur($('dokunmatik'));
  $('kpSimdi').addEventListener('click', () => { const k = KP.kanal; popKapat(); if (k) kanalAc(k.ad); });
  $('kpSonraBtn').addEventListener('click', () => kpModSec('sonra'));
  // Apple TV'de odaktaki arama kutusuna yazı (uygulama kumandası)
  async function uygMetinGonder() {
    const t = seciliTv();
    const metin = $('uygMetinGir').value.trim();
    if (!t || !metin) return;
    try {
      await api('/metin', { tv: t.id, metin });
      toast(L('Yazı gönderildi'));
      $('uygMetinGir').value = '';
      $('uygMetinGir').blur();
    } catch (e) {
      toast(e.message, true);
    }
  }
  $('uygMetinGonder').addEventListener('click', uygMetinGonder);
  $('uygMetinGir').addEventListener('keydown', (e) => { if (e.key === 'Enter') uygMetinGonder(); });
  $('kpSaatBtn').addEventListener('click', () => kpModSec('saat'));
  $('kpKur').addEventListener('click', kpKur);
  $('programKapat').addEventListener('click', programKapat);
  for (const c of document.querySelectorAll('#pTur .cip')) {
    c.addEventListener('click', () => {
      P.tur = c.dataset.tur;
      cipSec('pTur', (x) => x === c);
      $('pTarihKutu').hidden = P.tur !== 'tek';
      $('pGunKutu').hidden = P.tur !== 'haftalik';
    });
  }
  for (const c of document.querySelectorAll('#pHazirGun .cip')) {
    c.addEventListener('click', () => {
      P.gunler = c.dataset.gunler.split(',').map(Number);
      cipSec('pHazirGun', (x) => x === c);
      cipSec('pGunler', (x) => P.gunler.includes(Number(x.dataset.gun)));
    });
  }
  for (const c of document.querySelectorAll('#pGunler .cip')) {
    c.addEventListener('click', () => {
      const g = Number(c.dataset.gun);
      P.gunler = P.gunler.includes(g) ? P.gunler.filter((x) => x !== g) : [...P.gunler, g].sort();
      cipSec('pGunler', (x) => P.gunler.includes(Number(x.dataset.gun)));
      cipSec('pHazirGun', (x) => x.dataset.gunler === P.gunler.join(','));
    });
  }
  for (const c of document.querySelectorAll('#pKapali .cip')) {
    c.addEventListener('click', () => { P.kapali = c.dataset.kapali; cipSec('pKapali', (x) => x === c); });
  }
  $('pTv').addEventListener('change', () => { const tv = $('pTv').value; if (!S.favoriler[tv]) favorileriYukle(tv).then(programFormuDoldur); else programFormuDoldur(); });
  $('pKaydet').addEventListener('click', programKaydet);

  (async () => {
    await Saat.yukle();   // saat dilimi geçitten (ulaşılamazsa varsayılan)
    await durumYenile();  // ilk seçimde favoriler + yayın akışı da yüklenir
    zamanYukle();
    bildirimHazirla();
  })();

  // Sayfa görünürken durum + zamanlayıcı 20 sn'de bir tazelenir.
  setInterval(() => { if (document.visibilityState === 'visible') { durumYenile(); zamanYukle(); } }, 20000);
  // Yayın akışı 5 dk'da bir (ajan rehberi günlük önbellekten okur; TV kapalıyken de gelir).
  setInterval(() => { if (document.visibilityState === 'visible' && S.secili) epgYukle(S.secili); }, 5 * 60000);
  // İlerleme çubukları 30 sn'de bir yerinde ilerler; program bitince akış hemen tazelenir.
  setInterval(() => { if (document.visibilityState === 'visible') cubuklariGuncelle(); }, 30000);
  // Sayfa arka plana geçince canlı akış durur, öne gelince yeniden başlar.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (S.gizlendi && Date.now() - S.gizlendi > 10 * 60000) S.otoSec = true;
      durumYenile();
      zamanYukle();
    } else {
      S.gizlendi = Date.now();
      canliDurdur(seciliTv());
    }
  });
})();
