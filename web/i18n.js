/* Kumanda arayüzünün dili: Türkçe / İngilizce.
   • Kaynak dil Türkçe. Sözlüğün ANAHTARI Türkçe metnin kendisidir, değeri İngilizcesi; çeviri yoksa
     Türkçe görünür (eksik anahtar arayüzü bozmaz, yalnız o metin Türkçe kalır).
   • Değişkenli metin yer tutucuyla yazılır: L('{ad} açılıyor…', { ad }) → 'Turning on {ad}…'.
   • Baştaki simge ("⏱ ", "▶ ", "🔔 ") sözlüğe yazılmaz: metnin tamamı sözlükte yoksa simge ayrılır,
     geri kalanı aranır ve simge başa geri konur.
   • Aynı Türkçe metin iki ayrı anlamda kullanılıyorsa anahtar 'metin|bağlam' yazılır ('Kapat|güç' =
     TV'yi kapat, düz 'Kapat' = pencereyi kapat). Türkçe görünüm '|' öncesidir.
   • index.html'deki metinler sayfa açılınca sayfayiCevir() ile, app.js'tekiler L() ile çevrilir.
   • Dil: localStorage 'dil' ('tr' | 'en'), yoksa tarayıcı dili Türkçe ise 'tr', değilse 'en'.
   Kod tanımlayıcıları, API yolları, kanal adları ve ajana giden değerler çevrilmez. */
