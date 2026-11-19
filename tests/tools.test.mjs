// 執行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMessage,
  formatFor,
  buildToolRequest,
  validateNotify,
  isNotifyConfigured,
  truncateFor,
  escapeMd,
  TOOLS,
} from '../extension/lib/tools.js';
import { buildReport, nl } from '../extension/lib/report.js';
import { normalizeConfig } from '../extension/lib/store.js';

const MD = '**標題** *斜體*\n第二行 <tag> & `code`\n\n1. **a.com** — 5 分\n\n[連結](https://x.test/a?b=1&c=2) 價格 \\*3';

test('formatFor：Webex / Discord 保留 Markdown，單一換行加上強制換行', () => {
  const s = formatFor('webex', MD);
  assert.equal(
    s,
    '**標題** *斜體*  \n第二行 <tag> & `code`\n\n1. **a.com** — 5 分\n\n[連結](https://x.test/a?b=1&c=2) 價格 \\*3'
  );
});

test('formatFor：Slack mrkdwn', () => {
  assert.equal(
    formatFor('slack', MD),
    '*標題* _斜體_\n第二行 &lt;tag&gt; &amp; `code`\n\n1. *a.com* — 5 分\n\n<https://x.test/a?b=1&amp;c=2|連結> 價格 *3'
  );
});

test('formatFor：Telegram HTML', () => {
  assert.equal(
    formatFor('telegram', MD),
    '<b>標題</b> <i>斜體</i>\n第二行 &lt;tag&gt; &amp; <code>code</code>\n\n1. <b>a.com</b> — 5 分\n\n<a href="https://x.test/a?b=1&amp;c=2">連結</a> 價格 *3'
  );
});

test('formatFor：LINE 純文字', () => {
  assert.equal(
    formatFor('line', MD),
    '標題 斜體\n第二行 <tag> & code\n\n1. a.com — 5 分\n\n連結（https://x.test/a?b=1&c=2） 價格 *3'
  );
});

test('buildMessage：變數值做 Markdown 跳脫，網址不跳脫', () => {
  const md = buildMessage('visit', {
    email: 'k@x.com',
    title: '**假粗體** [x]',
    url: 'https://a.com/p?x=[1]',
    localTime: 't',
  });
  assert.match(md, /📄 \\\*\\\*假粗體\\\*\\\* \\\[x\\\]/);
  assert.match(md, /🔗 https:\/\/a\.com\/p\?x=\[1\]/);
  // 轉成 Telegram 時跳脫字元還原為一般文字，不會變成粗體
  assert.match(formatFor('telegram', md), /📄 \*\*假粗體\*\* \[x\]/);
  assert.equal(escapeMd('a*b'), 'a\\*b');
});

