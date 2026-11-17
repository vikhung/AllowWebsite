import { loadState, isProtectionActive, isPaused, isHostAllowed } from '../lib/store.js';

const $ = (id) => document.getElementById(id);

(async () => {
  const { config, whitelist } = await loadState();
  if (!config.passwordHash) {
    $('dot').className = 'dot off';
    $('status').textContent = '尚未設定';
    $('dot2').parentElement.classList.add('hidden');
    return;
  }
  // 管理功能 1：白名單管理
  const active = isProtectionActive(config);
  const paused = isPaused(config);
  $('dot').className = 'dot' + (active ? '' : paused ? ' warn' : ' off');
  $('status').textContent = active
    ? '白名單管理：封鎖中'
    : paused
      ? `白名單管理：暫停至 ${new Date(config.blocking.pauseUntil).toLocaleTimeString()}`
      : '白名單管理：未啟用';
  // 管理功能 2：網站瀏覽通知
  $('dot2').className = 'dot' + (config.monitor.enabled ? '' : ' off');
  $('status2').textContent = '網站瀏覽通知：' + (config.monitor.enabled ? '啟用中' : '未啟用');

  if (!config.blocking.enabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab?.url || '');
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      $('site').textContent = isHostAllowed(u.hostname, whitelist)
        ? `✅ ${u.hostname} 在白名單中`
        : `⛔ ${u.hostname} 不在白名單中`;
    }
  } catch {
    /* 非一般網頁 */
  }
})();

$('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
