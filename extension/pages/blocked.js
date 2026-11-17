import { addDomains, normalizeDomain, verifyPassword } from '../lib/store.js';

const $ = (id) => document.getElementById(id);
const target = location.hash.slice(1);
let host = '';
try {
  const u = new URL(target);
  if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
} catch {
  /* 無效網址 */
}

// 通知家長（是否真的送出、節流等由 background 決定）
if (host) chrome.runtime.sendMessage({ type: 'blocked', url: target }).catch(() => {});

$('host').textContent = host || '這個網站';
$('fullUrl').textContent = target;
$('domain').value = normalizeDomain(host) || '';

$('backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else window.close();
});

async function allow() {
  const m = $('msg');
  const domain = normalizeDomain($('domain').value);
  if (!domain) {
    m.className = 'msg err';
    m.textContent = '網域格式不正確。';
    return;
  }
  if (!(await verifyPassword($('pw').value))) {
    m.className = 'msg err';
    m.textContent = '密碼錯誤。';
    return;
  }
  await addDomains([domain]);
  try {
    await chrome.runtime.sendMessage({ type: 'apply' });
  } catch {
    /* ignore */
  }
  m.className = 'msg ok';
  m.textContent = `已允許 ${domain}，正在開啟…`;
  if (host) location.replace(target);
}
$('allowBtn').addEventListener('click', allow);
$('pw').addEventListener('keydown', (e) => e.key === 'Enter' && allow());
