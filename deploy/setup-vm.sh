#!/usr/bin/env bash
# One-shot setup for a fresh Debian/Ubuntu Google Compute Engine VM.
# Run in the VM's SSH window:
#   curl -fsSL https://raw.githubusercontent.com/imrishifman/shani-time-agent/main/deploy/setup-vm.sh | bash
set -euo pipefail

REPO="https://github.com/imrishifman/shani-time-agent.git"
DIR="$HOME/shani-time-agent"

echo "==> Installing Docker, git"
sudo apt-get update -y -qq
sudo apt-get install -y -qq ca-certificates curl git >/dev/null
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh >/dev/null
fi
sudo usermod -aG docker "$USER" || true

# Small VMs (e2-micro) need swap to build the TypeScript image.
if [ ! -f /swapfile ]; then
  echo "==> Adding 2G swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Fetching the app"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q; else git clone -q "$REPO" "$DIR"; fi
cd "$DIR"
[ -f .env ] || cp .env.example .env

IP=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip || true)
HOST="<your-host>"
if [ -n "$IP" ]; then
  HOST="$IP.sslip.io"
  sed -i "s|^PUBLIC_HOST=.*|PUBLIC_HOST=$HOST|; s|^PUBLIC_URL=.*|PUBLIC_URL=https://$HOST|" .env
  echo "==> Public host set to https://$HOST"
fi

cat <<MSG

Setup done. Next:
  1. nano ~/shani-time-agent/.env      (fill in ANTHROPIC_API_KEY, USER_WHATSAPP_NUMBER, GOOGLE_*, TWILIO_*)
  2. cd ~/shani-time-agent && sudo docker compose up -d --build
  3. sudo docker compose logs -f app   (watch it start)
  4. Open https://$HOST/auth/google in a browser where Shani is signed in to Google.

Google OAuth redirect URI to register:  https://$HOST/auth/google/callback
Twilio inbound webhook URL:             https://$HOST/webhooks/whatsapp
MSG
