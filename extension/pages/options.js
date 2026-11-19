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
  fitsSyncItem,
  NOTIFY_PAYLOAD_MAX,
  BLOCKING_KEY,
  MONITOR_KEY,
  REPORT_KEY,
  USAGE_PREFIX,
  DEVICE_NAME_KEY,
  loadUsage,
  getDeviceName,
} from '../lib/store.js';
import {
  parseTime,
  dateKey,
  mergeUsage,
  formatDuration,
  reportDays,
  latestDue,
  buildReport,
  renderMarkdown,
  sampleUsage,
  normalizeTemplate,
  DEFAULT_TEMPLATE,
  TEXT_MAX,
  RANK_LIMIT_MAX,
} from '../lib/report.js';
import {
  TOOLS,
  TOOL_ORDER,
  FIELD_LABELS,
  FIELD_PLACEHOLDERS,
  buildMessage,
  formatFor,
  validateNotify,
  isNotifyConfigured,
  messageSize,
} from '../lib/tools.js';
import { TOOL_HELP } from './tool-help.js';

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
// 通知表單（三個管理功能各一份，以 id 前綴區分：b = 封鎖通知、v = 瀏覽通知、r = 摘要報告）
// 選擇通知工具後只需要填網址或權杖；訊息格式依工具自動調整（定型化）。
// ---------------------------------------------------------------------

const SAMPLE_VARS = {
  url: 'https://www.example.com/games/play',
  host: 'www.example.com',
  title: '範例網頁標題',
  email: 'kid@gmail.com',
  time: new Date().toISOString(),
  localTime: new Date().toLocaleString('zh-TW', { hour12: false }),
  timestamp: Date.now(),
};

const VARS_HELP = {
  blocked:
    '<code>{{message}}</code> 定型化訊息（Markdown）、<code>{{messageText}}</code> 純文字訊息、<code>{{email}}</code> 孩子登入 Chrome 的帳號、' +
    '<code>{{url}}</code> 被擋的網址、<code>{{host}}</code> 網域、<code>{{time}}</code> ISO 時間、<code>{{localTime}}</code> 本地時間、<code>{{timestamp}}</code> 毫秒時間戳。',
  visit:
    '<code>{{message}}</code> 定型化訊息（Markdown）、<code>{{messageText}}</code> 純文字訊息、<code>{{email}}</code> 孩子登入 Chrome 的帳號、' +
    '<code>{{title}}</code> 網頁標題、<code>{{url}}</code> 網址、<code>{{host}}</code> 網域、<code>{{time}}</code>、<code>{{localTime}}</code>、<code>{{timestamp}}</code>。',
  report:
    '<code>{{report}}</code> Markdown 格式的完整報告、<code>{{reportText}}</code> 純文字報告、<code>{{period}}</code> 每日 / 每週、' +
    '<code>{{range}}</code> 統計日期、<code>{{totalTime}}</code> 總上網時間、<code>{{siteCount}}</code> 網站數、<code>{{device}}</code> 電腦名稱、' +
    '<code>{{email}}</code>、<code>{{time}}</code>、<code>{{localTime}}</code>、<code>{{timestamp}}</code>。',
};

/** 依工具顯示訊息預覽：LINE 為純文字，其他工具顯示粗體、清單等格式 */
function renderToolPreview(el, tool, md) {
  if (TOOLS[tool].format === 'plain') {
    el.className = 'preview-body plain';
    el.textContent = formatFor(tool, md);
  } else {
    el.className = 'preview-body';
    el.innerHTML = renderMarkdown(md); // renderMarkdown 會先跳脫 HTML
  }
}

/**
 * kind：'blocked' | 'visit' | 'report'
 * opts.extra：傳送測試時額外帶給 background 的資料
 * opts.onChange：工具或欄位變更時呼叫（摘要報告用來更新預覽）
 */
