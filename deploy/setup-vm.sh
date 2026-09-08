#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="shani-agent"
APP_DIR="/opt/shani-time-agent"
REPO_URL="https://github.com/imrishifman/shani-time-agent.git"
REPO_BRANCH="main"
HOST="34.172.154.187.sslip.io"
CERTBOT_EMAIL="imri@babalata.com"
APP_PORT="3000"

if [[ "${EUID}" -eq 0 ]]; then
  DEPLOY_USER="${SUDO_USER:-root}"
else
  DEPLOY_USER="${USER}"
fi
DEPLOY_GROUP="$(id -gn "${DEPLOY_USER}")"

sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg nginx certbot python3-certbot-nginx

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

if [[ -d "${APP_DIR}/.git" ]]; then
  sudo -u "${DEPLOY_USER}" git -C "${APP_DIR}" pull --ff-only origin "${REPO_BRANCH}"
elif [[ -e "${APP_DIR}" ]]; then
  echo "Refusing to overwrite existing non-Git path: ${APP_DIR}" >&2
  exit 1
else
  sudo mkdir -p "$(dirname "${APP_DIR}")"
  sudo git clone --branch "${REPO_BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
  sudo chown -R "${DEPLOY_USER}:${DEPLOY_GROUP}" "${APP_DIR}"
fi

if ! sudo swapon --show | grep -q .; then sudo fallocate -l 1G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=1024; sudo chmod 600 /swapfile; sudo mkswap /swapfile; sudo swapon /swapfile; grep -q '^/swapfile ' /etc/fstab || echo '/swapfile swap swap defaults 0 0' | sudo tee -a /etc/fstab >/dev/null; fi; sudo -u "${DEPLOY_USER}" npm --prefix "${APP_DIR}" ci
sudo -u "${DEPLOY_USER}" npm --prefix "${APP_DIR}" install --no-save --package-lock=false --ignore-scripts typescript@5 && sudo -u "${DEPLOY_USER}" env NODE_OPTIONS=--max-old-space-size=1536 "${APP_DIR}/node_modules/.bin/tsc" --noCheck -p "${APP_DIR}/tsconfig.json"
sudo -u "${DEPLOY_USER}" mkdir -p "${APP_DIR}/data"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  sudo -u "${DEPLOY_USER}" cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
fi
sudo chmod 600 "${APP_DIR}/.env"

sudo tee "/etc/systemd/system/${APP_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Shani Time Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${DEPLOY_USER}
Group=${DEPLOY_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${APP_DIR}/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "${APP_NAME}.service"
sudo systemctl stop "${APP_NAME}.service" 2>/dev/null || true

sudo tee "/etc/nginx/sites-available/${APP_NAME}" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${HOST};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

sudo ln -sfn "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx

sudo certbot --nginx \
  --non-interactive \
  --agree-tos \
  --no-eff-email \
  --redirect \
  --keep-until-expiring \
  --email "${CERTBOT_EMAIL}" \
  -d "${HOST}"

echo
echo "Configure ${APP_DIR}/.env, then start the app with:"
echo "  sudo systemctl restart ${APP_NAME}"
echo
echo "Setup done"
echo "Google OAuth URL: https://${HOST}/auth/google"
echo "Twilio webhook URL: https://${HOST}/webhooks/whatsapp"
