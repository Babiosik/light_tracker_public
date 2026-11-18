import { config, offlineTimeoutMs } from './config.js';
import http from 'node:http';
import { errorMessage } from './util.js';
import { ID_RE, getDevice, loadState, recordUnknownPing, reloadDevicesConfig, saveNow } from './store.js';
import { applyStartupGrace, checkOffline, handlePing } from './tracker.js';
import { startDailyScheduler } from './daily.js';
import { startBot } from './bot.js';
import { notifyAdmin } from './telegram.js';
import { formatTime } from './stats.js';

function sendJson(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  req.resume(); // тіло запиту не потрібне
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad url' });
  }

  const match = url.pathname.match(/^\/api\/light\/([^/]+)\/?$/);
  if (match && (req.method === 'GET' || req.method === 'POST')) {
    const id = match[1] ?? '';
    if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: 'bad id' });
    const dev = getDevice(id);
    if (!dev) {
      console.warn(`[http] запит від невідомого пристрою "${id}"`);
      recordUnknownPing(id, Date.now());
      return sendJson(res, 404, { ok: false, error: 'unknown device' });
    }
    handlePing(dev, Date.now());
    return sendJson(res, 200, { ok: true, id: dev.id, status: dev.status });
  }

  if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
  return sendJson(res, 404, { ok: false, error: 'not found' });
});

loadState();

server.listen(config.port, config.host, () => {
  // Таймери запускаємо лише після успішного старту, щоб невдалий запуск не змінював стан.
  applyStartupGrace(Date.now());
  startDailyScheduler();
  setInterval(() => {
    reloadDevicesConfig();
    checkOffline(Date.now());
  }, config.checkIntervalSec * 1000);
  startBot().catch((err) => console.error(`[bot] зупинено: ${errorMessage(err)}`));

  console.log(`Light Tracker слухає ${config.host}:${config.port}`);
  console.log(`Часовий пояс: ${config.timezone}; світло вимкнено після ${offlineTimeoutMs / 1000} с без запитів`);
  if (!config.botToken) console.warn('УВАГА: TELEGRAM_BOT_TOKEN не задано — повідомлення лише пишуться в лог');
  notifyAdmin(`🔄 <b>Сервер перезавантажено</b>\n🕒 ${formatTime(Date.now())}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Отримано ${signal}, зберігаю стан...`);
  saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
