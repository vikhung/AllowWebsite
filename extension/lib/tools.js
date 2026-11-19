// 通知工具：每種工具有固定的訊息格式（定型化），家長只需要填網址或權杖。
// 純函式（不使用 chrome.*），可在 Node 中測試。
//
// 訊息內部一律先組成「簡易 Markdown」：**粗體**、*斜體*、`程式碼`、[文字](網址)、
// 「1. 」/「- 」開頭的清單、單一換行 = 換行、空一行 = 分段；再依工具轉成各自的格式。

import { buildNotifyRequest } from './store.js';
import { fillLine } from './report.js';

export const TOOL_ORDER = ['webex', 'slack', 'telegram', 'line', 'discord', 'custom'];

/**
 * fields：設定頁要顯示的欄位（url / token / chatId；custom 另外顯示 Method / Payload）
 * format：markdown（Webex、Discord）、slack（mrkdwn）、telegram（HTML）、plain（LINE）
 * limit / unit：單則訊息上限（超過時自動截斷）
 */
export const TOOLS = {
  webex: { label: 'Webex', icon: '💬', fields: ['url'], format: 'markdown', limit: 7439, unit: 'bytes' },
  slack: { label: 'Slack', icon: '💼', fields: ['url'], format: 'slack', limit: 39000, unit: 'chars' },
  telegram: { label: 'Telegram', icon: '✈️', fields: ['token', 'chatId'], format: 'telegram', limit: 4096, unit: 'chars' },
  line: { label: 'LINE', icon: '🟢', fields: ['token', 'chatId'], format: 'plain', limit: 5000, unit: 'chars' },
  discord: { label: 'Discord', icon: '🎮', fields: ['url'], format: 'markdown', limit: 2000, unit: 'chars' },
  custom: { label: '自訂 API', icon: '🔧', fields: ['url'], format: 'markdown', limit: Infinity, unit: 'chars' },
};

export const FIELD_LABELS = {
  webex: { url: 'Webhook 網址' },
  slack: { url: 'Webhook 網址' },
  discord: { url: 'Webhook 網址' },
  telegram: { token: 'Bot Token', chatId: 'Chat ID' },
  line: { token: 'Channel access token（長期）', chatId: '接收者 User ID' },
  custom: { url: 'URL' },
};

export const FIELD_PLACEHOLDERS = {
  webex: { url: 'https://webexapis.com/v1/webhooks/incoming/…' },
  slack: { url: 'https://hooks.slack.com/services/…' },
  discord: { url: 'https://discord.com/api/webhooks/…' },
  telegram: { token: '123456789:AAH…', chatId: '例如 123456789（群組為負數）' },
  line: { token: '在 LINE Developers 發行的長期權杖', chatId: 'U 開頭的 33 碼，例如 U1234…' },
  custom: { url: 'https://example.com/webhook' },
};

const URL_PREFIX = {
  webex: /^https:\/\/webexapis\.com\/v1\/webhooks\/incoming\/\S+$/,
  slack: /^https:\/\/hooks\.slack\.com\/\S+$/,
  discord: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\S+$/,
};

/** 封鎖通知與瀏覽通知的定型化訊息（變數值會先做 Markdown 跳脫） */
export const MESSAGES = {
  blocked: '⛔ **孩子嘗試開啟未允許的網站**\n👤 {{email}}\n🌐 {{host}}\n🔗 {{url}}\n🕒 {{localTime}}',
  visit: '👀 **孩子正在瀏覽網站**\n👤 {{email}}\n📄 {{title}}\n🔗 {{url}}\n🕒 {{localTime}}',
};

/** 跳脫會被當成格式的字元（網址除外，以免連結失效） */
export function escapeMd(v) {
  return String(v ?? '').replace(/([\\*`[\]])/g, '\\$1');
}

export function buildMessage(kind, vars) {
  const safe = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, k === 'url' ? String(v) : escapeMd(v)]));
  return fillLine(MESSAGES[kind] || '', safe);
}

// ---------------------------------------------------------------------
// 格式轉換
// ---------------------------------------------------------------------

const htmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 先把 \* 之類的跳脫字元換成佔位符，轉換完再還原 */
function protect(s) {
  const kept = [];
  const out = s.replace(/\\([\\*`[\]])/g, (_, c) => {
    kept.push(c);
    return `\u0000${kept.length - 1}\u0001`;
  });
  return { out, restore: (t, fn) => t.replace(/\u0000(\d+)\u0001/g, (_, i) => fn(kept[Number(i)])) };
}

