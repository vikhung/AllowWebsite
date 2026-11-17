import {
  loadState,
  saveConfig,
  saveWhitelist,
  addDomains,
  normalizeDomain,
  setPassword,
  verifyPassword,
  isProtectionActive,
  isPaused,
  buildNotifyRequest,
  fitsSyncItem,
  NOTIFY_PAYLOAD_MAX,
  BLOCKING_KEY,
  MONITOR_KEY,
} from '../lib/store.js';

const $ = (id) => document.getElementById(id);
let unlocked = false;

function msg(el, text, ok = false) {
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'err');
}

async function applyNow() {
  try {
    await chrome.runtime.sendMessage({ type: 'apply' });
  } catch {
    /* background 會透過 storage.onChanged 自行套用 */
  }
}

// ---------------------------------------------------------------------
// API 通知表單（兩個管理功能各一份，以 id 前綴區分：b = 封鎖通知、v = 瀏覽通知）
// ---------------------------------------------------------------------

const SAMPLE_VARS = {
  url: 'https://example.com/',
  host: 'example.com',
  title: '範例',
  email: 'kid@example.com',
  time: '',
  localTime: '',
  timestamp: 0,
};

function createApiForm(prefix) {
  const ids = ['Method', 'Url', 'Payload'].map((s) => prefix + s);
  const form = {
    dirty: false, // 使用者正在編輯時，不要被同步 / 定時重繪覆蓋
    fill(notify) {
      if (form.dirty) return;
      $(prefix + 'Method').value = notify.method || 'POST';
      $(prefix + 'Url').value = notify.url || '';
      $(prefix + 'Payload').value = notify.payload || '';
    },
    /** 讀取並驗證；有錯時回傳 { error } */
    read() {
      const api = {
        method: $(prefix + 'Method').value,
        url: $(prefix + 'Url').value.trim(),
        payload: $(prefix + 'Payload').value,
      };
      if (api.payload.length > NOTIFY_PAYLOAD_MAX) {
        return { error: `Payload 太長（上限 ${NOTIFY_PAYLOAD_MAX} 字元）。` };
      }
      if (api.url && !buildNotifyRequest(api, SAMPLE_VARS)) {
        return { error: 'URL 格式不正確，需以 http:// 或 https:// 開頭。' };
      }
      return { api };
    },
  };
  ids.forEach((id) => $(id).addEventListener('input', () => (form.dirty = true)));

  $(prefix + 'Test').addEventListener('click', async () => {
    const m = $(prefix + 'Msg');
    const r0 = form.read();
    if (r0.error) return msg(m, r0.error);
    if (!r0.api.url) return msg(m, '請先填寫 URL。');
    $(prefix + 'Test').disabled = true;
    msg(m, '傳送中…', true);
    try {
      const r = await chrome.runtime.sendMessage({ type: 'testNotify', notify: r0.api });
      if (r?.ok) msg(m, `測試成功（HTTP ${r.status}）。記得按「儲存通知設定」。`, true);
      else msg(m, `測試失敗：${r?.status ? 'HTTP ' + r.status : r?.error || '未知錯誤'}`);
    } catch (e) {
      msg(m, '測試失敗：' + e.message);
    } finally {
      $(prefix + 'Test').disabled = false;
    }
  });
  return form;
}

const blockedForm = createApiForm('b');
const visitForm = createApiForm('v');
let bNotifyDirty = false;
$('bNotifyEnabled').addEventListener('input', () => (bNotifyDirty = true));

// ---------------------------------------------------------------------
// 畫面
// ---------------------------------------------------------------------