function createApiForm(prefix, kind, opts = {}) {
  const P = (id) => $(prefix + id);
  const box = P('Form');
  const isReport = kind === 'report';
  box.innerHTML = `
    <label for="${prefix}Tool"${isReport ? ' class="sr-only"' : ''}>通知工具</label>
    <div class="row">
      <select id="${prefix}Tool" class="inline">${TOOL_ORDER.map(
        (t) => `<option value="${t}">${TOOLS[t].icon} ${TOOLS[t].label}</option>`
      ).join('')}</select>
      <a href="#" id="${prefix}Help" class="help-link">如何申請？</a>
    </div>
    <div id="${prefix}UrlRow"><label for="${prefix}Url" id="${prefix}UrlLabel"></label>
      <input id="${prefix}Url" type="text" spellcheck="false" autocomplete="off"></div>
    <div id="${prefix}TokenRow"><label for="${prefix}Token" id="${prefix}TokenLabel"></label>
      <input id="${prefix}Token" type="text" spellcheck="false" autocomplete="off"></div>
    <div id="${prefix}ChatRow"><label for="${prefix}ChatId" id="${prefix}ChatLabel"></label>
      <input id="${prefix}ChatId" type="text" spellcheck="false" autocomplete="off"></div>
    <div id="${prefix}CustomRows">
      <label for="${prefix}Method">Method</label>
      <select id="${prefix}Method" class="inline"><option>POST</option><option>GET</option><option>PUT</option><option>PATCH</option></select>
      <label for="${prefix}Payload">Payload</label>
      <textarea id="${prefix}Payload" class="code" spellcheck="false"></textarea>
      <p class="muted">可用變數：${VARS_HELP[kind]}</p>
    </div>
    ${
      isReport
        ? ''
        : `<label>訊息預覽（格式依通知工具自動調整）</label>
           <div class="mini-preview"><div id="${prefix}Preview" class="preview-body"></div></div>`
    }
    <div class="row mt">
      <button id="${prefix}Save" class="primary">${isReport ? '儲存報告設定' : '儲存通知設定'}</button>
      <button id="${prefix}Test">${isReport ? '傳送測試報告' : '傳送測試通知'}</button>
    </div>
    <div id="${prefix}Msg" class="msg"></div>`;

  const form = {
    dirty: false, // 使用者正在編輯時，不要被同步 / 定時重繪覆蓋
    get tool() {
      return P('Tool').value;
    },
    /** 依選擇的工具切換欄位 */
    layout() {
      const tool = form.tool;
      const fields = TOOLS[tool].fields;
      const lab = FIELD_LABELS[tool];
      const ph = FIELD_PLACEHOLDERS[tool];
      P('UrlRow').classList.toggle('hidden', !fields.includes('url'));
      P('TokenRow').classList.toggle('hidden', !fields.includes('token'));
      P('ChatRow').classList.toggle('hidden', !fields.includes('chatId'));
      P('CustomRows').classList.toggle('hidden', tool !== 'custom');
      P('UrlLabel').textContent = lab.url || '';
      P('TokenLabel').textContent = lab.token || '';
      P('ChatLabel').textContent = lab.chatId || '';
      P('Url').placeholder = ph.url || '';
      P('Token').placeholder = ph.token || '';
      P('ChatId').placeholder = ph.chatId || '';
      P('Help').textContent = `如何申請 ${TOOLS[tool].label}？`;
      form.preview();
    },
    preview() {
      if (!isReport) renderToolPreview(P('Preview'), form.tool, buildMessage(kind, SAMPLE_VARS));
      opts.onChange?.();
    },
    fill(notify) {
      if (form.dirty) return;
      P('Tool').value = TOOLS[notify.tool] ? notify.tool : 'custom';
      P('Url').value = notify.url || '';
      P('Token').value = notify.token || '';
      P('ChatId').value = notify.chatId || '';
      P('Method').value = notify.method || 'POST';
      P('Payload').value = notify.payload || '';
      form.layout();
    },
    /** 讀取並驗證；有錯時回傳 { error } */
    read() {
      const api = {
        tool: form.tool,
        url: P('Url').value.trim(),
        token: P('Token').value.trim(),
        chatId: P('ChatId').value.trim(),
        method: P('Method').value,
        payload: P('Payload').value,
      };
      if (api.payload.length > NOTIFY_PAYLOAD_MAX) {
        return { error: `Payload 太長（上限 ${NOTIFY_PAYLOAD_MAX} 字元）。` };
      }
      const err = validateNotify(api);
      return err ? { error: err } : { api };
    },
  };

  ['Tool', 'Url', 'Token', 'ChatId', 'Method', 'Payload'].forEach((id) =>
    P(id).addEventListener('input', () => {
      form.dirty = true;
      if (id === 'Tool') form.layout();
    })
  );
  P('Help').addEventListener('click', (e) => {
    e.preventDefault();
    openHelp(form.tool);
  });
  P('Test').addEventListener('click', async () => {
    const m = P('Msg');
    const r0 = form.read();
    if (r0.error) return msg(m, r0.error);
    if (!isNotifyConfigured(r0.api)) return msg(m, '請先填寫通知工具的必要欄位。');
    P('Test').disabled = true;
    msg(m, '傳送中…', true);
    try {
      const type = isReport ? 'testReport' : 'testNotify';
      const r = await chrome.runtime.sendMessage({ type, kind, notify: r0.api, ...(opts.extra?.() || {}) });
      if (r?.ok) msg(m, `測試成功（HTTP ${r.status}）。記得按「${P('Save').textContent}」。`, true);
      else msg(m, `測試失敗：${r?.status ? 'HTTP ' + r.status : r?.error || '未知錯誤'}`);
    } catch (e) {
      msg(m, '測試失敗：' + e.message);
    } finally {
      P('Test').disabled = false;
    }
  });
  form.layout();
  return form;
}