export function formatFor(tool, md) {
  const fmt = (TOOLS[tool] || TOOLS.custom).format;
  const { out, restore } = protect(String(md ?? ''));
  let s = out;
  if (fmt === 'markdown') {
    // 一般 Markdown 中單一換行可能被合併成同一行：非空行之後還有內容時，行尾加兩個空白（強制換行）
    s = s
      .split('\n')
      .map((line, i, a) => (line.trim() && a[i + 1]?.trim() ? line.replace(/\s*$/, '  ') : line))
      .join('\n');
    return restore(s, (c) => '\\' + c);
  }
  if (fmt === 'slack') {
    s = htmlEsc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
      .replace(/\*\*(.+?)\*\*/g, '\u0002$1\u0002')
      .replace(/\*([^*\n]+)\*/g, '_$1_')
      .replace(/\u0002/g, '*');
    return restore(s, (c) => htmlEsc(c));
  }
  if (fmt === 'telegram') {
    s = htmlEsc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*\n]+)\*/g, '<i>$1</i>');
    return restore(s, (c) => htmlEsc(c));
  }
  // plain（LINE）：去掉格式符號，連結改成「文字（網址）」
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1（$2）')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1');
  return restore(s, (c) => c);
}

/** 依工具的單則上限截斷 */
export function truncateFor(tool, text) {
  const t = TOOLS[tool] || TOOLS.custom;
  const note = '\n…（內容過長，已截斷）';
  const size = (s) => (t.unit === 'bytes' ? new TextEncoder().encode(s).length : [...s].length);
  if (size(text) <= t.limit) return text;
  let chars = [...text];
  while (chars.length && size(chars.join('') + note) > t.limit) chars = chars.slice(0, Math.floor(chars.length * 0.9));
  return chars.join('') + note;
}

export function messageSize(tool, text) {
  const t = TOOLS[tool] || TOOLS.custom;
  return t.unit === 'bytes' ? new TextEncoder().encode(text).length : [...text].length;
}

// ---------------------------------------------------------------------
// 設定驗證與請求組裝
// ---------------------------------------------------------------------

/** 是否已填好必要欄位（不檢查格式） */
export function isNotifyConfigured(n) {
  const t = TOOLS[n?.tool] || TOOLS.custom;
  return t.fields.every((f) => String(n?.[f] ?? '').trim());
}

/** 檢查格式；正確時回傳 null，否則回傳錯誤說明。空白欄位不算錯（由 isNotifyConfigured 判斷） */
export function validateNotify(n) {
  const tool = TOOLS[n?.tool] ? n.tool : 'custom';
  const url = String(n?.url ?? '').trim();
  const token = String(n?.token ?? '').trim();
  const chatId = String(n?.chatId ?? '').trim();
  if (URL_PREFIX[tool] && url && !URL_PREFIX[tool].test(url)) {
    return `${TOOLS[tool].label} 的 Webhook 網址格式不正確，應以 ${FIELD_PLACEHOLDERS[tool].url.replace('…', '')} 開頭。`;
  }
  if (tool === 'telegram') {
    if (token && !/^\d+:[\w-]{20,}$/.test(token)) return 'Bot Token 格式不正確（應類似 123456789:AAH…）。';
    if (chatId && !/^(-?\d+|@\w{4,})$/.test(chatId)) return 'Chat ID 應為數字（群組為負數）或 @頻道名稱。';
  }
  if (tool === 'line') {
    if (token && /\s/.test(token)) return 'Channel access token 不應包含空白。';
    if (chatId && !/^[UCR][0-9a-f]{32}$/.test(chatId)) return '接收者 ID 應為 U（使用者）、C（群組）或 R（聊天室）開頭加 32 碼英數字。';
  }
  if (tool === 'custom' && url && !buildNotifyRequest({ ...n, payload: '' }, {})) {
    return 'URL 格式不正確，需以 http:// 或 https:// 開頭。';
  }
  return null;
}

/**
 * 組出要送出的請求：{ url, init } 或 null。
 * md = 簡易 Markdown 訊息；vars = 自訂 API 可用的變數（另外提供 {{message}} {{messageText}}）
 */
export function buildToolRequest(n, md, vars = {}) {
  const tool = TOOLS[n?.tool] ? n.tool : 'custom';
  if (!isNotifyConfigured({ ...n, tool }) || validateNotify({ ...n, tool })) return null;
  if (tool === 'custom') {
    return buildNotifyRequest(n, { ...vars, message: md, messageText: formatFor('line', md) });
  }
  const text = truncateFor(tool, formatFor(tool, md));
  const json = (url, body, headers = {}) => ({
    url,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
  });
  const url = String(n.url ?? '').trim();
  const token = String(n.token ?? '').trim();
  const chatId = String(n.chatId ?? '').trim();
  switch (tool) {
    case 'webex':
      return json(url, { markdown: text });
    case 'slack':
      return json(url, { text, unfurl_links: false, unfurl_media: false });
    case 'discord':
      return json(url, { content: text, allowed_mentions: { parse: [] } });
    case 'telegram':
      return json(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    case 'line':
      return json(
        'https://api.line.me/v2/bot/message/push',
        { to: chatId, messages: [{ type: 'text', text }] },
        { Authorization: `Bearer ${token}` }
      );
  }
  return null;
}
