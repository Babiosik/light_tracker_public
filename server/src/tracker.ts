import { offlineTimeoutMs } from './config.js';
import { allDevices, saveNow, scheduleSave, type Device, type Status } from './store.js';
import { HOUR_MS, accrue, lightOffMessage, lightOnMessage } from './stats.js';
import { sendToSubscriptions } from './telegram.js';

function switchStatus(dev: Device, status: Status, at: number): void {
  accrue(dev, at);
  const prevChange = dev.lastChange ? Date.parse(dev.lastChange) : null;
  const prevDurationHours = prevChange == null ? null : Math.max(0, at - prevChange) / HOUR_MS;

  dev.status = status;
  dev.lastChange = new Date(at).toISOString();
  dev.switchCount += 1;
  dev.today.switchCount += 1;
  dev.today.events.push({ at, status });
  saveNow(); // зміни статусу рідкісні й важливі — пишемо одразу, без затримки

  console.log(`[${dev.id}] статус -> ${status}`);
  const build = status === 'on'
    ? (name: string) => lightOnMessage(dev, name, prevDurationHours, at)
    : (name: string) => lightOffMessage(dev, name, prevDurationHours, at);
  sendToSubscriptions(dev.chats, build);
}

/** Запит від пристрою: світло є. */
export function handlePing(dev: Device, now: number): void {
  dev.lastSeen = now;
  if (dev.status !== 'on') switchStatus(dev, 'on', now);
  scheduleSave();
}

/** Пристрої, що мовчать довше за допустимий час, переводимо у "вимкнено". */
export function checkOffline(now: number): void {
  for (const dev of allDevices()) {
    if (dev.status === 'on' && dev.lastSeen != null && now - dev.lastSeen > offlineTimeoutMs) {
      // Світло зникло приблизно після останнього успішного запиту.
      switchStatus(dev, 'off', dev.lastSeen);
    }
  }
}

/**
 * Після перезапуску сервера не можна одразу вважати "увімкнені" пристрої зниклими:
 * даємо їм повний таймаут, щоб надіслати запит.
 */
export function applyStartupGrace(now: number): void {
  for (const dev of allDevices()) {
    if (dev.status === 'on') dev.lastSeen = Math.max(dev.lastSeen ?? 0, now);
  }
}