async function render() {
  const { config, whitelist } = await loadState();
  const hasPw = !!config.passwordHash;
  $('setup').classList.toggle('hidden', hasPw);
  $('login').classList.toggle('hidden', !hasPw || unlocked);
  $('main').classList.toggle('hidden', !hasPw || !unlocked);
  if (!hasPw || !unlocked) return;

  const { blocking, monitor } = config;

  // ---- 管理功能 1：白名單管理 ----
  $('blockingEnabled').checked = blocking.enabled;
  $('blockingCard').classList.toggle('is-off', !blocking.enabled);
  const active = isProtectionActive(config);
  const paused = isPaused(config);
  $('statusDot').className = 'dot' + (active ? '' : paused ? ' warn' : ' off');
  $('statusText').textContent = active
    ? '封鎖中：孩子只能開啟白名單網站'
    : paused
      ? `暫停中，將於 ${new Date(blocking.pauseUntil).toLocaleTimeString()} 自動恢復`
      : '未啟用：孩子可以開啟任何網站';
  $('pauseRow').classList.toggle('hidden', !blocking.enabled);
  $('resumeBtn').classList.toggle('hidden', !paused);

  const ul = $('wlList');
  ul.replaceChildren();
  if (!whitelist.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '目前沒有任何允許的網站。啟用白名單管理後，孩子將無法開啟任何網頁。';
    ul.append(li);
  }
  for (const d of whitelist) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = d;
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = '移除';
    btn.addEventListener('click', async () => {
      const cur = (await loadState()).whitelist;
      await saveWhitelist(cur.filter((x) => x !== d));
      await applyNow();
    });
    li.append(span, btn);
    ul.append(li);
  }
  if (!bNotifyDirty) $('bNotifyEnabled').checked = blocking.notify.enabled;
  blockedForm.fill(blocking.notify);

  // ---- 管理功能 2：網站瀏覽通知 ----
  $('monitorEnabled').checked = monitor.enabled;
  $('monitorCard').classList.toggle('is-off', !monitor.enabled);
  visitForm.fill(monitor.notify);

  $('syncInfo').textContent = config.updatedAt
    ? `設定最後更新：${new Date(config.updatedAt).toLocaleString()}（可能來自其他電腦）`
    : '';
}

// ---------------------------------------------------------------------
// 首次設定 / 登入
// ---------------------------------------------------------------------

$('setupBtn').addEventListener('click', async () => {
  const a = $('newPw1').value;
  const b = $('newPw2').value;
  if (a.length < 6) return msg($('setupMsg'), '密碼至少需要 6 個字元。');
  if (a !== b) return msg($('setupMsg'), '兩次輸入的密碼不一致。');
  // 再確認一次雲端是否已有密碼（避免覆蓋其他電腦的設定）
  const { config } = await loadState();
  if (config.passwordHash) {
    msg($('setupMsg'), '已從其他電腦同步到家長密碼，請改用該密碼登入。');
    return render();
  }
  await setPassword(a);
  unlocked = true;
  await applyNow();
  render();
});

async function doLogin() {
  if (await verifyPassword($('loginPw').value)) {
    unlocked = true;
    $('loginPw').value = '';
    $('loginMsg').textContent = '';
    render();
  } else {
    msg($('loginMsg'), '密碼錯誤。');
  }
}
$('loginBtn').addEventListener('click', doLogin);
$('loginPw').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());

// ---------------------------------------------------------------------
// 管理功能 1：白名單管理
// ---------------------------------------------------------------------

$('blockingEnabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const { whitelist } = await loadState();
  await saveConfig((c) => {
    c.blocking.enabled = on;
    c.blocking.pauseUntil = 0;
  });
  await applyNow();
  if (on && !whitelist.length) {
    msg($('blockingMsg'), '已啟用，但白名單是空的：孩子目前無法開啟任何網站，請在下方加入允許的網站。');
  } else {
    msg($('blockingMsg'), on ? '白名單管理已啟用。' : '白名單管理已停用。', true);
  }
});

document.querySelectorAll('[data-pause]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const min = Number(btn.dataset.pause);
    await saveConfig((c) => {
      c.blocking.pauseUntil = Date.now() + min * 60000;
    });
    await applyNow();
  })
);
$('resumeBtn').addEventListener('click', async () => {
  await saveConfig((c) => {
    c.blocking.pauseUntil = 0;
  });
  await applyNow();
});

