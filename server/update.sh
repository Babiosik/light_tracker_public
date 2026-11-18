#!/usr/bin/env bash
# Скидає всі локальні зміни в репозиторії, завантажує свіжу версію з git
# і перезапускає сервіс, якщо він встановлений.
#
#   ./update.sh
#
# Запускайте від користувача-власника репозиторію (не через sudo):
# для перезапуску сервісу скрипт сам попросить sudo.
#
# Змінні середовища: REMOTE (origin), BRANCH (поточна гілка), SERVICE_NAME (light-tracker).
#
# .env, devices.json і data/ ігноруються git, тому НЕ видаляються.
set -euo pipefail

# Увесь скрипт у { ... exit; }: bash читає його повністю до виконання,
# тож git може безпечно замінити цей файл під час оновлення.
{
SERVICE_NAME="${SERVICE_NAME:-light-tracker}"
SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "Помилка: $*" >&2; exit 1; }

command -v git >/dev/null || die "git не знайдено"
REPO_DIR="$(git -C "$SERVER_DIR" rev-parse --show-toplevel)" || die "$SERVER_DIR не в git-репозиторії"
cd "$REPO_DIR"

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
[[ "$BRANCH" != "HEAD" ]] || die "репозиторій не на гілці; задайте BRANCH=<гілка>"
git remote get-url "$REMOTE" >/dev/null 2>&1 || die "remote '$REMOTE' не налаштовано (git remote add $REMOTE <url>)"

OLD="$(git rev-parse --short HEAD 2>/dev/null || echo none)"

echo "Завантаження ${REMOTE}/${BRANCH}..."
git fetch --prune "$REMOTE"
git checkout -q -B "$BRANCH" "${REMOTE}/${BRANCH}"
git reset --hard "${REMOTE}/${BRANCH}"
git clean -fd   # без -x: ігноровані файли (.env, devices.json, data/) залишаються

NEW="$(git rev-parse --short HEAD)"
if [[ "$OLD" == "$NEW" ]]; then
  echo "Вже актуальна версія ($NEW)."
else
  echo "Оновлено: $OLD -> $NEW"
  git --no-pager log --oneline "${OLD}..${NEW}" 2>/dev/null || true
fi

echo "Збірка проєкту (npm ci && npm run build)..."
command -v npm >/dev/null || die "npm не знайдено (потрібен разом з Node.js)"
(cd "$SERVER_DIR" && npm ci --no-audit --no-fund && npm run build)

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
if [[ -f "$UNIT_FILE" ]]; then
  SUDO=""
  [[ $EUID -eq 0 ]] || SUDO="sudo"
  if grep -q 'src/server.js' "$UNIT_FILE"; then
    echo "Оновлення unit-файлу (запуск з dist/server.js)..."
    $SUDO env "SERVICE_NAME=$SERVICE_NAME" bash "$SERVER_DIR/service.sh" unit
  fi
  echo "Перезапуск сервісу ${SERVICE_NAME}..."
  $SUDO systemctl restart "$SERVICE_NAME"
  $SUDO systemctl --no-pager status "$SERVICE_NAME" || true
else
  echo "Сервіс ${SERVICE_NAME} не встановлено — перезапуск пропущено (./service.sh install)."
fi
exit 0
}
