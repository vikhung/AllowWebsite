// 執行：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime,
  dateKey,
  latestDue,
  reportDays,
  hostKey,
  mergeUsage,
  formatDuration,
  formatDate,
  buildReport,
  normalizeTemplate,
  renderMarkdown,
  fillLine,
  DEFAULT_TEMPLATE,
} from '../extension/lib/report.js';
import { normalizeConfig, buildNotifyRequest, fitsSyncItem } from '../extension/lib/store.js';

const MIN = 60000;

test('parseTime', () => {
  assert.deepEqual(parseTime('21:00'), [21, 0]);
  assert.deepEqual(parseTime('7:05'), [7, 5]);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('21:60'), null);
  assert.equal(parseTime(''), null);
  assert.equal(parseTime(undefined), null);
});

test('latestDue：每日', () => {
  // 2026-11-19 是週四
  assert.equal(dateKey(latestDue(new Date(2026, 10, 19, 20, 59), '21:00')), '2026-11-18');
  const d = latestDue(new Date(2026, 10, 19, 21, 0), '21:00');
  assert.equal(dateKey(d), '2026-11-19');
  assert.equal(d.getHours(), 21);
  assert.equal(dateKey(latestDue(new Date(2026, 10, 19, 7, 59), '08:00')), '2026-11-18');
  assert.equal(dateKey(latestDue(new Date(2026, 10, 19, 8, 0), '08:00')), '2026-11-19');
});

test('latestDue：每週', () => {
  // 週日 21:00；現在是週四 → 上週日 11/15
  assert.equal(dateKey(latestDue(new Date(2026, 10, 19, 12, 0), '21:00', 0)), '2026-11-15');
  // 週四 21:00；現在是週四 20:00 → 上週四；21:30 → 今天
  assert.equal(dateKey(latestDue(new Date(2026, 10, 19, 20, 0), '21:00', 4)), '2026-11-12');
  assert.equal(dateKey(latestDue(new Date(2026, 10, 19, 21, 30), '21:00', 4)), '2026-11-19');
  // 跨月
  assert.equal(dateKey(latestDue(new Date(2026, 11, 2, 9, 0), '21:00', 0)), '2026-11-29');
});

test('reportDays：都是完整的日子（每日 = 前一天；每週 = 前 7 天）', () => {
  assert.deepEqual(reportDays('daily', new Date(2026, 10, 1, 8, 0)), ['2026-10-31']);
  // 週六 11/21 09:00 寄出 → 11/14（六）～ 11/20（五）
  const w = reportDays('weekly', new Date(2026, 10, 21, 9, 0));
  assert.equal(w.length, 7);
  assert.equal(w[0], '2026-11-14');
  assert.equal(w[6], '2026-11-20');
});

test('hostKey 與 mergeUsage', () => {
  assert.equal(hostKey('WWW.YouTube.com.'), 'youtube.com');
  assert.equal(hostKey('m.youtube.com'), 'm.youtube.com');
  const rows = mergeUsage([{ 'a.com': 5 * MIN, 'b.com': 1 * MIN }, { 'b.com': 10 * MIN, 'c.com': 0 }, undefined]);
  assert.deepEqual(rows, [
    { host: 'b.com', ms: 11 * MIN },
    { host: 'a.com', ms: 5 * MIN },
  ]);
});

test('formatDuration 與 formatDate', () => {
  assert.equal(formatDuration(20 * 1000), '不到 1 分鐘');
  assert.equal(formatDuration(45 * MIN), '45 分鐘');
  assert.equal(formatDuration(120 * MIN), '2 小時');
  assert.equal(formatDuration(83 * MIN), '1 小時 23 分');
  assert.equal(formatDate('2026-11-19'), '2026/11/19（四）');
  assert.equal(formatDate('2026-11-15', true), '11/15（日）');
});

test('buildReport：每日報告內容與排行', () => {
  const r = buildReport({
    kind: 'daily',
    days: ['2026-11-19'],
    usageByDay: { '2026-11-19': { 'youtube.com': 90 * MIN, 'pbskids.org': 30 * MIN } },
    email: 'kid@gmail.com',
    device: '客廳電腦',
  });
  assert.equal(r.totalMs, 120 * MIN);
  assert.match(r.markdown, /每日上網摘要｜2026\/11\/19（四）/);
  assert.match(r.markdown, /客廳電腦/);
  assert.match(r.markdown, /總上網時間：\*\*2 小時\*\*（2 個網站）/);
  assert.match(r.markdown, /1\. \*\*youtube\.com\*\* — 1 小時 30 分（75%）/);
  assert.match(r.markdown, /2\. \*\*pbskids\.org\*\* — 30 分鐘（25%）/);
  assert.ok(!r.text.includes('**'));
  assert.equal(r.vars.report, r.markdown);
  assert.equal(r.vars.totalTime, '2 小時');
  assert.equal(r.vars.siteCount, 2);
  assert.ok(!/每日上網時間/.test(r.markdown));
});

test('buildReport：每週報告含每日上網時間，網站過多時合併為「其他」', () => {
  const days = reportDays('weekly', new Date(2026, 10, 16, 9, 0)); // 11/9（一）～ 11/15（日）
  const usage = {};
  for (let i = 0; i < 30; i++) usage[`site${i}.com`] = (30 - i) * MIN;
  const r = buildReport({ kind: 'weekly', days, usageByDay: { [days[6]]: usage } });
  assert.match(r.markdown, /每週上網摘要｜2026\/11\/9（一） ～ 2026\/11\/15（日）/);
  assert.match(r.markdown, /20\. \*\*site19\.com\*\*/);
  assert.ok(!r.markdown.includes('21. '));
  assert.match(r.markdown, /…其他 10 個網站/);
  assert.match(r.markdown, /- 11\/9（一）　沒有紀錄/);
  assert.match(r.markdown, /- 11\/15（日）　7 小時 45 分/);
});

