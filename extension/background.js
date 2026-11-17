import {
  loadState,
  isProtectionActive,
  isPaused,
  isHostAllowed,
  buildNotifyRequest,
  SYSTEM_ALLOW,
} from './lib/store.js';

const APP_NAME = '孩童安心上網管理平台';
const BLOCK_RULE_ID = 1;
const ALLOW_RULE_ID = 2;
const RESUME_ALARM = 'resume-protection';
const BLOCKED_PAGE = chrome.runtime.getURL('pages/blocked.html');

// =====================================================================
// 管理功能 1：白名單管理（封鎖規則）
// =====================================================================

let applying = Promise.resolve();

/** 依目前設定重建 declarativeNetRequest 規則（串行執行，避免同時更新互相覆蓋） */
function applyRules() {
  applying = applying.then(doApply, doApply);
  return applying;
}

async function doApply() {
  const { config, whitelist } = await loadState();
  const active = isProtectionActive(config);

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = [];
  if (active) {
    // 規則 1（低優先）：所有網頁導向「已封鎖」頁面，並把原網址放在 # 後面
    addRules.push({
      id: BLOCK_RULE_ID,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: BLOCKED_PAGE + '#\\0' } },
      condition: { regexFilter: '^https?://.*', resourceTypes: ['main_frame'] },
    });
    // 規則 2（高優先）：白名單網域（含子網域）放行
    addRules.push({
      id: ALLOW_RULE_ID,
      priority: 2,
      action: { type: 'allow' },
      condition: { requestDomains: [...new Set([...SYSTEM_ALLOW, ...whitelist])], resourceTypes: ['main_frame'] },
    });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules,
  });

  // 暫停結束時自動恢復
  await chrome.alarms.clear(RESUME_ALARM);
  if (isPaused(config)) {
    chrome.alarms.create(RESUME_ALARM, { when: config.blocking.pauseUntil + 500 });
  }

  await updateBadge(config, active);
  if (active) await enforceOpenTabs(whitelist);
}

async function updateBadge(config, active) {
  const paused = isPaused(config);
  const parts = [];
  if (active) parts.push('白名單封鎖中');
  else if (paused) parts.push('白名單封鎖暫停中');
  if (config.monitor.enabled) parts.push('瀏覽通知中');
  await chrome.action.setTitle({ title: `${APP_NAME}${parts.length ? '：' + parts.join('、') : ''}` });
  await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
  await chrome.action.setBadgeText({ text: paused ? '暫停' : '' });
}

/** 已開啟、但不在白名單的分頁，立即導向封鎖頁（例如家長剛移除某網站） */
async function enforceOpenTabs(whitelist) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    try {
      const url = new URL(tab.url);
      if (!isHostAllowed(url.hostname, whitelist)) {
        await chrome.tabs.update(tab.id, { url: BLOCKED_PAGE + '#' + tab.url });
      }
    } catch {
      /* 分頁可能已關閉 */
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await applyRules();
  const { config } = await loadState();
  if (!config.passwordHash) {
    // 新電腦剛安裝時，雲端設定可能還沒同步下來；設定頁會顯示等待同步的提示
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(applyRules);

// 其他電腦（或本機設定頁）修改設定 → 自動重建規則
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') applyRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RESUME_ALARM) applyRules();
});

// =====================================================================
// 通知（管理功能 1 的封鎖通知、管理功能 2 的瀏覽通知，各自使用自己的 API 設定）
// =====================================================================

const THROTTLE_MS = {
  blocked: 60 * 1000, // 封鎖通知：同一網域 60 秒內只通知一次
  visit: 5 * 60 * 1000, // 瀏覽通知：同一網域 5 分鐘內只通知一次
};
const NOTIFY_TIMEOUT_MS = 10 * 1000;

/** 目前 Chrome 設定檔登入的 Google 帳號 email；未登入時為空字串 */
async function getUserEmail() {
  try {
    const info = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    return info?.email || '';
  } catch {
    return '';
  }
}

/** 依 API 設定送出通知。page = { url, title } */
async function sendNotify(notify, page) {
  const email = await getUserEmail();
  let host = '';
  try {
    host = new URL(page.url).hostname;
  } catch {
    /* ignore */
  }
  const now = new Date();
  const req = buildNotifyRequest(notify, {
    url: page.url,
    host,
    title: page.title || host,
    email: email || '（未登入 Chrome）',
    time: now.toISOString(),
    localTime: now.toLocaleString('zh-TW', { hour12: false }),
    timestamp: now.getTime(),
  });
  if (!req) return { ok: false, error: '通知設定無效（請檢查 URL）' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(req.url, {
      ...req.init,
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '逾時' : String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 節流後送出通知。kind：'blocked' | 'visit' */
async function notifyThrottled(kind, notify, page) {
  let host;
  try {
    const u = new URL(page.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    host = u.hostname;
  } catch {
    return;
  }
  // 節流紀錄放在 storage.session，service worker 重啟後仍有效
  const key = `notified:${kind}:${host}`;
  const last = (await chrome.storage.session.get(key))[key] || 0;
  if (Date.now() - last < THROTTLE_MS[kind]) return;
  await chrome.storage.session.set({ [key]: Date.now() });
  const result = await sendNotify(notify, page);
  if (!result.ok) console.warn(`[${APP_NAME}] 通知失敗`, kind, result);
}

// 管理功能 1：封鎖頁回報「孩子開啟了非白名單網站」
async function onBlocked(url) {
  const { config } = await loadState();
  if (!isProtectionActive(config) || !config.blocking.notify.enabled) return;
  await notifyThrottled('blocked', config.blocking.notify, { url });
}

// 管理功能 2：網頁載入完成時回報（此時才拿得到網頁標題）。
// 被封鎖的網址會變成擴充功能的封鎖頁（非 http/https），不會算成「瀏覽」。
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || tab.incognito || !tab.url) return;
  const { config } = await loadState();
  if (!config.monitor.enabled) return;
  await notifyThrottled('visit', config.monitor.notify, { url: tab.url, title: tab.title });
});

// =====================================================================
// 訊息
// =====================================================================

function fromExtensionPage(sender, page) {
  return sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(page));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 只接受「分頁最上層」的封鎖頁回報，避免網頁把封鎖頁嵌入 iframe 來濫發通知
  if (msg?.type === 'blocked' && fromExtensionPage(sender, 'pages/blocked.html') && sender.frameId === 0) {
    onBlocked(String(msg.url || ''));
    return;
  }
  if (msg?.type === 'testNotify' && fromExtensionPage(sender, 'pages/options.html')) {
    sendNotify(msg.notify, { url: 'https://example.com/test-page', title: '測試網頁（這是測試通知）' }).then(
      sendResponse
    );
    return true;
  }
  if (msg?.type === 'apply') {
    applyRules().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e) })
    );
    return true;
  }
});
