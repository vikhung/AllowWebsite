// 管理功能 3：上網摘要報告 — 純函式（不使用 chrome.*，可在 Node 中測試）

export const DEFAULT_DAILY_TIME = '08:00';
export const DEFAULT_WEEKLY_TIME = '09:00';
export const DEFAULT_WEEKDAY = 6; // 週六
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];
export const TEXT_MAX = 300; // 範本每個欄位的長度上限
export const RANK_LIMIT_MAX = 50;

/**
 * {{report}} 的組成：由上到下依序排列的區塊，區塊之間空一行。
 *  text    — 一行文字（可用 {{period}} {{range}} {{email}} {{device}} {{totalTime}} {{siteCount}}）
 *  ranking — 停留時間排行：標題 + 每個網站一行（{{rank}} {{host}} {{time}} {{percent}}）+「其他」一行（{{count}} {{time}}）
 *  days    — 每日上網時間（只出現在每週報告）：標題 + 每天一行（{{date}} {{time}}）
 * 家長可在設定頁開關、排序、修改每個區塊，並新增 / 刪除文字區塊。
 */
export const DEFAULT_TEMPLATE = [
  { type: 'text', on: true, text: '**📊 {{period}}上網摘要｜{{range}}**' },
  { type: 'text', on: true, text: '👤 {{email}}\n💻 {{device}}' },
  { type: 'text', on: true, text: '⏱ 總上網時間：**{{totalTime}}**（{{siteCount}} 個網站）' },
  {
    type: 'ranking',
    on: true,
    heading: '**停留時間排行**',
    item: '{{rank}}. **{{host}}** — {{time}}（{{percent}}%）',
    limit: 20,
    other: '…其他 {{count}} 個網站，共 {{time}}',
  },
  { type: 'days', on: true, heading: '**每日上網時間**', item: '- {{date}}　{{time}}' },
];

/** "21:05" -> [21, 5]；格式錯誤時回傳 null */
export function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? [h, mi] : null;
}

/** 本地日期鍵，例如 "2026-11-19" */
export function dateKey(d) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** "2026-11-19" -> Date（本地時間 00:00） */
function fromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * 最近一次「已到期」的排程時間（<= now）。
 * weekday 為 null 時是每天的 time；否則是每週 weekday（0 = 週日）的 time。
 */
export function latestDue(now, time, weekday = null) {
  const [h, m] = parseTime(time) || [0, 0];
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (weekday === null || weekday === undefined) {
    if (d > now) d.setDate(d.getDate() - 1);
    return d;
  }
  d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
  if (d > now) d.setDate(d.getDate() - 7);
  return d;
}

/** 報告涵蓋的日期鍵（都是完整的日子）：每日 = 寄送日的前一天；每週 = 寄送日之前的 7 天 */
export function reportDays(kind, due) {
  const n = kind === 'daily' ? 1 : 7;
  return Array.from({ length: n }, (_, i) => dateKey(addDays(due, i - n)));
}

