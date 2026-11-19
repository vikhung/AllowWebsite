import {
  loadState,
  isProtectionActive,
  isPaused,
  isHostAllowed,
  loadUsage,
  getDeviceName,
  SYSTEM_ALLOW,
  USAGE_PREFIX,
  USAGE_KEEP_DAYS,
  DEVICE_NAME_KEY,
} from './lib/store.js';
import { buildMessage, buildToolRequest, isNotifyConfigured } from './lib/tools.js';
import { latestDue, reportDays, dateKey, addDays, hostKey, buildReport, sampleUsage } from './lib/report.js';

const APP_NAME = '孩童安心上網管理平台';
const BLOCK_RULE_ID = 1;
const ALLOW_RULE_ID = 2;
const RESUME_ALARM = 'resume-protection';
const USAGE_TICK_ALARM = 'usage-tick'; // 管理功能 3：每分鐘結算停留時間、檢查是否該寄報告
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
  await syncReportScheduler(config);
}

async function updateBadge(config, active) {
  const paused = isPaused(config);
  const parts = [];
  if (active) parts.push('白名單封鎖中');
  else if (paused) parts.push('白名單封鎖暫停中');
  if (config.monitor.enabled) parts.push('瀏覽通知中');
  if (config.report.enabled) parts.push('記錄上網時間中');
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
  await ensureDeviceName();
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
  if (alarm.name === USAGE_TICK_ALARM) track().then(checkReports);
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

/** 所有通知共用的變數：{{email}} {{time}} {{localTime}} {{timestamp}} */
async function baseVars() {
  const email = await getUserEmail();
  const now = new Date();
  return {
    email: email || '（未登入 Chrome）',
    time: now.toISOString(),
    localTime: now.toLocaleString('zh-TW', { hour12: false }),
    timestamp: now.getTime(),
  };
}

/**
 * 送出網頁相關通知（定型化訊息，依通知工具轉換格式）。
 * kind：'blocked' | 'visit'；page = { url, title }
 */
async function sendNotify(notify, kind, page) {
  let host = '';
  try {
    host = new URL(page.url).hostname;
  } catch {
    /* ignore */
  }
  const vars = { ...(await baseVars()), url: page.url, host, title: page.title || host };
  return sendRequest(notify, buildMessage(kind, vars), vars);
}

/** md = 簡易 Markdown 訊息；vars = 自訂 API 可用的變數 */
async function sendRequest(notify, md, vars) {
  const req = buildToolRequest(notify, md, vars);
  if (!req) return { ok: false, error: '通知設定不完整或格式不正確' };
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
  const result = await sendNotify(notify, kind, page);
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
// 管理功能 3：上網摘要報告
//   停留時間：只計算「Chrome 在前景、使用者沒有閒置」時的作用中分頁；
//   正在播放聲音的分頁（例如看影片）即使沒有操作也照樣計時，螢幕鎖定時一律停止。
//   統計存在 storage.local（每台電腦各自記錄、各自寄出報告）。
// =====================================================================

const IDLE_SECONDS = 120;
const MAX_SLICE_MS = 90 * 1000; // 單次結算上限：電腦睡眠喚醒後，不把整段睡眠時間算進去
const REPORT_RETRY_MS = 15 * 60 * 1000;
const CUR_KEY = 'usageCur'; // storage.session：{ host, since } 目前正在計時的網站
const REPORT_STATE_KEY = 'reportState'; // storage.local：{ daily, weekly, retryAfter, prunedOn }

chrome.idle.setDetectionInterval(IDLE_SECONDS);

let tracking = Promise.resolve();
/** 結算上一段停留時間並開始下一段（串行執行，避免同時寫入互相覆蓋） */
function track() {
  tracking = tracking.then(doTrack, doTrack);
  return tracking;
}

/** 目前應該計時的網域；不該計時時回傳 null */
async function currentHost(config) {
  if (!config.report.enabled) return null;
  const state = await chrome.idle.queryState(IDLE_SECONDS);
  if (state === 'locked') return null;
  let win;
  try {
    win = await chrome.windows.getLastFocused({ windowTypes: ['normal', 'popup'] });
  } catch {
    return null; // 沒有開啟的視窗
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
  if (!tab?.url || tab.incognito) return null;
  if (!((win.focused && state === 'active') || tab.audible)) return null;
  try {
    const u = new URL(tab.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return hostKey(u.hostname) || null;
  } catch {
    return null;
  }
}

async function doTrack() {
  const now = Date.now();
  const cur = (await chrome.storage.session.get(CUR_KEY))[CUR_KEY];
  if (cur?.host) {
    const slice = Math.min(now - cur.since, MAX_SLICE_MS);
    if (slice > 0) {
      const key = USAGE_PREFIX + dateKey(now);
      const day = (await chrome.storage.local.get(key))[key] || {};
      day[cur.host] = (day[cur.host] || 0) + slice;
      await chrome.storage.local.set({ [key]: day });
    }
  }
  const { config } = await loadState();
  const host = await currentHost(config);
  await chrome.storage.session.set({ [CUR_KEY]: host ? { host, since: now } : null });
}

chrome.tabs.onActivated.addListener(() => track());
chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (tab.active && (info.url || info.status === 'complete' || 'audible' in info)) track();
});
chrome.tabs.onRemoved.addListener(() => track());
chrome.windows.onFocusChanged.addListener(() => track());
chrome.idle.onStateChanged.addListener(() => track());

/** 依「上網摘要報告」是否啟用，建立或清除每分鐘的計時器 */
async function syncReportScheduler(config) {
  if (config.report.enabled) {
    if (!(await chrome.alarms.get(USAGE_TICK_ALARM))) {
      chrome.alarms.create(USAGE_TICK_ALARM, { periodInMinutes: 1 });
    }
    await track();
    await checkReports();
  } else {
    await chrome.alarms.clear(USAGE_TICK_ALARM);
    await track(); // 結算最後一段，並停止計時
    await chrome.storage.local.remove(REPORT_STATE_KEY); // 下次啟用時重新起算，不補寄舊報告
  }
}

async function ensureDeviceName() {
  if (await getDeviceName()) return;
  const { os } = await chrome.runtime.getPlatformInfo();
  const label = { win: 'Windows', mac: 'Mac', cros: 'Chromebook', linux: 'Linux' }[os] || '電腦';
  const id = Math.random().toString(36).slice(2, 6).toUpperCase();
  await chrome.storage.local.set({ [DEVICE_NAME_KEY]: `${label} 電腦 ${id}` });
}

async function makeReport(kind, days, template, test = false) {
  const usageByDay = await loadUsage(days);
  const { email } = await baseVars();
  return buildReport({ kind, days, usageByDay, email, device: await getDeviceName(), test, template });
}

async function sendReport(notify, report) {
  return sendRequest(notify, report.markdown, { ...(await baseVars()), ...report.vars });
}

let reporting = Promise.resolve();
/** 檢查每日 / 每週報告是否到期；電腦在排定時間沒開機時，下次開機補寄最近一份 */
function checkReports() {
  reporting = reporting.then(doCheckReports, doCheckReports);
  return reporting;
}

async function doCheckReports() {
  const { config } = await loadState();
  const r = config.report;
  if (!r.enabled) return;
  const now = new Date();
  const st = (await chrome.storage.local.get(REPORT_STATE_KEY))[REPORT_STATE_KEY] || {};
  const jobs = [
    { kind: 'daily', on: r.daily, due: latestDue(now, r.dailyTime) },
    { kind: 'weekly', on: r.weekly, due: latestDue(now, r.weeklyTime, r.weekday) },
  ];
  let changed = false;
  for (const job of jobs) {
    const dueKey = dateKey(job.due);
    if (!st[job.kind] || !job.on) {
      // 剛啟用（或這種報告沒勾選）：從現在起算，之後勾選時不會補寄已經過去的報告
      if (st[job.kind] !== dueKey) {
        st[job.kind] = dueKey;
        changed = true;
      }
      continue;
    }
    if (st[job.kind] >= dueKey) continue;
    if (st.retryAfter && now.getTime() < st.retryAfter) continue;
    if (!isNotifyConfigured(r.notify)) continue;
    const report = await makeReport(job.kind, reportDays(job.kind, job.due), r.template);
    let ok = true;
    if (report.totalMs > 0) {
      // 這台電腦在這段期間沒有上網時不寄送，避免多台電腦時收到一堆空報告
      const res = await sendReport(r.notify, report);
      ok = res.ok;
      if (!ok) console.warn(`[${APP_NAME}] 摘要報告寄送失敗`, job.kind, res);
    }
    if (ok) {
      st[job.kind] = dueKey;
      delete st.retryAfter;
    } else {
      st.retryAfter = now.getTime() + REPORT_RETRY_MS;
    }
    changed = true;
  }

  // 每天清一次過期的統計
  const today = dateKey(now);
  if (st.prunedOn !== today) {
    const cutoff = dateKey(addDays(now, -USAGE_KEEP_DAYS));
    const all = await chrome.storage.local.get(null);
    const old = Object.keys(all).filter((k) => k.startsWith(USAGE_PREFIX) && k.slice(USAGE_PREFIX.length) < cutoff);
    if (old.length) await chrome.storage.local.remove(old);
    st.prunedOn = today;
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [REPORT_STATE_KEY]: st });
}

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
    const kind = msg.kind === 'visit' ? 'visit' : 'blocked';
    sendNotify(msg.notify, kind, { url: 'https://example.com/test-page', title: '測試網頁（這是測試通知）' }).then(
      sendResponse
    );
    return true;
  }
  if (msg?.type === 'testReport' && fromExtensionPage(sender, 'pages/options.html')) {
    // 用設定頁上（尚未儲存）的範本，產生最近一期的測試報告。
    // 這台電腦在那段期間沒有紀錄、或家長選擇預覽範例資料時，改用範例資料。
    (async () => {
      const kind = msg.kind === 'weekly' ? 'weekly' : 'daily';
      const due = Number.isFinite(msg.due) ? new Date(msg.due) : new Date();
      const days = reportDays(kind, due);
      let report = msg.sample ? null : await makeReport(kind, days, msg.template, true);
      if (!report?.totalMs) {
        report = buildReport({
          kind,
          days,
          usageByDay: sampleUsage(days),
          email: (await baseVars()).email,
          device: (await getDeviceName()) + '（範例資料）',
          test: true,
          template: msg.template,
        });
      }
      return sendReport(msg.notify, report);
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
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
