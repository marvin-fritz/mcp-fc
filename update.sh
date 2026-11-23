#!/usr/bin/env bash
# =============================================================================
# mcp-fc – Update Script
# =============================================================================
#
# Usage:
#   sudo bash update.sh   (aus dem Installationsverzeichnis heraus)
#   Normalfall: `fc-deploy mcp-fc` (Finanz-Copilot/ops/fc-deploy)
#
# Holt den Code als Service-User, installiert Abhängigkeiten nur bei
# geändertem package-lock.json, baut nach dist.new und tauscht erst nach
# erfolgreichem Build gegen dist (der alte Stand bleibt in dist.prev), legt
# fehlende Indexes an, startet neu und weist /healthz nach. .env bleibt
# unangetastet. Scheitert Pull oder Build, läuft der Dienst unverändert weiter.
#
# Umgebungsvariablen:
#   PULL_USER=<user>            Als wer gepullt wird (Default: der Service-User).
#   HEALTH_WAIT_SECONDS=<n>     Wartezeit für den Gesundheitscheck (Default: 5).
#   FORCE_INSTALL=1             npm ci auch ohne Lockfile-Änderung.
#   DEPLOY_REF=<sha>            Gesetzt von fc-deploy: der Code steht schon auf
#   DEPLOY_FROM=<sha>           DEPLOY_REF, kein eigener Pull (ein Pull würde
#                               einen Rollback wieder vorspulen).
# =============================================================================

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="mcp-fc"
SERVICE_USER="mcp-fc"
SERVICE_GROUP="mcp-fc"
HEALTH_URL="http://127.0.0.1:8814/healthz"
PULL_USER="${PULL_USER:-${SERVICE_USER}}"
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-5}"
FORCE_INSTALL="${FORCE_INSTALL:-0}"

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${RED}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || error "Run as root: sudo bash update.sh"
command -v npm >/dev/null || error "npm nicht gefunden."

git_as_owner()     { sudo -u "$SERVICE_USER" -H git -C "$INSTALL_DIR" "$@"; }
git_as_pull_user() { sudo -u "$PULL_USER" -H git -C "$INSTALL_DIR" "$@"; }
as_owner()         { sudo -u "$SERVICE_USER" -H bash -c "cd '$INSTALL_DIR' && $*"; }

# --- 1. Code holen, BEVOR der Dienst angefasst wird -------------------------
before="$(git_as_owner rev-parse --short HEAD)"
info "Aktueller Stand: ${before}"
if [[ -n "${DEPLOY_REF:-}" ]]; then
    [[ "$(git_as_owner rev-parse HEAD)" == "$(git_as_owner rev-parse "${DEPLOY_REF}^{commit}")" ]] \
        || error "HEAD steht nicht auf DEPLOY_REF ${DEPLOY_REF} — Abbruch, der Dienst läuft unverändert."
    before="$(git_as_owner rev-parse --short "${DEPLOY_FROM:-HEAD}")"
    info "Code von fc-deploy gesetzt, kein eigener Pull."
elif ! git_as_pull_user pull --ff-only origin main; then
    error "git pull fehlgeschlagen — der Dienst läuft unverändert auf ${before} weiter."
fi
after="$(git_as_owner rev-parse --short HEAD)"
[[ "$before" == "$after" ]] && info "Kein neuer Commit — Build und Dienst werden trotzdem erneuert." \
                            || info "Code: ${before} -> ${after}"

# --- 2. Abhängigkeiten nur bei Lockfile-Änderung ------------------------------
if [[ "$FORCE_INSTALL" == 1 || ! -d "${INSTALL_DIR}/node_modules" ]] \
    || ! git_as_owner diff --quiet "$before" "$after" -- package-lock.json; then
    info "npm ci..."
    as_owner "npm ci --no-audit --no-fund"
else
    info "Abhängigkeiten unverändert (package-lock.json gleich)."
fi

# --- 3. Bauen, ohne den laufenden Stand anzufassen ---------------------------
info "Building nach dist.new..."
as_owner "rm -rf dist.new && npm run build -- --outDir dist.new"
[[ -f "${INSTALL_DIR}/dist.new/server.js" ]] || error "Build ohne dist.new/server.js — Dienst läuft unverändert weiter."

# Indexes sind idempotent. Die .env liest Node selbst (--env-file); kein
# `source`, damit keine Zeile daraus im Log landet.
info "Indexes prüfen (ensure-indexes)..."
if ! as_owner "npx tsx --env-file=.env scripts/ensure-indexes.ts" >/dev/null; then
    warn "ensure-indexes fehlgeschlagen — weiter mit dem Deploy, Indexes später prüfen: npm run ensure-indexes"
fi

# --- 4. Tauschen, Neustart, Nachweis -----------------------------------------
as_owner "rm -rf dist.prev && { [[ ! -d dist ]] || mv dist dist.prev; } && mv dist.new dist"
info "Restarting ${SERVICE_NAME}..."
systemctl restart "$SERVICE_NAME"
restarts_before="$(systemctl show "$SERVICE_NAME" -p NRestarts --value 2>/dev/null || echo 0)"
sleep "$HEALTH_WAIT_SECONDS"
state="$(systemctl is-active "$SERVICE_NAME" || true)"
restarts_after="$(systemctl show "$SERVICE_NAME" -p NRestarts --value 2>/dev/null || echo 0)"
http="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo 000)"

if [[ "$state" != "active" ]] || (( ${restarts_after:-0} > ${restarts_before:-0} )) || [[ "$http" != "200" ]]; then
    warn "Dienst nicht gesund: status=${state}, Neustarts ${restarts_before} -> ${restarts_after}, HTTP ${http}"
    journalctl _SYSTEMD_UNIT="${SERVICE_NAME%.service}.service" -n 30 --no-pager || true
    if [[ -d "${INSTALL_DIR}/dist.prev" ]]; then
        warn "Schalte auf den vorigen Build (dist.prev) zurück und starte neu."
        as_owner "rm -rf dist.failed && mv dist dist.failed && mv dist.prev dist"
        systemctl restart "$SERVICE_NAME" || true
    fi
    error "Update auf ${after} ist NICHT gesund. Der vorige Build läuft wieder; der Code steht auf ${after}.
  Zurück auch mit dem Code: fc-deploy rollback mcp-fc"
fi

ok "mcp-fc aktualisiert — Stand ${after}, Dienst ${state}, HTTP ${http}."
