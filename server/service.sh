#!/usr/bin/env bash
# Керування Light Tracker як systemd-сервісом.
#
#   ./service.sh install     зібрати проєкт, встановити й запустити сервіс
#   ./service.sh unit        лише оновити unit-файл (шлях запуску dist/server.js)
#   ./service.sh uninstall   зупинити й видалити сервіс (дані та налаштування лишаються)
#   ./service.sh restart     перезапустити
#   ./service.sh status      стан сервісу
#   ./service.sh logs        логи в реальному часі
#
# Змінні середовища: SERVICE_NAME (light-tracker), RUN_USER (власник папки).
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-light-tracker}"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

die() { echo "Помилка: $*" >&2; exit 1; }

need_root() {
  if [[ $EUID -ne 0 ]]; then
    exec sudo --preserve-env=SERVICE_NAME,RUN_USER bash "${BASH_SOURCE[0]}" "$@"
  fi
}

check_node() {
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] || die "Node.js не знайдено. Встановіть Node.js 22.9 або новіший."
  "$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)' \
    || die "потрібен Node.js 22.9+, зараз $("$NODE_BIN" --version)"
}

# Встановлює залежності та компілює TypeScript у dist/ від імені користувача $1.
build_app() {
  local run_user="$1"
  command -v npm >/dev/null || die "npm не знайдено (потрібен разом з Node.js)"
  echo "Збірка проєкту (npm ci && npm run build)..."
  if [[ "$run_user" == "$(id -un)" ]]; then
    (cd "$SERVER_DIR" && npm ci --no-audit --no-fund && npm run build)
  else
    sudo -u "$run_user" env "PATH=$PATH" bash -c 'cd "$1" && npm ci --no-audit --no-fund && npm run build' _ "$SERVER_DIR"
  fi
}

write_unit() {
  local run_user="$1"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Light Tracker server
After=network-online.target
Wants=network-online.target

[Service]
User=${run_user}
WorkingDirectory=${SERVER_DIR}
ExecStart="${NODE_BIN}" --env-file-if-exists=.env dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

cmd_unit() {
  need_root unit
  check_node
  [[ -f "$UNIT_FILE" ]] || die "сервіс ${SERVICE_NAME} не встановлено (./service.sh install)"
  local run_user
  run_user="$(sed -n 's/^User=//p' "$UNIT_FILE" | head -n1)"
  [[ -n "$run_user" ]] || die "не вдалося визначити користувача з $UNIT_FILE"
  write_unit "$run_user"
  systemctl daemon-reload
  echo "Unit-файл ${UNIT_FILE} оновлено."
}

cmd_install() {
  need_root install
  command -v systemctl >/dev/null || die "systemd не знайдено"
  check_node

  local run_user="${RUN_USER:-${SUDO_USER:-$(stat -c %U "$SERVER_DIR")}}"
  id "$run_user" >/dev/null 2>&1 || die "користувача $run_user не існує"
  [[ "$run_user" != "root" ]] || echo "Увага: сервіс працюватиме від root. Задайте RUN_USER=<user>, щоб змінити."

  cd "$SERVER_DIR"
  if [[ ! -f .env ]]; then
    cp .env.example .env
    echo "Створено .env з .env.example — впишіть TELEGRAM_BOT_TOKEN."
  fi
  if [[ ! -f devices.json ]]; then
    echo '[]' > devices.json
    echo "Створено порожній devices.json — додайте пристрої командою /add у боті."
  fi
  mkdir -p data
  chown -R "$run_user": .env devices.json data
  chmod 600 .env

  build_app "$run_user"
  write_unit "$run_user"

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
  echo
  systemctl --no-pager status "$SERVICE_NAME" || true
  echo
  echo "Готово. Сервіс ${SERVICE_NAME} працює від ${run_user}."
  echo "Не забудьте відкрити TCP-порт (за замовчуванням 8080) у firewall / Security Group."
}

cmd_uninstall() {
  need_root uninstall
  if systemctl list-unit-files "${SERVICE_NAME}.service" --no-legend 2>/dev/null | grep -q "$SERVICE_NAME"; then
    systemctl disable --now "$SERVICE_NAME" || true
  fi
  rm -f "$UNIT_FILE"
  systemctl daemon-reload
  systemctl reset-failed "$SERVICE_NAME" 2>/dev/null || true
  echo "Сервіс ${SERVICE_NAME} видалено. Файли .env, devices.json і data/ залишилися в ${SERVER_DIR}."
}

case "${1:-}" in
  install)   cmd_install ;;
  unit)      cmd_unit ;;
  uninstall) cmd_uninstall ;;
  restart)   need_root restart; systemctl restart "$SERVICE_NAME"; systemctl --no-pager status "$SERVICE_NAME" || true ;;
  status)    systemctl --no-pager status "$SERVICE_NAME" ;;
  logs)      journalctl -u "$SERVICE_NAME" -f ;;
  *)
    sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