'use strict';
(function () {
  const EN = {
    // ── index.html: üst satır, kaynak menüsü, TV seçimi ──
    'Kaynak seç': 'Choose source',
    'kaynak ▾': 'source ▾',
    'Canlı yayın': 'Live TV',
    'Televizyon seçimi': 'TV selection',
    'yükleniyor…': 'loading…',
    'Program': 'Schedule',

    // ── önizleme + sağ sütun ──
    'Önizleme ve ana tuşlar': 'Preview and main buttons',
    'TV ekranının görüntüsü': 'TV screen image',
    'Ekran görüntüsü yükleniyor…': 'Loading screen preview…',
    "TV'yi kapat": 'Turn TV off',
    "TV'yi aç": 'Turn TV on',
    'Sessiz': 'Mute',
    'Ekranı kapat (ses devam eder)': 'Turn screen off (sound continues)',
    'Ekranı aç': 'Turn screen on',
    'kapat': 'off',
    'aç': 'on',
    'Kanal ve ses tuşları': 'Channel and volume buttons',
    'Sonraki kanal': 'Next channel',
    'Önceki kanal': 'Previous channel',
    'KANAL': 'CHANNEL',
    'Sesi aç': 'Volume up',
    'Sesi kıs': 'Volume down',
    'SES': 'VOLUME',

    // ── geri dön bandı ──
    'sonra dönülecek': 'until switching back',
    '+1 dk': '+1 min',
    'Şimdi': 'Now',
    'İptal': 'Cancel',

    // ── kanal listeleri ──
    'Favori kanallar': 'Favorite channels',
    'Diğer sık kullanılan kanallar': 'Other popular channels',

    // ── uygulama kumandası ──
    'Uygulama kumandası': 'App remote',
    'Yukarı': 'Up',
    'Sol': 'Left',
    'Tamam': 'OK',
    'Sağ': 'Right',
    'Aşağı': 'Down',
    'Geri': 'Back',
    'Geri sar': 'Rewind',
    'Oynat': 'Play',
    'Duraklat': 'Pause',
    'İleri sar': 'Forward',
    'Arama kutusuna yaz…': 'Type into the search box…',
    "Apple TV'ye yazı": 'Text to Apple TV',
    'Gönder': 'Send',
    'Canlı yayına dön': 'Back to live TV',

    // ── menü satırı, renk tuşları, 👋🏻 menüsü ──
    'Menü tuşları': 'Menu buttons',
    'Ana ekran': 'Home screen',
    'Ana': 'Home',
    'Bilgi': 'Info',
    'Ayarlar': 'Settings',
    'Çıkış': 'Exit',
    'Kırmızı': 'Red',
    'Yeşil': 'Green',
    'Sarı': 'Yellow',
    'Mavi': 'Blue',
    'Diğer': 'More',
    'Reklamdan sonra geri dön': 'Back after the ad break',
    'Ekrana mesaj gönder': 'Send a message to the screen',
    'Bildirimler:': 'Notifications:',
    'kapalı': 'off',
    'açık': 'on',
    'Dil:': 'Language:',
    'Çıkış yap': 'Log out',

    // ── geri dön penceresi ──
    'Kaç dakika sonra bu kanala dönülsün?': 'Switch back to this channel in how many minutes?',
    'Dakika': 'Minutes',
    'dk': 'min',
    '1 dk': '1 min',
    '5 dk': '5 min',
    '9 dk': '9 min',
    '10 dk': '10 min',
    '15 dk': '15 min',
    'Başlat': 'Start',
    "Dönmeden 1 dk ve 10 sn önce TV'de uyarı çıkar. Sayaç evdeki bilgisayarda çalışır; telefon kilitliyken de döner.":
      'The TV shows a warning 1 min and 10 s before switching back. The timer runs on the home computer, so it works even while your phone is locked.',

    // ── mesaj penceresi ──
    'TV ekranına mesaj': 'Message to the TV screen',
    'Mesajı yaz ya da aşağıdan seç…': 'Type a message or pick one below…',
    '5 sn': '5 s',
    '15 sn': '15 s',
    '30 sn': '30 s',
    // hazır mesajlar (TV'ye seçilen dilde gider)
    'Yemek hazır': 'Dinner is ready',
    'Yatma vakti': 'Time for bed',
    'Kapıya bakar mısın?': 'Can you get the door?',
    'Telefonuna bak': 'Check your phone',
    'Sesi biraz kısar mısın?': 'Could you turn it down a bit?',
    '5 dk sonra çıkıyoruz': 'We leave in 5 minutes',

    // ── Program penceresi ──
    'Kapat': 'Close',
    'Yayın akışı ·': 'TV guide ·',
    'Yükleniyor…': 'Loading…',
    'Yaklaşanlar': 'Upcoming',
    'Yeni program': 'New schedule',
    'Kanal': 'Channel',
    'Ne zaman': 'When',
    'Bir kez': 'Once',
    'Tekrarla': 'Repeat',
    'Tarih': 'Date',
    'Saat': 'Time',
    'Günler': 'Days',
    'Her gün': 'Every day',
    'Hafta içi': 'Weekdays',
    'Hafta sonu': 'Weekends',
    'Pzt': 'Mon',
    'Sal': 'Tue',
    'Çar': 'Wed',
    'Per': 'Thu',
    'Cum': 'Fri',
    'Cmt': 'Sat',
    'Paz': 'Sun',
    'TV kapalıysa': 'If the TV is off',
    'Aç ve kanalı aç': 'Turn on and open channel',
    'Atla': 'Skip',
    'Kaydet': 'Save',
    "Kanal değişmeden 1 dk ve 10 sn önce TV'de uyarı çıkar. Evdeki bilgisayar 7/24 açık olduğu için telefon kapalıyken de çalışır.":
      'The TV shows a warning 1 min and 10 s before the channel changes. The home computer runs 24/7, so it works even while your phone is off.',
    'Geçmiş': 'History',

    // ── onay kutusu ──
    'Vazgeç': 'Cancel',
    'Evet': 'Yes',

    // ── Ayarlar penceresi (dokunmatik yüzey) ──
    'TV ayarları kumandası': 'TV settings remote',
    'Dokunmatik yüzey: sürükle imleci oynatır, dokun tıklar': 'Touchpad: drag moves the pointer, tap clicks',
    'Sürükle: imleç · Dokun: tıkla': 'Drag: pointer · Tap: click',
    'Çıkış (Exit)': 'Exit',

    // ── kanal penceresi (basılı tutunca) ──
    'Kanala git': 'Go to channel',
    'Kanal programı (yayın akışı)': 'Channel schedule (TV guide)',
    'X dk sonra': 'in X min',
    'Saat SS:DD': 'At HH:MM',
    'Kur': 'Set',

    // ── app.js: durum şeridi, kaynak düğmesi, güç ──
    'Açılıyor… (30-40 sn sürebilir)': 'Turning on… (may take 30–40 s)',
    "Kapalı · kanala ya da ⏻'a basınca açılır": 'Off · tap a channel or ⏻ to turn on',
    'Kapalı': 'Off',
    'Ekran kapalı · ses devam ediyor': 'Screen off · sound still on',
    'Açılıyor…': 'Turning on…',
    'TV kapalı': 'TV off',
    'Uygulama': 'App',
    'geçiliyor…': 'switching…',
    '{ad} kumandası': '{ad} remote',
    '{ad} · Kanal {no}': '{ad} · Channel {no}',
    'Sonra {bas}: {ad}': 'Next {bas}: {ad}',
    'TV ajanına ulaşılamadı · {hata}': "Can't reach the TV agent · {hata}",
    'Kanal listesi TV kapalıyken okunamıyor — basınca TV açılıp kanal açılır.':
      "The channel list can't be read while the TV is off — tap a channel to turn the TV on and open it.",
    'Ekran kapalı': 'Screen off',
    'Ekran yükleniyor…': 'Loading screen…',

    // ── app.js: onaylar ──
    '{ad} kapalı — açılsın mı?': '{ad} is off — turn it on?',
    'Gece saati (22:00–07:00). {ne} için TV açılacak.': 'Night hours (22:00–07:00). The TV will turn on for: {ne}.',
    'Aç': 'Turn on',
    'Gece saatinde görev': 'Task at night',
    'Çalışma zamanı: {zaman}. O sırada {tv} kapalıysa açılacak.': 'Runs at: {zaman}. If {tv} is off then, it will be turned on.',
    '{ad} kapatılsın mı?': 'Turn off {ad}?',
    'Kapat|güç': 'Turn off',
    'Güç tuşu': 'Power button',
    'Görev': 'Task',

    // ── app.js: kanal / güç / ekran bildirimleri ──
    '{tv} açılıyor, {ne} açılacak…': 'Turning on {tv}, then opening {ne}…',
    '{ad} açıldı': '{ad} turned on',
    '{ad} açılıyor…': 'Turning on {ad}…',
    '{ad} zaten açık': '{ad} is already on',
    '{ad} kapatıldı': '{ad} turned off',
    'Ekran kapatıldı · ses devam ediyor': 'Screen off · sound continues',
    'Ekran açıldı': 'Screen on',

    // ── app.js: geri dön ──
    'Kanal {no}': 'Channel {no}',
    'dönülüyor…': 'switching back…',
    '{ne} kanalına dönüldü': 'Switched back to {ne}',
    'TV kapalıydı, dönülmedi': "TV was off, didn't switch back",
    'Geri dön iptal edildi': 'Return cancelled',
    'Dönülemedi: {neden}': "Couldn't switch back: {neden}",
    'Vakit kaçırıldı (ajan çalışmıyordu)': "Missed (the agent wasn't running)",
    '{kanal}: kaç dakika sonra bu kanala dönülsün?': '{kanal}: switch back to this channel in how many minutes?',
    "Önce Canlı TV'de dönülecek kanalı açın.": 'First open the channel to return to on Live TV.',
    '{dk} dk sonra {kanal} açılacak': '{kanal} will open in {dk} min',
    'bu kanal': 'this channel',

    // ── app.js: mesaj, bildirimler, Apple TV yazısı ──
    'Mesaj yazın ya da seçin': 'Type or pick a message',
    'Mesaj {tv} ekranında ({sure})': 'Message on {tv} screen ({sure})',
    '{n} sn': '{n} s',
    'Bildirim için kumandayı ana ekrana ekleyin (Safari → Paylaş → Ana Ekrana Ekle) ve oradan açın.':
      'For notifications, add the remote to your Home Screen (Safari → Share → Add to Home Screen) and open it from there.',
    'Sunucuda bildirim ayarı yok': 'Notifications are not set up on the server',
    'Bildirimler kapatıldı': 'Notifications turned off',
    'Bildirim izni verilmedi (iPhone: Ayarlar → Bildirimler → LG Remote)':
      'Notification permission not granted (iPhone: Settings → Notifications → LG Remote)',
    'Bildirimler açık — deneme bildirimi gönderildi': 'Notifications on — test notification sent',
    'Bildirimler açık, ama deneme bildirimi gönderilemedi': "Notifications on, but the test notification couldn't be sent",
    'Yazı gönderildi': 'Text sent',

    // ── app.js: kanal penceresi ──
    'Şimdi: {ad}': 'Now: {ad}',
    '{dk} dk sonra': 'in {dk} min',
    'Saat {saat}': '{saat}',
    'Kur · {zaman}': 'Set · {zaman}',
    'yarın {saat}': 'tomorrow {saat}',
    'yarın saat {saat}': 'tomorrow at {saat}',
    'saat {saat}': 'at {saat}',
    '{kanal} · {tarif} açılacak': '{kanal} · opens {tarif}',

    // ── app.js: yayın akışı ──
    'Yayın akışı alınamadı · {hata}': "Couldn't get the TV guide · {hata}",
    'Bu kanal için yayın akışı yok.': 'No TV guide for this channel.',
    'Şimdi aç': 'Open now',
    'Kurulu': 'Scheduled',
    'İptal etmek için dokunun': 'Tap to cancel',
    '"{ad}" için kurulu açma iptal edilsin mi?': 'Cancel the scheduled opening for "{ad}"?',
    'Başlayınca aç': 'Open at start',
    '{zaman} · {program} başlayınca {kanal} açılacak': '{zaman} · {kanal} will open when {program} starts',
    'Bugün': 'Today',
    'Yarın': 'Tomorrow',

    // ── app.js: görev listesi ve geçmiş ──
    'TV kapalıysa atla': 'skip if TV is off',
    'TV kapalıysa açar': 'turns TV on if off',
    'reklamdan sonra geri dön': 'back after the ad break',
    '{sure} sonra': 'in {sure}',
    'program başlayınca': 'when the show starts',
    'bir kez': 'once',
    'sıradaki: {zaman}': 'next: {zaman}',
    'durduruldu': 'paused',
    'Henüz program yok. Aşağıdan ekleyin; reklam arası için 👋🏻 → Reklamdan sonra geri dön.':
      'No schedules yet. Add one below; for ad breaks use 👋🏻 → Back after the ad break.',
    'Durdur': 'Pause',
    'Sil': 'Delete',
    'Bu program silinsin mi?': 'Delete this schedule?',
    'Henüz çalışan görev yok.': 'No tasks have run yet.',
    'yapıldı': 'done',
    'TV kapalıydı, atlandı': 'TV was off, skipped',
    'iptal': 'cancelled',
    'hata': 'error',
    'kaçırıldı': 'missed',
    'TV, kanal ve saat seçin': 'Choose a TV, channel and time',
    'En az bir gün seçin': 'Choose at least one day',
    'Program kaydedildi': 'Schedule saved',
    'giriş gerekli': 'login required',

    // ── sunucu hataları (server/tvKumanda.cjs, server/kumanda.cjs — sabit `error` metinleri) ──
    'TV ajanı tanımlı değil (TV_AJAN_URL / TV_AJAN_TOKEN)': 'TV agent not configured (TV_AJAN_URL / TV_AJAN_TOKEN)',
    'TV ajanı yanıt vermedi': 'The TV agent did not respond',
    'TV ajanına ulaşılamadı': "Can't reach the TV agent",
    'geçersiz TV': 'invalid TV',
    'yayın akışı alınamadı': "couldn't get the TV guide",
    'ekran görüntüsü alınamadı': "couldn't get a screenshot",
    'izinli olmayan tuş': 'button not allowed',
    'metin en çok 100 karakter': 'text can be at most 100 characters',
    'kanal adı ya da numarası gerekli': 'channel name or number required',
    'geçersiz hareket': 'invalid movement',
    'geçersiz giriş': 'invalid source',
    'canlı önizleme başlatılamadı': "couldn't start the live preview",
    'kapali true/false olmalı': 'kapali must be true/false',
    'mesaj 1-160 karakter olmalı': 'message must be 1–160 characters',
    'süre 5-120 sn olmalı': 'duration must be 5–120 s',
    'bilinmeyen işlem': 'unknown operation',
    'süre 1-120 dk olmalı': 'duration must be 1–120 min',
    'kanal kumandadaki kanallardan seçilmeli': "channel must be one of the remote's channels",
    'TV kapalıysa: ac ya da atla': 'if TV is off: ac or atla',
    'etiket en çok 80 karakter': 'label can be at most 80 characters',
    'tarih ve saat gerekli': 'date and time required',
    'süre 1-720 dk olmalı': 'duration must be 1–720 min',
    'saat ve günler gerekli': 'time and days required',
    'zaman türü tek, sonra ya da haftalik olmalı': 'time type must be tek, sonra or haftalik',
    'geçersiz görev': 'invalid task',
    'uzatma 1-30 dk': 'extension must be 1–30 min',
    'acik true/false olmalı': 'acik must be true/false',
    'Giriş yapılmamış': 'Not logged in',
    'bildirim altyapısı yok': 'notification service unavailable',
    'geçersiz abonelik': 'invalid subscription',
    'abonelik anahtarları eksik': 'subscription keys missing',
    // ajanın (agent/tv-ajan.mjs) sabit hataları — sunucu `error` olarak iletir
    'yetkisiz': 'unauthorized',
    'bilinmeyen uç': 'unknown endpoint',

    // app.js: kilit, önizleme, ses şeridi, menü
    "Kilitli — açılamaz · kilit: 👋🏻 → Engeller ve kilit": "Locked — can't be turned on · lock: 👋🏻 → Blocks & lock",
    "Önizleme alınamadı · yeniden deneniyor": "Couldn't load the preview · retrying",
    "Harici ses çıkışı — düzey buradan ayarlanamıyor": "External audio output — volume can't be set from here",
    "Ses düzeyi": "Volume level",
    "Kanal yok": "No channels",
    "TV açıksa gösterilir": "shown if the TV is on",
    "Program listesi alınamadı · {hata}": "Couldn't get the schedule list · {hata}",
    "Detail": "Details",
    // "ℹ" Unicode'da harf sayılır: baştaki simge ayrılamaz, anahtar simgesiyle birlikte yazılır.
    "ℹ️ Detail": "ℹ️ Details",
    "Engeller ve kilit": "Blocks & lock",
    "Exit": "Exit",

    // süreler (Detail, Engeller)
    "<1 dk": "<1 min",
    "0 dk": "0 min",
    "{d} dk": "{d} min",
    "{s} sa {d} dk": "{s} h {d} min",
    "{s} sa": "{s} h",
    "30 dk": "30 min",
    "60 dk": "60 min",
    "1 saat": "1 hour",
    "2 saat": "2 hours",
    "{n} saat": "{n} h",
    "{n} dakika": "{n} minutes",

    // Detail sayfası (izleme.html / izleme.js)
    "TV'ler — şu an ve bugün": "TVs — now and today",
    "TV'ler": "TVs",
    "Kumanda": "Remote",
    "Kumandaya dön": "Back to the remote",
    "Engeller": "Blocks",
    "İzleme ayrıntıları": "Viewing details",
    "Şu an": "Now",
    "Dün": "Yesterday",
    "Gün": "Day",
    "Hafta": "Week",
    "Ay": "Month",
    "Önceki gün": "Previous day",
    "Sonraki gün": "Next day",
    "Önceki": "Previous",
    "Sonraki": "Next",
    "Liste sırası": "List order",
    "Aralık": "Range",
    "En yeni → en eski": "Newest → oldest",
    "En uzun → en kısa": "Longest → shortest",
    "Gruplu": "Grouped",
    "Geçmiş — gün · hafta · ay": "History — day · week · month",
    "Geçmişi gizle": "Hide history",
    "Özet": "Summary",
    "Günün özeti": "Day's summary",
    "Haftanın özeti": "Week's summary",
    "Ayın özeti": "Month's summary",
    "Zaman çizelgesi": "Timeline",
    "Günlere göre": "By day",
    "Ayın günleri": "Days of the month",
    "Canlı TV · kanal ve program": "Live TV · channel and programme",
    "Uygulamalar · ne izlendi": "Apps · what was watched",
    "Günün saatlerine göre": "By hour of day",
    "Oturumlar": "Sessions",
    "Kayıt evdeki ajanda tutulur. Apple TV'de oynayan içerik, TV Apple TV girişindeyken okunur; duraklatılmış oynatma izleme süresine katılmaz (⏸).": "Records are kept on the home agent. What plays on Apple TV is read while the TV is on the Apple TV input; paused playback doesn't count as watch time (⏸).",
    "Canlı TV": "Live TV",
    "Diğer|kaynak": "Other",
    "Pasif": "Idle",
    "(menüde / içerik bilgisi yok)": "(in menus / no content info)",
    "(program bilgisi yok)": "(no programme info)",
    "İzleme geçmişi alınamadı · {hata}": "Couldn't get the viewing history · {hata}",
    "izlenen {sure}": "watched {sure}",
    "günde ort. {sure}": "avg. {sure} per day",
    "TV açık (TV'lerin toplamı)": "TV on (all TVs)",
    "TV açık": "TV on",
    "duraklatılmış ya da bekleme ekranı": "paused or on a standby screen",
    "Yalnız ses (ekran kapalı)": "Sound only (screen off)",
    "Oturum": "Sessions",
    "en uzun {sure}": "longest {sure}",
    "İlk açılış · son kapanış": "First on · last off",
    "şu an açık": "on now",
    "duraklatıldı": "paused",
    "sürüyor": "ongoing",
    "ekran kapalı": "screen off",
    "Toplam {sure}": "Total {sure}",
    "Videoyu YouTube'da aç": "Open the video on YouTube",
    "YouTube'da ara (video birebir bulunamadı)": "Search on YouTube (exact video not found)",
    "YouTube'da ara": "Search on YouTube",
    "YouTube'da aç": "Open on YouTube",
    "Bu aralıkta canlı yayın izlenmedi.": "No live TV watched in this period.",
    "Uygulama açıktı ama oynatma hep duraklatılmıştı.": "An app was open but playback was paused the whole time.",
    "Bu aralıkta uygulama kullanılmadı.": "No apps used in this period.",
    "Kayıt yok.": "No records.",
    "Bu aralıkta kayıt yok.": "No records in this period.",
    "Bugün henüz TV açılmadı (ya da kayıt yeni başladı).": "No TV has been on today yet (or recording just started).",
    "DURAKLATILDI": "PAUSED",
    "ŞİMDİ": "NOW",
    "ekran kapalı (yalnız ses)": "screen off (sound only)",
    "{saat} itibarıyla": "as of {saat}",
    "TV durumu alınamadı.": "Couldn't get the TV status.",
    "Bugün en son {saat}'e kadar açıktı — {ne}": "Last on today until {saat} — {ne}",
    "Bugün hiç açılmadı.": "Not turned on today.",
    "Duraklatıldı": "Paused",
    "Oynamıyor": "Not playing",
    "Apple TV ana ekranı": "Apple TV home screen",
    "oynatılıyor — uygulama tanımlanamadı": "playing — app not identified",
    "oynatılıyor — uygulama başlık bilgisi vermiyor": "playing — the app doesn't report a title",
    "{saat}'den beri ({sure})": "since {saat} ({sure})",
    "bugün {sure} açık": "on {sure} today",
    "izlendi {sure}": "watched {sure}",
    "pasif {sure}": "idle {sure}",
    "Pasif (duraklatılmış / bekleme)": "Idle (paused / standby)",
    "+{n} daha": "+{n} more",
    "şimdi": "now",
    "Bugün açılmadı.": "Not on today.",
    "Bu gün açılmadı.": "Not on this day.",
    "izlendi": "watched",
    "{sure} açık": "{sure} on",
    "{sure} pasif": "{sure} idle",
    "Pasif — duraklatılmış / bekleme ekranı": "Idle — paused / standby screen",
    "Bunun {sure} kadarı ekran kapalı, yalnız ses.": "{sure} of this with the screen off, sound only.",
    "Gün yüklenemedi · {hata}": "Couldn't load the day · {hata}",
    "TV bilgisi alınamadı · {hata}": "Couldn't get TV info · {hata}",

    // Engeller ve kilit sayfası (engel.html / engel.js)
    "TV kilidi": "TV lock",
    "TV'de görünecek kilit mesajı": "Lock message shown on the TV",
    "Kilit mesajı": "Lock message",
    "Her satır ayrı (en çok 5 satır, satır başına 80 karakter)": "One line each (at most 5 lines, 80 characters per line)",
    "Aradaki boş satır korunur (ayırıcı); baştaki ve sondaki boş satırlar atılır. Boş bırakılan kutu varsayılan metne döner.": "Blank lines in between are kept (as separators); leading and trailing blank lines are removed. An empty box goes back to the default text.",
    "Mesajı kaydet": "Save message",
    "Metinleri kaydet": "Save texts",
    "YouTube engelleri": "YouTube blocks",
    "YouTube engelleme": "YouTube blocking",
    "Engelleme açık/kapalı": "Blocking on/off",
    "TV'de görünecek engel metinleri": "Block texts shown on the TV",
    "1. kademe — video engellenince": "Step 1 — when a video is blocked",
    "2. kademe — aynı video yeniden açılınca (YouTube kapatılır)": "Step 2 — when the same video is opened again (YouTube is closed)",
    "Engel ekle": "Add a block",
    "YouTube linki, kanal adı ya da kelime": "YouTube link, channel name or word",
    "Ne engellensin": "What to block",
    "Otomatik": "Automatic",
    "Kelime": "Word",
    "Kanallar": "Channels",
    "Kelimeler": "Words",
    "Videolar": "Videos",
    "Engellenenler": "Blocked",
    "Engellenmeyenler": "Not blocked",
    "Son engellenenler ve izlenenler": "Recently blocked and watched",
    "Son 7 günde izlenen, engelli olmayan YouTube videoları. Engelle'ye basınca: yalnız bu video · kanalı · anahtar kelime.": "YouTube videos watched in the last 7 days that are not blocked. Tap Block to block: only this video · its channel · a keyword.",
    "İşlem kaydı": "Activity log",
    "Kilit: kilitli TV kumandadan açılamaz; kendi kumandasıyla açılırsa birkaç saniye içinde ekranda kilit mesajı çıkar, ardından TV (seçiliyse Apple TV de uyutularak) kapanır ve telefona bildirim gelir.": "Lock: a locked TV can't be turned on from the remote; if it's turned on with its own remote, the lock message appears on screen within a few seconds, then the TV turns off (with Apple TV put to sleep if selected) and you get a notification.",
    "Engel, Apple TV'deki YouTube'da çalışır: kurala uyan video oynamaya başlayınca birkaç saniye içinde TV'de engel mesajı görünür, video durdurulur ve oynatıcıdan çıkılır; aynı video kısa süre içinde yeniden açılırsa uyarı gösterilip YouTube uygulaması kapatılır. Kelime, video başlığında ya da kanal adında bir sözcüğün başında geçerse tutar; büyük/küçük harf ve Türkçe harf farkı gözetilmez. LG'nin kendi YouTube uygulamasında izlenen video okunamadığı için orada engel çalışmaz.": "Blocking works in YouTube on Apple TV: when a matching video starts playing, a block message appears on the TV within a few seconds, the video is stopped and the player is closed; if the same video is opened again shortly after, a warning is shown and the YouTube app is closed. A word matches when it appears at the start of a word in the video title or channel name; case and Turkish letter differences are ignored. Blocking doesn't work in LG's own YouTube app because the video being watched can't be read there.",
    "video": "video",
    "07:00'e kadar": "Until 07:00",
    "Süresiz": "Indefinitely",
    "Sabah 07:00'ye kadar": "Until 07:00 in the morning",
    "Video linki → o video · kanal linki (youtube.com/@…) → o kanal · düz yazı → anahtar kelime.": "Video link → that video · channel link (youtube.com/@…) → that channel · plain text → keyword.",
    "Kanal linki, kanalın adı ya da kanaldan bir VİDEO linki (o videonun kanalı engellenir).": "Channel link, the channel's name, or a VIDEO link from the channel (that video's channel is blocked).",
    "Video başlığında ya da kanal adında geçen sözcük (\"dino\" → \"Dinozorlar…\" da engellenir).": "A word in the video title or channel name (\"dino\" also blocks \"Dinosaurs…\").",
    "Değişiklik yok": "No changes",
    "En çok {n} satır": "At most {n} lines",
    "Satır başına en çok {n} karakter": "At most {n} characters per line",
    "{ne} engelini kaldır": "Remove block: {ne}",
    "\"{ne}\" engeli kaldırılsın mı?": "Remove the block \"{ne}\"?",
    "Engel kaldırıldı": "Block removed",
    "Kaldırılamadı · {hata}": "Couldn't remove · {hata}",
    "Açık — {n} kural bütün TV'lerde geçerli": "On — {n} rules apply on all TVs",
    "KAPALI — kurallar duruyor ama uygulanmıyor": "OFF — rules are kept but not applied",
    "Engelli kanal yok.": "No blocked channels.",
    "örnek: {ornek}": "example: {ornek}",
    "Engelli kelime yok.": "No blocked words.",
    "Tek tek engellenmiş video yok.": "No individually blocked videos.",
    "Henüz engellenen bir şey olmadı.": "Nothing has been blocked yet.",
    "kanal: {deger}": "channel: {deger}",
    "kelime: {deger}": "word: {deger}",
    "listedeki video": "listed video",
    "video: {ad}": "video: {ad}",
    "kumandadan": "from the remote",
    "komutla": "by command",
    "kanal": "channel",
    "kelime": "word",
    "Yalnız TV": "TV only",
    "TV + Apple TV": "TV + Apple TV",
    "{tv} kilitlendi ({sure}, {kapsam})": "{tv} locked ({sure}, {kapsam})",
    "{tv} kilitlendi ({sure})": "{tv} locked ({sure})",
    "süresiz": "indefinitely",
    "{tv} kilidi açıldı": "{tv} unlocked",
    "{tv} kilidinin süresi doldu": "{tv} lock expired",
    "{tv} kilitliyken açıldı, kapatıldı": "{tv} was turned on while locked and turned off",
    "Engel eklendi — {tur}: {deger}": "Block added — {tur}: {deger}",
    "Engel kaldırıldı — {tur}: {deger}": "Block removed — {tur}: {deger}",
    "YouTube engelleme açıldı": "YouTube blocking turned on",
    "YouTube engelleme kapatıldı": "YouTube blocking turned off",
    "Engel mesajı (1. kademe) değiştirildi": "Block message (step 1) changed",
    "Engel uyarısı (2. kademe) değiştirildi": "Block warning (step 2) changed",
    "Henüz kayıt yok.": "No records yet.",
    "Kilit bilgisi alınamadı.": "Couldn't get lock info.",
    "TV bulunamadı.": "No TV found.",
    "Kilitli": "Locked",
    "Kilitsiz": "Unlocked",
    "{saat}'e kadar": "until {saat}",
    "Kilidi aç": "Unlock",
    "{tv}: kilit açıldı": "{tv}: unlocked",
    "Açılamadı · {hata}": "Couldn't unlock · {hata}",
    "Kilitsiz — süre seçip kilitle.": "Unlocked — pick a duration and lock.",
    "Kilitle": "Lock",
    "{tv} kilitlensin mi?": "Lock {tv}?",
    "Süre": "Duration",
    "Kapsam": "Scope",
    "Kilit onayı": "Confirm lock",
    "TV açıksa ekranda kilit mesajı gösterilir ve birkaç saniye içinde (seçiliyse Apple TV de uyutularak) kapanır. Kilitli TV kendi kumandasıyla açılamaz.": "If the TV is on, the lock message is shown and within a few seconds it turns off (with Apple TV put to sleep if selected). A locked TV can't be turned on with its own remote.",
    "Kilitlenemedi · {hata}": "Couldn't lock · {hata}",
    "Kilit mesajı kaydedildi": "Lock message saved",
    "Kaydedilemedi · {hata}": "Couldn't save · {hata}",
    "Engel metinleri kaydedildi": "Block texts saved",
    "Son 7 günde engellenmemiş YouTube videosu bulunamadı.": "No unblocked YouTube videos in the last 7 days.",
    "Engelle": "Block",
    "Kanal: {kanal}": "Channel: {kanal}",
    "Sadece bu video": "Only this video",
    "Yalnız bu video engellenir": "Only this video is blocked",
    "Video kimliği yok — kullanılamaz": "No video ID — unavailable",
    "Bu kanal": "This channel",
    "Kanalın tüm videoları engellenir": "All of the channel's videos are blocked",
    "Anahtar kelimeyle engelle (önerildi, değiştirilebilir):": "Block by keyword (suggested, editable):",
    "Anahtar kelime": "Keyword",
    "Nasıl engellensin?": "How should it be blocked?",
    "Zaten engelli — {ne}": "Already blocked — {ne}",
    "Engellendi — {ne}": "Blocked — {ne}",
    "Engellenemedi · {hata}": "Couldn't block · {hata}",
    "Kilit bilgisi alınamadı · {hata}": "Couldn't get lock info · {hata}",
    "Engel listesi alınamadı · {hata}": "Couldn't get the block list · {hata}",
    "Eklenemedi · {hata}": "Couldn't add · {hata}",
    "Engelleme kapatılsın mı? Kurallar silinmez, yalnız uygulanmaz.": "Turn blocking off? Rules aren't deleted, just not applied.",
    "Engelleme açıldı": "Blocking on",
    "Engelleme kapatıldı": "Blocking off",
    "Değiştirilemedi · {hata}": "Couldn't change · {hata}",

    // geçidin yeni hata metinleri (server/*.cjs)
    "çok büyük istek": "request too large",
    "geçersiz istek": "invalid request",
    "sunucu hatası": "server error",
    "TV ajanı belirteci reddetti (TV_AJAN_TOKEN)": "The TV agent rejected the token (TV_AJAN_TOKEN)",
    "ses 0-100 arasında tam sayı olmalı": "volume must be a whole number 0–100",
    "çok fazla canlı önizleme": "too many live previews",
    "gün YYYY-AA-GG olmalı": "day must be YYYY-MM-DD",
    "süre 1 dk – 30 gün ya da süresiz olmalı": "duration must be 1 min – 30 days or indefinite",
    "kapsam tv ya da tv+apple olmalı": "scope must be tv or tv+apple",
    "mesaj en çok 5 satır, satır başına 80 karakter": "message: at most 5 lines, 80 characters per line",
    "uyarı en çok 5 satır, satır başına 80 karakter": "warning: at most 5 lines, 80 characters per line",
    "link, kanal adı ya da kelime gerekli (en çok 300 karakter)": "a link, channel name or word is required (at most 300 characters)",
    "tür video, kanal ya da kelime olmalı": "type must be video, kanal or kelime",
    "geçersiz kural": "invalid rule",
    "engel ayarı: acik, mesaj ya da uyari gerekli": "block settings: acik, mesaj or uyari required",
    "abonelikler okunamadı": "couldn't read subscriptions",
    "abonelik kaydedilemedi": "couldn't save the subscription",
    "abonelik silinemedi": "couldn't remove the subscription",

    // ajanın sık görülen sabit hataları
    "bu an geçmişte": "that time is in the past",
    "izleme kaydı kapalı (TV_AJAN_IZLEME=1)": "viewing log is off (TV_AJAN_IZLEME=1)",
    "kilit kurulu değil": "lock is not set up",
    "engelleme kurulu değil (Apple TV yok)": "blocking is not set up (no Apple TV)",
    "en çok 5 satır, satır başına 80 karakter": "at most 5 lines, 80 characters per line",
    "acik, mesaj ya da uyari gerekli": "acik, mesaj or uyari required",
    "görev bulunamadı": "task not found",
  };

  const sahip = (o, a) => Object.prototype.hasOwnProperty.call(o, a);

  const dil = (() => {
    let d = null;
    try { d = localStorage.getItem('dil'); } catch (e) { /* özel pencere / engelli depolama */ }
    if (d === 'tr' || d === 'en') return d;
    const tarayici = String((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase();
    return tarayici.startsWith('tr') ? 'tr' : 'en';
  })();

  // Baştaki simge: harf, rakam, yer tutucu ya da tırnak olmayan karakterler ("⏱ ", "▶ ", "🔔 ").
  const ONEK = /^([^\p{L}\p{N}{"'(]+)([\s\S]+)$/u;

  /** Metnin İngilizcesi; sözlükte yoksa null (geçerli dilden bağımsız). */
  function bul(metin) {
    if (typeof metin !== 'string' || !metin) return null;
    if (sahip(EN, metin)) return EN[metin];
    const m = ONEK.exec(metin);
    if (m && sahip(EN, m[2])) return m[1] + EN[m[2]];
    return null;
  }

  /** Türkçe görünüm: 'metin|bağlam' anahtarında '|' öncesi (yalnız sözlükteki bağlamlı anahtarlarda). */
  function gorunum(metin) {
    const i = metin.indexOf('|');
    return i > 0 && sahip(EN, metin) ? metin.slice(0, i) : metin;
  }

  /** Dile göre metin; {x} yer tutucuları `degiskenler`den doldurulur. */
  function L(metin, degiskenler) {
    if (typeof metin !== 'string') return metin;
    const ceviri = dil === 'en' ? bul(metin) : null;
    let s = ceviri != null ? ceviri : gorunum(metin);
    if (degiskenler && typeof degiskenler === 'object') {
      s = s.replace(/\{(\w+)\}/g, (h, a) => (sahip(degiskenler, a) ? String(degiskenler[a]) : h));
    }
    return s;
  }

  const NITELIKLER = ['aria-label', 'placeholder', 'title', 'alt'];

  /** Kök altındaki metin düğümlerini ve erişilebilirlik niteliklerini çevirir (Türkçede hiçbir şey yapmaz). */
  function sayfayiCevir(kok) {
    if (dil === 'tr') return;
    kok = kok || document.body;
    document.documentElement.lang = 'en';
    const baslik = bul(document.title.trim());
    if (baslik != null) document.title = baslik;
    const yuruyen = document.createTreeWalker(kok, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentNode && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.parentNode.nodeName)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const dugumler = [];
    for (let n = yuruyen.nextNode(); n; n = yuruyen.nextNode()) dugumler.push(n);
    for (const n of dugumler) {
      const ham = n.nodeValue;
      const kirpik = ham.trim().replace(/\s+/g, ' ');
      if (!kirpik) continue;
      const c = bul(kirpik);
      if (c == null) continue;
      n.nodeValue = ham.match(/^\s*/)[0] + c + ham.match(/\s*$/)[0];   // baştaki/sondaki boşluk korunur
    }
    const secici = NITELIKLER.map((a) => `[${a}]`).join(',');
    const ogeler = [...(kok.matches && kok.matches(secici) ? [kok] : []), ...kok.querySelectorAll(secici)];
    for (const o of ogeler) {
      for (const a of NITELIKLER) {
        const v = o.getAttribute(a);
        if (!v || !v.trim()) continue;
        const c = bul(v.trim().replace(/\s+/g, ' '));
        if (c != null) o.setAttribute(a, c);
      }
    }
  }

  function dilSec(d) {
    if (d !== 'tr' && d !== 'en') return;
    try { localStorage.setItem('dil', d); } catch (e) { /* kaydedilemedi: yeniden yüklemede tarayıcı dili geçer */ }
    location.reload();
  }

  window.L = L;
  window.i18n = { dil: () => dil, dilSec, sayfayiCevir, bul };
  window.i18n.sayfayiCevir();   // betik gövdenin sonunda: DOM hazır
})();