/** 統計用的網域鍵：小寫、去掉結尾的點與開頭的 www. */
export function hostKey(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** 合併多天的 { host: ms }，依停留時間由多到少排序 */
export function mergeUsage(maps) {
  const sum = {};
  for (const m of maps) {
    for (const [host, ms] of Object.entries(m || {})) sum[host] = (sum[host] || 0) + ms;
  }
  return Object.entries(sum)
    .map(([host, ms]) => ({ host, ms }))
    .filter((r) => r.ms > 0)
    .sort((a, b) => b.ms - a.ms || a.host.localeCompare(b.host));
}

export function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '不到 1 分鐘';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} 分鐘`;
  return m ? `${h} 小時 ${m} 分` : `${h} 小時`;
}

/** "2026-11-19" -> "2026/11/19（四）"；short 時為 "11/19（四）" */
export function formatDate(key, short = false) {
  const d = fromKey(key);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return `${short ? md : d.getFullYear() + '/' + md}（${WEEKDAY_NAMES[d.getDay()]}）`;
}

/** 設定頁預覽與測試報告用的範例資料 */
export function sampleUsage(days) {
  const M = 60000;
  const base = [
    ['youtube.com', 52],
    ['pbskids.org', 25],
    ['khanacademy.org', 18],
    ['wikipedia.org', 8],
    ['google.com', 6],
  ];
  return Object.fromEntries(
    days.map((k, i) => [
      k,
      Object.fromEntries(base.map(([h, min], j) => [h, Math.round(min * (1 + ((i * 3 + j) % 5) / 4)) * M])),
    ])
  );
}

/** 以 vars 取代 {{變數}}；未知的變數保留原樣 */
export function fillLine(tpl, vars) {
  return String(tpl ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  );
}

/**
 * 範本文字中的換行：可以直接按 Enter，也可以輸入 \n（反斜線 + n）。
 * 多餘的空白行會壓成一行空行（空一行 = 分段），避免訊息出現大片空白。
 */
export function nl(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

/** 修正存放的範本：格式錯誤時用預設值；排行與每日區塊各保留一個 */
export function normalizeTemplate(saved) {
  if (!Array.isArray(saved) || !saved.length) return structuredClone(DEFAULT_TEMPLATE);
  const str = (v, d) => (typeof v === 'string' ? v.slice(0, TEXT_MAX) : d);
  const def = (type) => DEFAULT_TEMPLATE.find((b) => b.type === type);
  const out = [];
  const seen = new Set();
  for (const b of saved) {
    if (!b || typeof b !== 'object') continue;
    const on = b.on !== false;
    if (b.type === 'text') {
      out.push({ type: 'text', on, text: str(b.text, '') });
    } else if ((b.type === 'ranking' || b.type === 'days') && !seen.has(b.type)) {
      seen.add(b.type);
      const d = def(b.type);
      const blk = { type: b.type, on, heading: str(b.heading, d.heading), item: str(b.item, d.item) };
      if (b.type === 'ranking') {
        const n = Math.round(Number(b.limit));
        blk.limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), RANK_LIMIT_MAX) : d.limit;
        blk.other = str(b.other, d.other);
      }
      out.push(blk);
    }
  }
  for (const type of ['ranking', 'days']) if (!seen.has(type)) out.push(structuredClone(def(type)));
  return out;
}

/**
 * 組出摘要報告。
 * usageByDay = { "2026-11-19": { "youtube.com": 毫秒, ... }, ... }
 * 回傳 { totalMs, markdown, text, vars }；vars 可直接合併進通知變數。
 */
export function buildReport({ kind, days, usageByDay, email = '', device = '', test = false, template }) {
  const blocks = normalizeTemplate(template);
  const rows = mergeUsage(days.map((k) => usageByDay[k]));
  const totalMs = rows.reduce((s, r) => s + r.ms, 0);
  const period = kind === 'weekly' ? '每週' : '每日';
  const range =
    days.length === 1 ? formatDate(days[0]) : `${formatDate(days[0])} ～ ${formatDate(days[days.length - 1])}`;
  const vars = { period, range, email, device, totalTime: formatDuration(totalMs), siteCount: rows.length };

  const parts = test ? ['🧪 這是測試報告'] : [];
  for (const b of blocks) {
    if (!b.on) continue;
    if (b.type === 'text') {
      const line = fillLine(nl(b.text), vars).trim();
      if (line) parts.push(line);
    } else if (b.type === 'ranking') {
      const L = [];
      if (b.heading.trim()) L.push(fillLine(nl(b.heading), vars), '');
      if (!rows.length) L.push('這段期間沒有上網紀錄。');
      const top = rows.slice(0, b.limit);
      top.forEach((r, i) =>
        L.push(
          fillLine(nl(b.item), {
            ...vars,
            rank: i + 1,
            host: r.host,
            time: formatDuration(r.ms),
            percent: Math.round((r.ms / totalMs) * 100),
          })
        )
      );
      const rest = rows.slice(top.length);
      if (rest.length && b.other.trim()) {
        const restMs = rest.reduce((s, r) => s + r.ms, 0);
        L.push('', fillLine(nl(b.other), { ...vars, count: rest.length, time: formatDuration(restMs) }));
      }
      parts.push(L.join('\n'));
    } else if (b.type === 'days' && kind === 'weekly') {
      const L = [];
      if (b.heading.trim()) L.push(fillLine(nl(b.heading), vars), '');
      for (const k of days) {
        const ms = mergeUsage([usageByDay[k]]).reduce((s, r) => s + r.ms, 0);
        L.push(fillLine(nl(b.item), { ...vars, date: formatDate(k, true), time: ms ? formatDuration(ms) : '沒有紀錄' }));
      }
      parts.push(L.join('\n'));
    }
  }

  // 區塊之間空一行：Markdown 段落內的單一換行在部分平台會被合併成同一行
  const markdown = parts.join('\n\n');
  const text = markdown.replace(/\*\*/g, '');
  return { totalMs, markdown, text, vars: { ...vars, report: markdown, reportText: text } };
}

// ---------------------------------------------------------------------
// 設定頁預覽：把報告 Markdown 轉成近似 Webex 顯示效果的 HTML
// 只處理報告會用到的語法：**粗體**、*斜體*、`程式碼`、[連結](網址)、編號 / 項目清單、段落
// ---------------------------------------------------------------------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

export function renderMarkdown(md) {
  const out = [];
  let list = null; // 'ol' | 'ul'
  let para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(md).split('\n')) {
    const line = raw.trimEnd();
    const ol = /^(\d+)\.\s+(.*)$/.exec(line);
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ol || ul) {
      flushPara();
      const want = ol ? 'ol' : 'ul';
      if (list !== want) {
        closeList();
        out.push(ol ? `<ol start="${Number(ol[1])}">` : '<ul>');
        list = want;
      }
      out.push(`<li>${inline(ol ? ol[2] : ul[1])}</li>`);
    } else if (!line.trim()) {
      flushPara();
      closeList();
    } else {
      closeList();
      para.push(inline(line));
    }
  }
  flushPara();
  closeList();
  return out.join('');
}
