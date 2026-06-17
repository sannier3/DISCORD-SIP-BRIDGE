#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/sannier3/DISCORD-SIP-BRIDGE.git"
REPO_BRANCH="main"
RAW_INSTALL_URL="https://raw.githubusercontent.com/sannier3/DISCORD-SIP-BRIDGE/main/deploy/install-bot.sh"

if [[ ${EUID} -ne 0 ]]; then
    echo "Ce script doit être exécuté en root." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLONE_DIR=""

cleanup() {
    if [[ -n "${CLONE_DIR}" && -d "${CLONE_DIR}" ]]; then
        rm -rf "${CLONE_DIR}"
    fi
}
trap cleanup EXIT

TARGET_DIR="/opt/discord-sip-bridge"
SERVICE_USER="discord-sip"
CREDENTIALS_FILE="/root/discord-asterisk-credentials.txt"

apt-get update
apt-get install -y ca-certificates curl git build-essential pkg-config libopus-dev libsodium-dev

if [[ ! -f "${SOURCE_DIR}/server.js" ]]; then
    echo "Téléchargement des sources depuis ${REPO_URL} (branche ${REPO_BRANCH})..."
    CLONE_DIR="$(mktemp -d)"
    git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${CLONE_DIR}"
    SOURCE_DIR="${CLONE_DIR}"
    SCRIPT_DIR="${CLONE_DIR}/deploy"
elif [[ -d "${SOURCE_DIR}/.git" ]]; then
    echo "Mise à jour des sources locales depuis ${REPO_URL} (branche ${REPO_BRANCH})..."
    git -C "${SOURCE_DIR}" fetch --depth 1 origin "${REPO_BRANCH}"
    git -C "${SOURCE_DIR}" checkout "${REPO_BRANCH}"
    git -C "${SOURCE_DIR}" reset --hard "origin/${REPO_BRANCH}"
fi

UPDATING=false
WAS_RUNNING=false
if [[ -f "${TARGET_DIR}/server.js" ]]; then
    UPDATING=true
    echo "Mise à jour de l'installation existante dans ${TARGET_DIR}..."
    if systemctl is-active --quiet discord-sip-bridge 2>/dev/null; then
        WAS_RUNNING=true
        echo "Arrêt temporaire du service discord-sip-bridge..."
        systemctl stop discord-sip-bridge
    fi
else
    echo "Nouvelle installation dans ${TARGET_DIR}..."
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

install -d -o root -g "${SERVICE_USER}" -m 0750 "${TARGET_DIR}"
install -o root -g "${SERVICE_USER}" -m 0640 "${SOURCE_DIR}/server.js" "${TARGET_DIR}/server.js"
install -o root -g "${SERVICE_USER}" -m 0640 "${SOURCE_DIR}/package.json" "${TARGET_DIR}/package.json"
install -o root -g "${SERVICE_USER}" -m 0640 "${SOURCE_DIR}/package-lock.json" "${TARGET_DIR}/package-lock.json"

cd "${TARGET_DIR}"
npm ci --omit=dev
npm run check
chown -R root:"${SERVICE_USER}" "${TARGET_DIR}"
find "${TARGET_DIR}/node_modules" -type d -exec chmod 0750 {} +
find "${TARGET_DIR}/node_modules" -type f -exec chmod 0640 {} +
find "${TARGET_DIR}/node_modules/.bin" -type l -exec chmod -h 0770 {} + 2>/dev/null || true

if [[ ! -f "${TARGET_DIR}/.env" ]]; then
    ARI_BASE_URL="http://127.0.0.1:8088"
    ARI_USERNAME="discordbot"
    ARI_PASSWORD=""
    ARI_APPLICATION="discord-sip"
    PJSIP_ENDPOINT="yeastar"

    if [[ -r "${CREDENTIALS_FILE}" ]]; then
        ARI_BASE_URL="$(sed -n 's/^ARI_URL=//p' "${CREDENTIALS_FILE}" | tail -n 1)"
        ARI_USERNAME="$(sed -n 's/^ARI_USERNAME=//p' "${CREDENTIALS_FILE}" | tail -n 1)"
        ARI_PASSWORD="$(sed -n 's/^ARI_PASSWORD=//p' "${CREDENTIALS_FILE}" | tail -n 1)"
        ARI_APPLICATION="$(sed -n 's/^ARI_APPLICATION=//p' "${CREDENTIALS_FILE}" | tail -n 1)"
        PJSIP_ENDPOINT="$(sed -n 's/^PJSIP_ENDPOINT=//p' "${CREDENTIALS_FILE}" | tail -n 1)"
    fi

    cat > "${TARGET_DIR}/.env" <<ENVEOF
DISCORD_TOKEN=
DISCORD_GUILD_ID=

ARI_BASE_URL=${ARI_BASE_URL:-http://127.0.0.1:8088}
ARI_USERNAME=${ARI_USERNAME:-discordbot}
ARI_PASSWORD=${ARI_PASSWORD}
ARI_APPLICATION=${ARI_APPLICATION:-discord-sip}
PJSIP_ENDPOINT=${PJSIP_ENDPOINT:-yeastar}

CALLER_ID_NAME=Discord Bridge
CALLER_ID_NUMBER=1000

AUTHORIZED_USER_IDS=
AUTHORIZED_ROLE_IDS=

RESTRICT_COMMANDS_TO_AUTHORIZED_ONLY=false
RESTRICT_COMMANDS_TO_VOICE_TEXT=false
HIDE_CALLED_NUMBER=true
STATUS_REFRESH_INTERVAL_SECONDS=5

ALLOWED_NUMBER_REGEX=^(?:0[1-7]|09)[0-9]{8}$
CALL_TIMEOUT_SECONDS=60
MAX_CALL_DURATION_SECONDS=3600
MAX_CONCURRENT_CALLS=1
CALLS_PER_HOUR_PER_USER=5
REGISTER_COMMANDS=true
ENVEOF

    chown root:"${SERVICE_USER}" "${TARGET_DIR}/.env"
    chmod 0640 "${TARGET_DIR}/.env"
fi

install -o root -g root -m 0644 "${SCRIPT_DIR}/discord-sip-bridge.service" /etc/systemd/system/discord-sip-bridge.service
systemctl daemon-reload
systemctl enable discord-sip-bridge.service

if [[ "${UPDATING}" == true ]]; then
    if [[ "${WAS_RUNNING}" == true ]]; then
        echo "Redémarrage du service discord-sip-bridge..."
        systemctl restart discord-sip-bridge
    fi

    echo
    echo "Mise à jour terminée."
    echo "Configuration conservée : ${TARGET_DIR}/.env"
    echo "État du service : systemctl status discord-sip-bridge --no-pager -l"
    echo "Journaux : journalctl -u discord-sip-bridge -f"
else
    echo
    echo "Installation terminée."
    echo "Configuration : ${TARGET_DIR}/.env"
    echo "Démarrage : systemctl start discord-sip-bridge"
    echo "Journaux : journalctl -u discord-sip-bridge -f"
fi

echo "Installation ou mise à jour : curl -fsSL ${RAW_INSTALL_URL} | bash"