$('addBtn').addEventListener('click', async () => {
  const lines = $('addInput').value.split(/[\s,;]+/).filter(Boolean);
  const good = [];
  const bad = [];
  for (const l of lines) (normalizeDomain(l) ? good : bad).push(l);
  if (!good.length && !bad.length) return;
  if (good.length) {
    await addDomains(good);
    await applyNow();
  }
  $('addInput').value = bad.join('\n');
  if (bad.length) msg($('addMsg'), `已加入 ${good.length} 個；以下格式無法辨識：${bad.join('、')}`);
  else msg($('addMsg'), `已加入 ${good.length} 個網站。`, true);
});

$('exportBtn').addEventListener('click', async () => {
  const { whitelist } = await loadState();
  const blob = new Blob([whitelist.join('\n') + '\n'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'whitelist.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('bSave').addEventListener('click', async () => {
  const r = blockedForm.read();
  if (r.error) return msg($('bMsg'), r.error);
  const enabled = $('bNotifyEnabled').checked;
  if (enabled && !r.api.url) return msg($('bMsg'), '要啟用封鎖通知，請先填寫 URL。');
  const { config } = await loadState();
  const blocking = { ...config.blocking, notify: { ...r.api, enabled } };
  if (!fitsSyncItem(BLOCKING_KEY, blocking)) return msg($('bMsg'), 'Payload 太長，超過 Chrome 同步的容量上限，請縮短。');
  await saveConfig((c) => {
    c.blocking.notify = { ...r.api, enabled };
  });
  blockedForm.dirty = false;
  bNotifyDirty = false;
  msg($('bMsg'), enabled ? '已儲存，封鎖通知已啟用。' : '已儲存（封鎖通知未啟用）。', true);
});

// ---------------------------------------------------------------------
// 管理功能 2：網站瀏覽通知
// ---------------------------------------------------------------------

$('monitorEnabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const { config } = await loadState();
  if (on && !config.monitor.notify.url) {
    e.target.checked = false;
    return msg($('monitorMsg'), '請先在下方填寫 API 並按「儲存通知設定」，再啟用網站瀏覽通知。');
  }
  await saveConfig((c) => {
    c.monitor.enabled = on;
  });
  await applyNow(); // 更新工具列提示文字
  msg($('monitorMsg'), on ? '網站瀏覽通知已啟用。' : '網站瀏覽通知已停用。', true);
});

$('vSave').addEventListener('click', async () => {
  const r = visitForm.read();
  if (r.error) return msg($('vMsg'), r.error);
  const { config } = await loadState();
  if (config.monitor.enabled && !r.api.url) {
    return msg($('vMsg'), '網站瀏覽通知啟用中，URL 不能是空的；若要停止通知請關閉上方開關。');
  }
  if (!fitsSyncItem(MONITOR_KEY, { ...config.monitor, notify: r.api })) {
    return msg($('vMsg'), 'Payload 太長，超過 Chrome 同步的容量上限，請縮短。');
  }
  await saveConfig((c) => {
    c.monitor.notify = r.api;
  });
  visitForm.dirty = false;
  msg($('vMsg'), '已儲存。' + (config.monitor.enabled ? '' : '記得打開上方開關以啟用網站瀏覽通知。'), true);
});

// ---------------------------------------------------------------------
// 變更密碼
// ---------------------------------------------------------------------

$('chgBtn').addEventListener('click', async () => {
  const a = $('chgPw1').value;
  const b = $('chgPw2').value;
  if (a.length < 6) return msg($('chgMsg'), '密碼至少需要 6 個字元。');
  if (a !== b) return msg($('chgMsg'), '兩次輸入的密碼不一致。');
  await setPassword(a);
  $('chgPw1').value = $('chgPw2').value = '';
  msg($('chgMsg'), '密碼已更新，並會同步到其他電腦。', true);
});

// 其他電腦同步過來的變更，即時反映在畫面上
chrome.storage.onChanged.addListener((_c, area) => area === 'sync' && render());
setInterval(render, 30000); // 更新暫停倒數
render();