test('buildToolRequest：各工具的請求格式', () => {
  const md = '**hi**\nthere';
  const webex = buildToolRequest({ tool: 'webex', url: 'https://webexapis.com/v1/webhooks/incoming/abc' }, md);
  assert.deepEqual(JSON.parse(webex.init.body), { markdown: '**hi**  \nthere' });

  const slack = buildToolRequest({ tool: 'slack', url: 'https://hooks.slack.com/services/T/B/x' }, md);
  assert.equal(JSON.parse(slack.init.body).text, '*hi*\nthere');

  const discord = buildToolRequest({ tool: 'discord', url: 'https://discord.com/api/webhooks/1/x' }, md);
  assert.deepEqual(JSON.parse(discord.init.body).allowed_mentions, { parse: [] });

  const tg = buildToolRequest({ tool: 'telegram', token: '123:AAHabcdefghijklmnopqrstuvwxyz', chatId: '-100' }, md);
  assert.equal(tg.url, 'https://api.telegram.org/bot123:AAHabcdefghijklmnopqrstuvwxyz/sendMessage');
  assert.deepEqual(JSON.parse(tg.init.body), {
    chat_id: '-100',
    text: '<b>hi</b>\nthere',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  const uid = 'U' + 'a'.repeat(32);
  const line = buildToolRequest({ tool: 'line', token: 'tok', chatId: uid }, md);
  assert.equal(line.url, 'https://api.line.me/v2/bot/message/push');
  assert.equal(line.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(line.init.body), { to: uid, messages: [{ type: 'text', text: 'hi\nthere' }] });
});

test('buildToolRequest：自訂 API 可用 {{message}} 與原本的變數', () => {
  const r = buildToolRequest(
    { tool: 'custom', method: 'POST', url: 'https://h.test/x', payload: '{"m":"{{message}}","t":"{{messageText}}","h":"{{host}}"}' },
    '**hi**',
    { host: 'a.com' }
  );
  assert.deepEqual(JSON.parse(r.init.body), { m: '**hi**', t: 'hi', h: 'a.com' });
});

test('buildToolRequest：設定不完整或格式錯誤時回傳 null', () => {
  assert.equal(buildToolRequest({ tool: 'webex', url: '' }, 'x'), null);
  assert.equal(buildToolRequest({ tool: 'webex', url: 'https://evil.test/x' }, 'x'), null);
  assert.equal(buildToolRequest({ tool: 'telegram', token: '123:AAHabcdefghijklmnopqrstuvwxyz' }, 'x'), null);
});

test('validateNotify 與 isNotifyConfigured', () => {
  assert.equal(validateNotify({ tool: 'webex', url: '' }), null); // 空白不算格式錯誤
  assert.match(validateNotify({ tool: 'slack', url: 'https://example.com/x' }), /Slack/);
  assert.match(validateNotify({ tool: 'telegram', token: 'abc' }), /Bot Token/);
  assert.match(validateNotify({ tool: 'line', chatId: 'abc' }), /U（使用者）/);
  assert.match(validateNotify({ tool: 'custom', url: 'ftp://x' }), /URL/);
  assert.equal(validateNotify({ tool: 'telegram', token: '1:AAHabcdefghijklmnopqrstuvwxyz', chatId: '@my_channel' }), null);
  assert.ok(!isNotifyConfigured({ tool: 'line', token: 't' }));
  assert.ok(isNotifyConfigured({ tool: 'line', token: 't', chatId: 'U1' }));
  assert.ok(isNotifyConfigured({ tool: 'custom', url: 'https://x' }));
});

test('truncateFor：超過單則上限時截斷（Discord 2000 字、Webex 以 bytes 計）', () => {
  const long = '字'.repeat(3000);
  const d = truncateFor('discord', long);
  assert.ok([...d].length <= TOOLS.discord.limit);
  assert.match(d, /已截斷/);
  const w = truncateFor('webex', long);
  assert.ok(new TextEncoder().encode(w).length <= TOOLS.webex.limit);
  assert.equal(truncateFor('slack', 'short'), 'short');
});

test('報告範本換行：Enter 或 \\n 都會換行，多餘空行壓成一行', () => {
  assert.equal(nl('a \\n b\r\nc\n\n\n\nd'), 'a \n b\nc\n\nd');
  const r = buildReport({
    kind: 'daily',
    days: ['2026-11-19'],
    usageByDay: {},
    email: 'k@x.com',
    device: '書房',
    template: [{ type: 'text', on: true, text: '👤 {{email}} \\n 💻 {{device}}' }],
  });
  assert.ok(r.markdown.startsWith('👤 k@x.com \n 💻 書房'));
  // 轉成 Webex 時加上強制換行；LINE 為純文字換行
  assert.ok(formatFor('webex', r.markdown).startsWith('👤 k@x.com  \n 💻 書房'));
});

test('normalizeConfig：通知工具預設 Webex；舊設定已填 URL 的視為自訂 API', () => {
  const c = normalizeConfig({});
  assert.equal(c.blocking.notify.tool, 'webex');
  assert.equal(c.monitor.notify.tool, 'webex');
  assert.equal(c.report.notify.tool, 'webex');
  const old = normalizeConfig({ monitor: { enabled: true, notify: { method: 'POST', url: 'https://h.test/x', payload: '{}' } } });
  assert.equal(old.monitor.notify.tool, 'custom');
  assert.equal(old.monitor.notify.url, 'https://h.test/x');
  const bad = normalizeConfig({ report: { notify: { tool: 'nope' } } });
  assert.equal(bad.report.notify.tool, 'webex');
});
