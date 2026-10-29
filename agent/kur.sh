#!/usr/bin/env bash
# ── TV ajanı kurulumu (Debian / Raspberry Pi OS, systemd) ──
#
# Kullanım (ev ağındaki makinede, depo klasöründe):
#   sudo ./agent/kur.sh
#
# Tekrar çalıştırılabilir: var olanı günceller. /etc/tv-ajan.env zaten varsa ÜZERİNE
# YAZMAZ — belirteç değişirse geçidin (server/) bağlantısı kopar.
#
# Kaynak klasörde depo dışı iki dosya da olmalı (ilk kurulumda; sonra /opt'takiler kalır):
#   tv-ajan.tvler.json   TV listesi (yerel adresler + uzaktan açma için MAC)
#   .lgtv-clients.json   TV eşleşme anahtarları
set -euo pipefail

HEDEF=/opt/tv-ajan
AYAR=/etc/tv-ajan.env
KAYNAK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ $EUID -eq 0 ]] || { echo "Bu betik root gerektirir:  sudo $0"; exit 1; }

echo "── 1/6  Node.js"
SURUM=$(node -p 'process.versions.node.split(".")[0]')
(( SURUM >= 20 )) || { echo "!!  Node $SURUM — en az 20 gerekli"; exit 1; }
echo "     Node $(node -v) ✓"

echo "── 2/6  Servis kullanıcısı"
id -u tvajan >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin tvajan
echo "     tvajan ✓"

echo "── 3/6  Dosyalar → $HEDEF"
# tv-ajan.mjs bunların hepsini içe aktarıyor — eksik biri servisi MODULE_NOT_FOUND ile düşürür.
DOSYALAR=(
  agent/tv-ajan.mjs agent/ws-client.mjs agent/ssap-handshake.json agent/atv-yardimci.py agent/ekran-hareket.py
  agent/net/lg-ssap.mjs agent/net/lg-input.mjs agent/net/lg-screen.mjs agent/net/kanal-bul.mjs
  agent/net/rehber.mjs agent/net/wol.mjs agent/net/zamanlayici.mjs agent/net/atv-kopru.mjs
  agent/net/lg-editor.mjs agent/net/moveplan.cjs agent/net/order.cjs agent/net/kanal-sirasi.mjs
  agent/net/saat.mjs agent/net/satirlar.mjs agent/net/izleme.mjs agent/net/youtube-bul.mjs
  agent/net/engel.mjs agent/net/kilit.mjs
  agent/oneriler/vibecoder.json
)
for f in "${DOSYALAR[@]}"; do
  install -D -o root -g root -m 644 "$KAYNAK/$f" "$HEDEF/$f"
done
# Dağıtım bütünlüğü: kaynak ile kurulu dosya birebir aynı olmalı (yarım kopya servisi sessizce bozar).
for f in "${DOSYALAR[@]}"; do
  A=$(sha256sum "$KAYNAK/$f" | cut -d' ' -f1); B=$(sha256sum "$HEDEF/$f" | cut -d' ' -f1)
  [[ "$A" == "$B" ]] || { echo "!!  Bütünlük bozuk: $f"; exit 1; }
done
echo "     ${#DOSYALAR[@]} dosya, sha256 doğrulandı ✓"

# Apple TV (isteğe bağlı): pyatv ayrı bir sanal ortamda. Yoksa uygulamalar TV'nin kendi uygulamasıyla açılır.
#   sudo python3 -m venv /opt/pyatv && sudo /opt/pyatv/bin/pip install pyatv==0.18.0   (python3-dev gerekir)
#   Eşleştirme (PIN Apple TV ekranında):  sudo /opt/pyatv/bin/atvremote --storage-filename /var/lib/tv-ajan/pyatv.conf \
#     -s <apple-tv-ip> --id <kimlik> --protocol companion pair   → sonra: chown tvajan:tvajan + chmod 600
if [[ -x /opt/pyatv/bin/python3 ]]; then echo "     pyatv: $(/opt/pyatv/bin/python3 -c 'import pyatv.const as c; print(c.__version__)' 2>/dev/null || echo '?') ✓"
else echo "     pyatv yok — Apple TV'de uygulama açma kapalı (TV'nin uygulaması kullanılır)"; fi
# Apple TV'de oynatma bilgisi vermeyen uygulamayı ekran hareketinden tanımak için (isteğe bağlı): sistem Python'u + PIL.
if /usr/bin/python3 -I -c 'import PIL' 2>/dev/null; then echo "     python3-pil ✓ (ekran hareketi ölçümü açık)"
else echo "     python3-pil yok — ekran hareketi ölçümü kapalı (isterseniz: apt install python3-pil)"; fi

echo "── 4/6  TV listesi ve eşleşme anahtarları"
for f in tv-ajan.tvler.json .lgtv-clients.json; do
  if [[ -f "$KAYNAK/$f" ]]; then
    install -o root -g tvajan -m 640 "$KAYNAK/$f" "$HEDEF/$f"
    echo "     $f güncellendi"
  elif [[ -f "$HEDEF/$f" ]]; then
    echo "     $f mevcut — dokunulmadı"
  else
    echo "!!  $f yok (ne kaynakta ne $HEDEF'te)"; exit 1
  fi
done

echo "── 5/6  Ayar dosyası ($AYAR)"
if [[ -f $AYAR ]]; then
  echo "     Zaten var — dokunulmadı."
else
  # Dinlenecek adres: TV_AJAN_HOST verildiyse o; yoksa Tailscale adresi (geçit internette ise
  # VPN üzerinden ulaşır); o da yoksa 127.0.0.1 (geçit aynı makinede).
  ADRES=${TV_AJAN_HOST:-$(tailscale ip -4 2>/dev/null | head -1 || true)}
  ADRES=${ADRES:-127.0.0.1}
  ( umask 077; cat > "$AYAR" <<EOF
# Geçitte (server/) TV_AJAN_TOKEN aynı değer olmalı.
TV_AJAN_TOKEN=$(openssl rand -hex 32)
# Ev ağına açık değil: yalnız bu adresten dinler.
TV_AJAN_HOST=$ADRES
TV_AJAN_PORT=3027
TV_AJAN_TVLER=$HEDEF/tv-ajan.tvler.json
TV_AJAN_ANAHTARLAR=$HEDEF/.lgtv-clients.json
# Yerel saat dilimi (zamanlayıcı, izleme kaydı, ekrandaki saatler). Varsayılan Europe/Istanbul.
#TV_AJAN_TZ=Europe/Istanbul
# İzleme geçmişi (hangi TV ne zaman açık, ne izlendi) — kişisel veri, yalnız bu makinede tutulur.
#TV_AJAN_IZLEME=1
EOF
  )
  echo "     oluşturuldu (belirteç üretildi, ekrana yazılmadı) · adres $ADRES:3027"
fi

echo "── 6/6  Servis"
install -o root -g root -m 644 "$KAYNAK/agent/tv-ajan.service" /etc/systemd/system/tv-ajan.service
systemctl daemon-reload
systemctl enable tv-ajan >/dev/null
systemctl restart tv-ajan
sleep 3
systemctl is-active --quiet tv-ajan && echo "     tv-ajan çalışıyor ✓" || { echo "!!  tv-ajan başlamadı:"; journalctl -u tv-ajan -n 20 --no-pager; exit 1; }
journalctl -u tv-ajan -n 3 --no-pager