test('buildReport：沒有紀錄', () => {
  const r = buildReport({ kind: 'daily', days: ['2026-11-19'], usageByDay: {} });
  assert.equal(r.totalMs, 0);
  assert.match(r.markdown, /沒有上網紀錄/);
});

test('報告透過 Webex 預設 Payload 送出時是合法 JSON，換行被跳脫', () => {
  const c = normalizeConfig({});
  const r = buildReport({
    kind: 'daily',
    days: ['2026-11-19'],
    usageByDay: { '2026-11-19': { 'a"b.com': 3 * MIN } },
  });
  const req = buildNotifyRequest(
    { ...c.report.notify, url: 'https://webexapis.com/v1/webhooks/incoming/abc' },
    r.vars
  );
  assert.equal(req.init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(req.init.body).markdown, r.markdown);
  // Webex 單則訊息上限約 7439 bytes；最多網站時也要在範圍內
  const big = {};
  for (let i = 0; i < 500; i++) big[`some-long-subdomain-${i}.example-website.com`] = (i + 1) * MIN;
  const w = buildReport({ kind: 'weekly', days: reportDays('weekly', new Date()), usageByDay: { [dateKey(new Date())]: big } });
  assert.ok(new TextEncoder().encode(JSON.stringify({ markdown: w.markdown })).length < 7000);
});

test('normalizeConfig：摘要報告預設關閉，並修正無效的時間與星期', () => {
  const c = normalizeConfig({});
  assert.equal(c.report.enabled, false);
  assert.equal(c.report.dailyTime, '08:00');
  assert.equal(c.report.weeklyTime, '09:00');
  assert.equal(c.report.weekday, 6);
  assert.deepEqual(c.report.template, DEFAULT_TEMPLATE);
  assert.ok(c.report.daily && c.report.weekly);
  assert.match(c.report.notify.payload, /"markdown": "\{\{report\}\}"/);
  const c2 = normalizeConfig({
    report: { enabled: true, time: '21:00', dailyTime: '25:00', weekday: 9, notify: { url: 'https://x.test' } },
  });
  assert.equal(c2.report.enabled, true);
  assert.equal(c2.report.dailyTime, '08:00');
  assert.ok(!('time' in c2.report));
  assert.equal(c2.report.weekday, 6);
  assert.equal(c2.report.notify.url, 'https://x.test');
  assert.equal(c2.report.notify.method, 'POST');
  assert.ok(fitsSyncItem('report', c2.report));
});

test('自訂範本：排序、關閉區塊、自訂文字與列格式', () => {
  const template = [
    { type: 'text', on: true, text: '## {{device}} 的{{period}}報告' },
    { type: 'ranking', on: true, heading: '', item: '- {{host}}：{{time}}', limit: 1, other: '' },
    { type: 'text', on: false, text: '不會出現' },
    { type: 'text', on: true, text: '' },
    { type: 'text', on: true, text: '加油！{{unknown}}' },
  ];
  const r = buildReport({
    kind: 'weekly',
    days: ['2026-11-19'],
    usageByDay: { '2026-11-19': { 'a.com': 5 * MIN, 'b.com': 3 * MIN } },
    device: '書房',
    template,
  });
  // 範本沒有 days 區塊時會自動補上（預設開啟），排在最後
  assert.equal(
    r.markdown,
    `## 書房 的每週報告

- a.com：5 分鐘

加油！{{unknown}}

**每日上網時間**

- 11/19（四）　8 分鐘`
  );
});

test('buildReport：測試報告加上提示；每日報告不顯示每日上網時間區塊', () => {
  const r = buildReport({ kind: 'daily', days: ['2026-11-19'], usageByDay: {}, test: true });
  assert.ok(r.markdown.startsWith('🧪 這是測試報告'));
  assert.ok(!r.markdown.includes('每日上網時間'));
});

test('normalizeTemplate：修正無效內容', () => {
  assert.deepEqual(normalizeTemplate(null), DEFAULT_TEMPLATE);
  assert.deepEqual(normalizeTemplate([]), DEFAULT_TEMPLATE);
  const t = normalizeTemplate([
    { type: 'ranking', limit: 999 },
    { type: 'ranking', limit: 3 }, // 重複的排行區塊會被忽略
    { type: 'evil', text: 'x' },
    { type: 'text', text: 'x'.repeat(1000) },
    null,
  ]);
  assert.deepEqual(t.map((b) => b.type), ['ranking', 'text', 'days']);
  assert.equal(t[0].limit, 50);
  assert.equal(t[0].heading, DEFAULT_TEMPLATE[3].heading);
  assert.equal(t[1].text.length, 300);
});

test('fillLine', () => {
  assert.equal(fillLine('{{a}}-{{ b }}-{{c}}', { a: 1, b: 'x' }), '1-x-{{c}}');
});

test('renderMarkdown：粗體、清單、段落，並跳脫 HTML', () => {
  assert.equal(
    renderMarkdown(`**標題** <b>x</b>
第二行

1. **a.com** — 5 分
2. b.com

- 11/9　*沒有*

[連結](https://x.test/?a=1&b=2)`),
    '<p><strong>標題</strong> &lt;b&gt;x&lt;/b&gt;<br>第二行</p>' +
      '<ol start="1"><li><strong>a.com</strong> — 5 分</li><li>b.com</li></ol>' +
      '<ul><li>11/9　<em>沒有</em></li></ul>' +
      '<p><a href="https://x.test/?a=1&amp;b=2" target="_blank" rel="noopener">連結</a></p>'
  );
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('<a'));
});
