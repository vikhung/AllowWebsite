// 共用的設定存取模組。
// 所有家長設定都存放在 chrome.storage.sync：只要孩子的 Chrome 帳號開啟同步，
// 在 A 電腦做的設定會自動同步到 B 電腦。

// 永遠允許的網域（讓孩子能登入 Chrome 帳號以啟用同步）。
export const SYSTEM_ALLOW = ['accounts.google.com'];

const CONFIG_KEY = 'config'; // 家長密碼等共用設定
export const BLOCKING_KEY = 'blocking'; // 管理功能 1：白名單管理
export const MONITOR_KEY = 'monitor'; // 管理功能 2：網站瀏覽通知
const SYNC_ITEM_LIMIT = 8000; // chrome.storage.sync 單一 key 上限 8192 bytes，保留一點餘裕
const WL_COUNT_KEY = 'wlCount';
const WL_CHUNK_PREFIX = 'wl_';
// chrome.storage.sync 每個 key 上限 8KB，白名單分段存放以免超過。
const CHUNK_BYTES = 6000;

export const NOTIFY_METHODS = ['GET', 'POST', 'PUT', 'PATCH'];
export const NOTIFY_PAYLOAD_MAX = 2000;

// 兩種通知的預設 Payload（各自獨立設定）
export const DEFAULT_BLOCKED_PAYLOAD =
  '{\n  "text": "{{email}} 嘗試開啟未允許的網站：{{host}}",\n  "email": "{{email}}",\n  "url": "{{url}}",\n  "time": "{{time}}"\n}';
export const DEFAULT_VISIT_PAYLOAD =
  '{\n  "text": "{{email}} 正在瀏覽：{{title}}（{{host}}）",\n  "email": "{{email}}",\n  "title": "{{title}}",\n  "url": "{{url}}",\n  "time": "{{time}}"\n}';

/**
 * 設定結構：
 *  blocking — 管理功能 1：白名單管理（封鎖、白名單、封鎖通知）
 *  monitor  — 管理功能 2：網站瀏覽通知
 */
const DEFAULT_CONFIG = {
  passwordHash: null,
  salt: null,
  updatedAt: 0,
  blocking: {
    enabled: false, // 預設關閉，家長在設定頁手動啟用
    pauseUntil: 0,
    notify: { enabled: false, method: 'POST', url: '', payload: DEFAULT_BLOCKED_PAYLOAD },
  },
  monitor: {
    enabled: false,
    notify: { method: 'POST', url: '', payload: DEFAULT_VISIT_PAYLOAD },
  },
};

/** 將儲存的設定與預設值合併；並把 1.3 以前的舊格式轉成新格式 */
export function normalizeConfig(saved = {}) {
  const d = DEFAULT_CONFIG;
  let blocking = saved.blocking;
  let monitor = saved.monitor;
  if (!blocking && 'enabled' in saved) {
    // 舊格式：{ enabled, pauseUntil, notify: { enabled, onVisit, method, url, payload } }
    const n = saved.notify || {};
    const api = { method: n.method, url: n.url };
    // 舊版的 Payload 原本就是封鎖通知用的，保留給封鎖通知；瀏覽通知使用新的預設範本
    blocking = {
      enabled: saved.enabled,
      pauseUntil: saved.pauseUntil,
      notify: { ...api, payload: n.payload || undefined, enabled: n.enabled },
    };
    monitor = { enabled: !!n.onVisit, notify: { ...api } };
  }
  const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));
  return {
    passwordHash: saved.passwordHash ?? null,
    salt: saved.salt ?? null,
    updatedAt: saved.updatedAt ?? 0,
    blocking: {
      ...d.blocking,
      ...clean(blocking),
      notify: { ...d.blocking.notify, ...clean(blocking?.notify) },
    },
    monitor: {
      ...d.monitor,
      ...clean(monitor),
      notify: { ...d.monitor.notify, ...clean(monitor?.notify) },
    },
  };
}

/**
 * 依通知設定與變數組出要送出的請求。
 * 變數由呼叫端提供，例如 {{url}} {{host}} {{title}} {{email}} {{time}} {{localTime}} {{timestamp}}
 * URL 中的變數會做 encodeURIComponent；Payload 中的變數會做 JSON 字串跳脫。
 * 回傳 { url, init } 給 fetch 使用；設定無效時回傳 null。
 */
export function buildNotifyRequest(notify, vars) {
  if (!notify?.url) return null;
  const method = NOTIFY_METHODS.includes(notify.method) ? notify.method : 'POST';
  const fill = (tpl, esc) =>
    String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(vars, k) ? esc(String(vars[k])) : m
    );
  let url;
  try {
    url = new URL(fill(notify.url, encodeURIComponent));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const init = { method, headers: {} };
  if (method !== 'GET' && notify.payload) {
    const body = fill(notify.payload, (v) => JSON.stringify(v).slice(1, -1));
    let isJson = true;
    try {
      JSON.parse(body);
    } catch {
      isJson = false;
    }
    init.headers['Content-Type'] = isJson ? 'application/json' : 'text/plain;charset=UTF-8';
    init.body = body;
  }
  return { url: url.href, init };
}