// ---- 「如何申請？」視窗 ----

function openHelp(tool) {
  const tabs = $('helpTabs');
  tabs.replaceChildren(
    ...TOOL_ORDER.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${TOOLS[t].icon} ${TOOLS[t].label}`;
      b.className = t === tool ? 'on' : '';
      b.addEventListener('click', () => openHelp(t));
      return b;
    })
  );
  const h = TOOL_HELP[tool];
  $('helpTitle').textContent = `如何申請 ${TOOLS[tool].label}`;
  // 內容為 tool-help.js 中的固定文字（不含使用者輸入）
  $('helpBody').innerHTML = `
    <p>${h.intro}</p>
    <ol>${h.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
    ${h.links.length ? `<p class="help-links">${h.links.map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join('')}</p>` : ''}
    ${h.note ? `<p class="note">${h.note}</p>` : ''}`;
  if (!$('helpDialog').open) $('helpDialog').showModal();
}
$('helpClose').addEventListener('click', () => $('helpDialog').close());
$('helpDialog').addEventListener('click', (e) => {
  if (e.target === $('helpDialog')) $('helpDialog').close(); // 點視窗外側關閉
});

const blockedForm = createApiForm('b', 'blocked');
const visitForm = createApiForm('v', 'visit');
let composerRef = null; // 摘要報告組合器（宣告在後面）
// 測試報告使用畫面上（尚未儲存）的範本，以及預覽目前選的每日 / 每週與資料來源
const reportForm = createApiForm('r', 'report', {
  extra: () => ({
    template: composer.template,
    kind: composer.kind,
    sample: composer.data === 'sample',
    due: composer.due().getTime(),
  }),
  onChange: () => composerRef?.preview(),
});
// 摘要報告的「儲存 / 測試」按鈕放在報告內容組合器下方（儲存時會一併儲存寄送時間、通知工具與報告內容）
$('rActions').append($('rSave').parentElement, $('rMsg'));
let bNotifyDirty = false;
$('bNotifyEnabled').addEventListener('input', () => (bNotifyDirty = true));
let scheduleDirty = false; // 報告寄送時間正在編輯中
['rDaily', 'rDailyTime', 'rWeekly', 'rWeekday', 'rWeeklyTime'].forEach((id) => $(id).addEventListener('input', () => (scheduleDirty = true)));
let deviceDirty = false;
$('deviceName').addEventListener('input', () => (deviceDirty = true));

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

  // ---- 管理功能 3：上網摘要報告 ----
  const { report } = config;
  $('reportEnabled').checked = report.enabled;
  $('reportCard').classList.toggle('is-off', !report.enabled);
  if (!scheduleDirty) {
    $('rDaily').checked = report.daily;
    $('rDailyTime').value = report.dailyTime;
    $('rWeekly').checked = report.weekly;
    $('rWeekday').value = String(report.weekday);
    $('rWeeklyTime').value = report.weeklyTime;
  }
  reportForm.fill(report.notify);
  if (!composer.dirty) composer.load(report.template);
  if (!deviceDirty) $('deviceName').value = await getDeviceName();
  await renderToday();

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
  if (enabled && !isNotifyConfigured(r.api)) return msg($('bMsg'), '要啟用封鎖通知，請先填寫通知工具的必要欄位。');
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
  if (on && !isNotifyConfigured(config.monitor.notify)) {
    e.target.checked = false;
    return msg($('monitorMsg'), '請先在下方設定通知工具並按「儲存通知設定」，再啟用網站瀏覽通知。');
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
  if (config.monitor.enabled && !isNotifyConfigured(r.api)) {
    return msg($('vMsg'), '網站瀏覽通知啟用中，通知工具的必要欄位不能是空的；若要停止通知請關閉上方開關。');
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
// 管理功能 3：上網摘要報告
// ---------------------------------------------------------------------

async function renderToday() {
  const today = dateKey(new Date());
  const rows = mergeUsage([(await loadUsage([today]))[today]]);
  const ul = $('todayList');
  ul.replaceChildren();
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '今天還沒有紀錄（啟用後才會開始記錄）。';
    ul.append(li);
  }
  for (const r of rows.slice(0, 15)) {
    const li = document.createElement('li');
    const host = document.createElement('span');
    host.textContent = r.host;
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = formatDuration(r.ms);
    li.append(host, dur);
    ul.append(li);
  }
}

// ---- 報告組合器（{{report}} 的組成）與即時預覽 ----

const BLOCK_LABELS = { text: '文字', ranking: '停留時間排行', days: '每日上網時間（只出現在每週報告）' };

const composer = {
  template: structuredClone(DEFAULT_TEMPLATE),
  dirty: false, // 有尚未儲存的修改時，不要被同步 / 定時重繪覆蓋
  kind: 'daily',
  view: 'rendered',
  data: 'sample',
  load(tpl) {
    composer.template = normalizeTemplate(tpl);
    composer.renderBlocks();
  },
  changed() {
    composer.dirty = true;
    composer.preview();
  },
  renderBlocks() {
    const list = $('blockList');
    list.replaceChildren();
    const tpl = composer.template;
    tpl.forEach((b, i) => {
      const box = document.createElement('div');
      box.className = 'block' + (b.on ? '' : ' off');

      const head = document.createElement('div');
      head.className = 'block-head';
      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = b.on;
      on.title = '顯示 / 隱藏這個區塊';
      on.addEventListener('change', () => {
        b.on = on.checked;
        box.classList.toggle('off', !b.on);
        composer.changed();
      });
      const title = document.createElement('span');
      title.className = 'block-title';
      title.textContent = BLOCK_LABELS[b.type];
      const btn = (text, tip, fn, disabled = false) => {
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = text;
        x.title = tip;
        x.disabled = disabled;
        x.addEventListener('click', () => {
          fn();
          composer.renderBlocks();
          composer.changed();
        });
        return x;
      };
      const move = (d) => () => tpl.splice(i + d, 0, ...tpl.splice(i, 1));
      head.append(on, title, btn('↑', '上移', move(-1), i === 0), btn('↓', '下移', move(1), i === tpl.length - 1));
      if (b.type === 'text') head.append(btn('刪除', '刪除這個文字區塊', () => tpl.splice(i, 1)));
      box.append(head);

      const field = (label, key, placeholder = '', multiline = false) => {
        const id = `blk${i}_${key}`;
        const l = document.createElement('label');
        l.htmlFor = id;
        l.textContent = label;
        const input = document.createElement(multiline ? 'textarea' : 'input');
        if (multiline) {
          input.rows = Math.max(2, String(b[key]).split('\n').length);
          // 依內容自動調整高度
          const fit = () => {
            input.style.height = 'auto';
            input.style.height = input.scrollHeight + 2 + 'px';
          };
          input.addEventListener('input', fit);
          requestAnimationFrame(fit);
        } else {
          input.type = 'text';
        }
        input.id = id;
        input.maxLength = TEXT_MAX;
        input.spellcheck = false;
        input.placeholder = placeholder;
        input.value = b[key];
        input.addEventListener('input', () => {
          b[key] = input.value;
          composer.changed();
        });
        box.append(l, input);
      };
      if (b.type === 'text') {
        field('內容（按 Enter 或輸入 \\n 換行）', 'text', '例如：有問題請和爸爸媽媽討論 😊', true);
      } else if (b.type === 'ranking') {
        field('標題', 'heading');
        field('每個網站一列', 'item');
        const l = document.createElement('label');
        l.htmlFor = `blk${i}_limit`;
        l.textContent = `最多列出幾個網站（1–${RANK_LIMIT_MAX}）`;
        const n = document.createElement('input');
        n.type = 'number';
        n.id = `blk${i}_limit`;
        n.min = 1;
        n.max = RANK_LIMIT_MAX;
        n.value = b.limit;
        n.addEventListener('input', () => {
          const v = Math.round(Number(n.value));
          if (v >= 1 && v <= RANK_LIMIT_MAX) {
            b.limit = v;
            composer.changed();
          }
        });
        box.append(l, n);
        field('超過的網站合併成一列（留空則不顯示）', 'other');
      } else if (b.type === 'days') {
        field('標題', 'heading');
        field('每天一列', 'item');
      }
      list.append(box);
    });
    composer.preview();
  },
  /** 依畫面上的寄送時間，算出最近一份報告的寄送時間（預覽與測試報告的日期範圍與實際報告一致） */
  due() {
    const now = new Date();
    return composer.kind === 'daily'
      ? latestDue(now, $('rDailyTime').value || '08:00')
      : latestDue(now, $('rWeeklyTime').value || '09:00', Number($('rWeekday').value));
  },
  async preview() {
    const kind = composer.kind;
    const days = reportDays(kind, composer.due());
    let usageByDay = composer.data === 'real' ? await loadUsage(days) : sampleUsage(days);
    let note = '';
    if (composer.data === 'real' && !mergeUsage(days.map((k) => usageByDay[k])).length) {
      usageByDay = sampleUsage(days);
      note = '這台電腦在這段期間沒有紀錄，暫時以範例資料顯示。';
    }
    let email = '';
    try {
      email = (await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }))?.email || '';
    } catch {
      /* ignore */
    }
    const report = buildReport({
      kind,
      days,
      usageByDay,
      email: email || '（未登入 Chrome）',
      device: $('deviceName').value.trim() || (await getDeviceName()),
      template: composer.template,
    });
    const tool = reportForm.tool;
    const formatted = formatFor(tool, report.markdown);
    renderToolPreview($('pvBody'), tool, report.markdown);
    $('pvRawBody').textContent = formatted;
    $('pvName').textContent = `${TOOLS[tool].icon} ${TOOLS[tool].label}`;
    $('pvBody').classList.toggle('hidden', composer.view !== 'rendered');
    $('pvRawBody').classList.toggle('hidden', composer.view === 'rendered');
    const when =
      kind === 'daily'
        ? `每天 ${$('rDailyTime').value}`
        : `每週${$('rWeekday').selectedOptions[0].text} ${$('rWeeklyTime').value}`;
    $('pvWhen').textContent = `· ${when}`;
    const t = TOOLS[tool];
    const size = messageSize(tool, formatted);
    const unit = t.unit === 'bytes' ? 'bytes' : '字';
    const over = size > t.limit;
    $('pvInfo').className = 'muted mt' + (over ? ' err' : '');
    $('pvInfo').textContent =
      (note ? note + ' ' : '') +
      `報告大小 ${size.toLocaleString()} ${unit}` +
      (Number.isFinite(t.limit) ? `（${t.label} 單則上限 ${t.limit.toLocaleString()} ${unit}）` : '') +
      (over ? '，超過的部分送出時會被截斷，請減少列出的網站數或縮短文字。' : '。') +
      (TOOLS[tool].format === 'plain' ? ` ${t.label} 只支援純文字，粗體等格式會自動去除。` : '') +
      (composer.dirty ? ' 尚未儲存，記得按「儲存報告設定」。' : '');
  },
};

composerRef = composer;

const segment = (ids, key, values) =>
  ids.forEach((id, i) =>
    $(id).addEventListener('click', () => {
      composer[key] = values[i];
      ids.forEach((x) => $(x).classList.toggle('on', x === id));
      composer.preview();
    })
  );
segment(['pvDaily', 'pvWeekly'], 'kind', ['daily', 'weekly']);
segment(['pvRendered', 'pvRaw'], 'view', ['rendered', 'raw']);
$('pvData').addEventListener('change', () => {
  composer.data = $('pvData').value;
  composer.preview();
});
['rDailyTime', 'rWeekday', 'rWeeklyTime', 'deviceName'].forEach((id) =>
  $(id).addEventListener('input', () => composer.preview())
);
$('addTextBlock').addEventListener('click', () => {
  composer.template.push({ type: 'text', on: true, text: '' });
  composer.renderBlocks();
  composer.changed();
  $('blockList').lastElementChild.querySelector('input[type="text"]').focus();
});
$('resetTemplate').addEventListener('click', () => {
  composer.load(DEFAULT_TEMPLATE);
  composer.changed();
});

$('reportEnabled').addEventListener('change', async (e) => {
  const on = e.target.checked;
  const { config } = await loadState();
  if (on && !isNotifyConfigured(config.report.notify)) {
    e.target.checked = false;
    return msg($('reportMsg'), '請先在下方設定通知工具並按「儲存報告設定」，再啟用上網摘要報告。');
  }
  await saveConfig((c) => {
    c.report.enabled = on;
  });
  await applyNow();
  msg($('reportMsg'), on ? '上網摘要報告已啟用，開始記錄上網時間。' : '上網摘要報告已停用，不再記錄上網時間。', true);
});

$('rSave').addEventListener('click', async () => {
  const m = $('rMsg');
  const r = reportForm.read();
  if (r.error) return msg(m, r.error);
  const dailyTime = $('rDailyTime').value;
  const weeklyTime = $('rWeeklyTime').value;
  if (!parseTime(dailyTime) || !parseTime(weeklyTime)) return msg(m, '請輸入寄送時間。');
  const daily = $('rDaily').checked;
  const weekly = $('rWeekly').checked;
  const { config } = await loadState();
  if (config.report.enabled && !isNotifyConfigured(r.api)) {
    return msg(m, '上網摘要報告啟用中，通知工具的必要欄位不能是空的；若要停止請關閉上方開關。');
  }
  const next = {
    ...config.report,
    daily,
    weekly,
    dailyTime,
    weeklyTime,
    weekday: Number($('rWeekday').value),
    template: normalizeTemplate(composer.template),
    notify: r.api,
  };
  if (!fitsSyncItem(REPORT_KEY, next)) {
    return msg(m, '報告內容或 Payload 太長，超過 Chrome 同步的容量上限，請縮短文字或減少文字區塊。');
  }
  await saveConfig((c) => {
    c.report = next;
  });
  reportForm.dirty = false;
  scheduleDirty = false;
  composer.dirty = false;
  composer.preview();
  await applyNow();
  const parts = [
    daily && `每天 ${dailyTime}`,
    weekly && `每週${$('rWeekday').selectedOptions[0].text} ${weeklyTime}`,
  ].filter(Boolean);
  msg(
    m,
    '已儲存。' +
      (parts.length ? `寄送時間：${parts.join('、')}。` : '目前沒有勾選每日或每週報告。') +
      (config.report.enabled ? '' : '記得打開上方開關以啟用上網摘要報告。'),
    true
  );
});

$('deviceSave').addEventListener('click', async () => {
  const name = $('deviceName').value.trim();
  if (!name) return msg($('deviceMsg'), '請輸入電腦名稱。');
  await chrome.storage.local.set({ [DEVICE_NAME_KEY]: name });
  deviceDirty = false;
  msg($('deviceMsg'), '已儲存。', true);
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') render();
  else if (area === 'local' && unlocked && Object.keys(changes).some((k) => k.startsWith(USAGE_PREFIX))) renderToday();
});
setInterval(render, 30000); // 更新暫停倒數
render();
