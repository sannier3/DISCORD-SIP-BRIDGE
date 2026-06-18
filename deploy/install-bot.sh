#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="https://github.com/sannier3/DISCORD-SIP-BRIDGE.git"
REPO_BRANCH="main"
RAW_INSTALL_URL="https://raw.githubusercontent.com/sannier3/DISCORD-SIP-BRIDGE/main/deploy/install-bot.sh"

NPM_LOGLEVEL="info"
VERBOSE=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        -v|--verbose)
            NPM_LOGLEVEL="silly"
            VERBOSE=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [-v|--verbose]"
            echo "  -v, --verbose   Affiche la sortie détaillée de npm (compilation incluse)"
            exit 0
            ;;
        *)
            echo "Option inconnue : $1 (essayez --help)" >&2
            exit 1
            ;;
    esac
done

if [[ ${EUID} -ne 0 ]]; then
    echo "Ce script doit être exécuté en root." >&2
    exit 1
fi

# Avec "curl | bash", BASH_SOURCE[0] est vide : on clone toujours depuis GitHub.
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
if [[ -n "${SCRIPT_PATH}" && -f "${SCRIPT_PATH}" ]]; then
    SCRIPT_DIR="$(cd "$(dirname "${SCRIPT_PATH}")" && pwd)"
    SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
    SCRIPT_DIR=""
    SOURCE_DIR=""
fi
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
export DEBIAN_FRONTEND=noninteractive

log() {
    echo "[$(date +%H:%M:%S)] $*"
}

run_npm() {
    local empty_npmrc status
    empty_npmrc="$(mktemp)"

    # Ignore toute config npm globale (registre interne, cache, etc.)
    unset npm_config_registry npm_config_userconfig npm_config_globalconfig npm_config_cache npm_config_progress
    unset NPM_CONFIG_REGISTRY NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_CACHE || true
    export CI=true

    npm --userconfig="${empty_npmrc}" --globalconfig="${empty_npmrc}" "$@"
    status=$?
    rm -f "${empty_npmrc}"
    return "${status}"
}

install_npm_dependencies() {
    log "Test de connectivité vers registry.npmjs.org..."
    if ! curl -fsS --max-time 20 -o /dev/null "https://registry.npmjs.org/"; then
        log "ERREUR : registry.npmjs.org inaccessible depuis ce serveur."
        exit 1
    fi

    log "npm $(npm -v), node $(node -v)"
    log "Nettoyage de node_modules..."
    rm -rf "${TARGET_DIR}/node_modules"
    rm -f "${TARGET_DIR}/.npmrc"

    log "Installation des dépendances npm (loglevel=${NPM_LOGLEVEL}, 2 à 10 minutes)..."
    if [[ "${VERBOSE}" == true ]]; then
        log "Mode verbeux : chaque ligne npm est affichée, signalement toutes les 30 s."
    fi

    local npm_args=(
        ci --omit=dev
        --registry=https://registry.npmjs.org/
        --foreground-scripts
        --no-progress
        --loglevel="${NPM_LOGLEVEL}"
        --fetch-timeout=120000
        --fetch-retries=5
    )

    if [[ "${VERBOSE}" == true ]]; then
        (
            while true; do
                sleep 30
                log "npm toujours en cours..."
            done
        ) &
        local heartbeat_pid=$!
        set +e
        run_npm "${npm_args[@]}" 2>&1 | while IFS= read -r line; do
            printf '[npm] %s\n' "${line}"
        done
        local npm_status=${PIPESTATUS[0]}
        set -e
        kill "${heartbeat_pid}" 2>/dev/null || true
        wait "${heartbeat_pid}" 2>/dev/null || true
        if [[ "${npm_status}" -ne 0 ]]; then
            exit "${npm_status}"
        fi
    else
        run_npm "${npm_args[@]}"
    fi
}

apt_install() {
    if command -v debconf-set-selections >/dev/null 2>&1; then
        echo 'man-db man-db/auto-update boolean false' | debconf-set-selections
    fi

    log "Mise à jour des paquets système (peut prendre 1 à 3 minutes, man-db ignoré)..."
    apt-get update -qq
    apt-get install -y --no-install-recommends \
        -o Dpkg::Options::="--force-confdef" \
        -o Dpkg::Options::="--force-confold" \
        "$@"
}