/** 讀取完整狀態：{ config, whitelist } */
export async function loadState() {
  const head = await chrome.storage.sync.get([CONFIG_KEY, BLOCKING_KEY, MONITOR_KEY, WL_COUNT_KEY]);
  const config = normalizeConfig({
    ...(head[CONFIG_KEY] || {}),
    blocking: head[BLOCKING_KEY],
    monitor: head[MONITOR_KEY],
  });
  const count = head[WL_COUNT_KEY] || 0;
  let whitelist = [];
  if (count > 0) {
    const keys = Array.from({ length: count }, (_, i) => WL_CHUNK_PREFIX + i);
    const chunks = await chrome.storage.sync.get(keys);
    for (const k of keys) whitelist = whitelist.concat(chunks[k] || []);
  }
  return { config, whitelist };
}

/**
 * 修改設定：patch 可以是物件（淺層合併）或函式 (config) => void（直接修改）。
 * 例：saveConfig((c) => { c.blocking.enabled = true; })
 */
export async function saveConfig(patch) {
  const { config } = await loadState();
  let next = structuredClone(config);
  if (typeof patch === 'function') patch(next);
  else next = { ...next, ...patch };
  next.updatedAt = Date.now();
  // 兩個管理功能分開存放，避免單一 key 超過 chrome.storage.sync 的 8KB 上限
  await chrome.storage.sync.set({
    [CONFIG_KEY]: { passwordHash: next.passwordHash, salt: next.salt, updatedAt: next.updatedAt },
    [BLOCKING_KEY]: next.blocking,
    [MONITOR_KEY]: next.monitor,
  });
  return next;
}

/** 檢查某個管理功能區塊存進 sync 後是否會超過單一 key 上限 */
export function fitsSyncItem(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length <= SYNC_ITEM_LIMIT;
}

export async function saveWhitelist(list) {
  const clean = [...new Set(list.map(normalizeDomain).filter(Boolean))].sort();
  const chunks = [];
  let cur = [];
  let size = 2;
  for (const d of clean) {
    const add = d.length + 3;
    if (size + add > CHUNK_BYTES && cur.length) {
      chunks.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(d);
    size += add;
  }
  if (cur.length) chunks.push(cur);

  const prevCount = (await chrome.storage.sync.get(WL_COUNT_KEY))[WL_COUNT_KEY] || 0;
  const data = { [WL_COUNT_KEY]: chunks.length };
  chunks.forEach((c, i) => (data[WL_CHUNK_PREFIX + i] = c));
  await chrome.storage.sync.set(data);
  // 移除多餘的舊分段
  const stale = [];
  for (let i = chunks.length; i < prevCount; i++) stale.push(WL_CHUNK_PREFIX + i);
  if (stale.length) await chrome.storage.sync.remove(stale);
  await saveConfig({}); // 更新 updatedAt
  return clean;
}

export async function addDomains(domains) {
  const { whitelist } = await loadState();
  return saveWhitelist(whitelist.concat(domains));
}

/**
 * 將使用者輸入（網址或網域）轉成標準網域。無效時回傳 null。
 * 例："https://www.YouTube.com/watch?v=1" -> "youtube.com"
 */
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.split(/[/?#]/)[0];
  s = s.replace(/^.*@/, '').replace(/:\d+$/, '');
  s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!s) return null;
  try {
    s = new URL('http://' + s).hostname; // 中文網域轉 punycode
  } catch {
    return null;
  }
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  if (!s.includes('.') && s !== 'localhost') return null;
  if (s.startsWith('.') || s.includes('..')) return null;
  return s;
}

/** 判斷某個主機名稱是否在白名單（含子網域） */
export function isHostAllowed(hostname, whitelist) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return [...SYSTEM_ALLOW, ...whitelist].some((d) => h === d || h.endsWith('.' + d));
}

/** 白名單封鎖是否正在生效（已啟用且未暫停） */
export function isProtectionActive(config, now = Date.now()) {
  const b = config.blocking;
  return !!b.enabled && !(b.pauseUntil > now);
}

export function isPaused(config, now = Date.now()) {
  const b = config.blocking;
  return !!b.enabled && b.pauseUntil > now;
}

// ---------- 密碼（PBKDF2-SHA256） ----------

function toB64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function fromB64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(password, saltBytes) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: 150000 },
    key,
    256
  );
  return toB64(bits);
}

export async function setPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordHash = await derive(password, salt);
  return saveConfig({ passwordHash, salt: toB64(salt) });
}

export async function verifyPassword(password) {
  const { config } = await loadState();
  if (!config.passwordHash || !config.salt) return false;
  const h = await derive(password, fromB64(config.salt));
  return h === config.passwordHash;
}