stop_service_if_running() {
    if ! systemctl is-active --quiet discord-sip-bridge 2>/dev/null; then
        return 1
    fi

    log "Arrêt du service discord-sip-bridge (max. 25 s)..."
    if timeout 25 systemctl stop discord-sip-bridge; then
        log "Service arrêté."
        return 0
    fi

    log "Arrêt forcé du service..."
    systemctl kill discord-sip-bridge 2>/dev/null || true
    timeout 10 systemctl stop discord-sip-bridge 2>/dev/null || true
    return 0
}

apt_install ca-certificates curl git build-essential pkg-config libopus-dev libsodium-dev

if [[ ! -f "${SOURCE_DIR}/server.js" ]]; then
    log "Téléchargement des sources depuis ${REPO_URL} (branche ${REPO_BRANCH})..."
    CLONE_DIR="$(mktemp -d)"
    git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${CLONE_DIR}"
    SOURCE_DIR="${CLONE_DIR}"
    SCRIPT_DIR="${CLONE_DIR}/deploy"
elif [[ -d "${SOURCE_DIR}/.git" ]]; then
    log "Mise à jour des sources locales depuis ${REPO_URL} (branche ${REPO_BRANCH})..."
    git -C "${SOURCE_DIR}" fetch --depth 1 origin "${REPO_BRANCH}"
    git -C "${SOURCE_DIR}" checkout "${REPO_BRANCH}"
    git -C "${SOURCE_DIR}" reset --hard "origin/${REPO_BRANCH}"
fi

UPDATING=false
WAS_RUNNING=false
if [[ -f "${TARGET_DIR}/server.js" ]]; then
    UPDATING=true
    log "Mise à jour de l'installation existante dans ${TARGET_DIR}..."
    if stop_service_if_running; then
        WAS_RUNNING=true
    fi
else
    log "Nouvelle installation dans ${TARGET_DIR}..."
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
    log "Installation de Node.js 22 (peut prendre 1 à 2 minutes)..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt_install nodejs
    log "Node.js $(node -v) installé."
else
    log "Node.js $(node -v) déjà présent."
fi

if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
    useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin "${SERVICE_USER}"
fi

log "Copie des fichiers de l'application..."
install -d -o root -g "${SERVICE_USER}" -m 0750 "${TARGET_DIR}"
install -o root -g "${SERVICE_USER}" -m 0640 "${SOURCE_DIR}/server.js" "${TARGET_DIR}/server.js"
install -o root -g "${SERVICE_USER}" -m 0640 "${SOURCE_DIR}/package.json" "${TARGET_DIR}/package.json"
install -o root -g "${SERVICE_USER}" -m 0640 "${SOURCE_DIR}/package-lock.json" "${TARGET_DIR}/package-lock.json"

cd "${TARGET_DIR}"
install_npm_dependencies
log "Vérification du code..."
run_npm run check --registry=https://registry.npmjs.org/

log "Application des permissions..."
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

    log "Création du fichier de configuration ${TARGET_DIR}/.env"
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
else
    log "Configuration existante conservée : ${TARGET_DIR}/.env"
fi

log "Mise à jour du service systemd..."
install -o root -g root -m 0644 "${SCRIPT_DIR}/discord-sip-bridge.service" /etc/systemd/system/discord-sip-bridge.service
systemctl daemon-reload
systemctl enable discord-sip-bridge.service

if [[ "${UPDATING}" == true ]]; then
    if [[ "${WAS_RUNNING}" == true ]]; then
        log "Redémarrage du service discord-sip-bridge..."
        systemctl restart discord-sip-bridge
    fi

    echo
    log "Mise à jour terminée."
    echo "Configuration conservée : ${TARGET_DIR}/.env"
    echo "État du service : systemctl status discord-sip-bridge --no-pager -l"
    echo "Journaux : journalctl -u discord-sip-bridge -f"
else
    echo
    log "Installation terminée."
    echo "Configuration : ${TARGET_DIR}/.env"
    echo "Démarrage : systemctl start discord-sip-bridge"
    echo "Journaux : journalctl -u discord-sip-bridge -f"
fi

echo "Installation ou mise à jour : curl -fsSL ${RAW_INSTALL_URL} | bash"
echo "Mode verbeux : curl -fsSL ${RAW_INSTALL_URL} | bash -s -- --verbose"
