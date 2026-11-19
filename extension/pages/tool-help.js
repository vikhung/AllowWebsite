// 「如何申請？」視窗的內容（固定文字，不含使用者輸入）
// steps 為 HTML 字串；links 會顯示在步驟下方。

export const TOOL_HELP = {
  webex: {
    intro: '使用 Webex 的「Incoming Webhooks」，把通知送到你指定的 Webex 空間（Space）。完全免費，支援粗體、清單等格式。',
    steps: [
      '先在 Webex App 建立一個用來接收通知的空間（例如「孩子上網通知」，可以只有你自己一個人）。',
      '開啟 Webex App Hub 的 <b>Incoming Webhooks</b> 頁面（下方連結），用你的 Webex 帳號登入，按 <b>Connect</b>。',
      '在頁面下方填寫 Webhook 名稱（例如「安心上網」），並選擇剛才建立的空間，按 <b>Add</b>。',
      '複製產生的 Webhook URL（<code>https://webexapis.com/v1/webhooks/incoming/…</code>）。',
      '貼到設定頁的「Webhook 網址」，按「傳送測試」確認空間裡有收到訊息，再按儲存。',
    ],
    links: [['Webex App Hub：Incoming Webhooks', 'https://apphub.webex.com/applications/incoming-webhooks-cisco-systems-38054-23307-75252']],
    note: '單則訊息上限約 7KB，超過時會自動截斷。',
  },
  slack: {
    intro: '使用 Slack App 的「Incoming Webhooks」，把通知送到指定的頻道。',
    steps: [
      '開啟 Slack API 的 <b>Your Apps</b> 頁面（下方連結），按 <b>Create New App</b> → <b>From scratch</b>，輸入名稱並選擇你的工作區。',
      '在左側選單點 <b>Incoming Webhooks</b>，把 <b>Activate Incoming Webhooks</b> 打開。',
      '在頁面下方按 <b>Add New Webhook to Workspace</b>，選擇要接收通知的頻道，按 <b>允許</b>。',
      '複製產生的 Webhook URL（<code>https://hooks.slack.com/services/…</code>）。',
      '貼到設定頁的「Webhook 網址」，按「傳送測試」確認頻道有收到訊息，再按儲存。',
    ],
    links: [
      ['Slack API：Your Apps', 'https://api.slack.com/apps'],
      ['Slack 說明：Incoming Webhooks', 'https://api.slack.com/messaging/webhooks'],
    ],
  },
  telegram: {
    intro: '建立一個自己的 Telegram Bot，由 Bot 傳訊息給你（或傳到群組）。完全免費。',
    steps: [
      '在 Telegram 搜尋 <b>@BotFather</b>（有藍色勾勾的官方帳號），傳送 <code>/newbot</code>，依指示輸入 Bot 的名稱與帳號（帳號需以 bot 結尾）。',
      'BotFather 會回覆一串 <b>Bot Token</b>（類似 <code>123456789:AAH…</code>），複製下來。',
      '搜尋你剛建立的 Bot，按 <b>開始（Start）</b>，並隨便傳一則訊息給它。若要送到群組，請把 Bot 加入群組並在群組裡傳一則訊息。',
      '用瀏覽器開啟 <code>https://api.telegram.org/bot&lt;你的 Token&gt;/getUpdates</code>，找到 <code>"chat":{"id":123456789</code> 這段，數字就是 <b>Chat ID</b>（群組的 Chat ID 是負數）。',
      '把 Bot Token 與 Chat ID 填入設定頁，按「傳送測試」確認有收到訊息，再按儲存。',
    ],
    links: [
      ['開啟 @BotFather', 'https://t.me/BotFather'],
      ['Telegram 說明：Bots', 'https://core.telegram.org/bots/tutorial'],
    ],
    note: 'Bot Token 等同密碼，請不要分享給別人。',
  },
  line: {
    intro:
      'LINE Notify 已於 2025 年 3 月 31 日停止服務，現在需要建立一個 <b>LINE 官方帳號</b>，透過 Messaging API 由官方帳號傳訊息給你。LINE 只支援純文字，粗體等格式會自動去除。',
    steps: [
      '到 <b>LINE Official Account Manager</b>（下方連結）用你的 LINE 帳號登入，建立一個官方帳號（例如「安心上網通知」）。',
      '在官方帳號的 <b>設定 → Messaging API</b> 按 <b>啟用 Messaging API</b>，選擇或建立一個服務提供者（Provider）。',
      '到 <b>LINE Developers Console</b>（下方連結），點進剛才的 Provider 與 Channel：<br>・在 <b>Messaging API</b> 分頁最下方的 <b>Channel access token (long-lived)</b> 按 <b>Issue</b>，複製權杖。<br>・在 <b>Basic settings</b> 分頁最下方找到 <b>Your user ID</b>（U 開頭的 33 碼），這就是接收者 ID。',
      '用手機 LINE 掃描 <b>Messaging API</b> 分頁上的 QR code，把官方帳號<b>加為好友</b>（沒加好友收不到訊息）。',
      '把 Channel access token 與 User ID 填入設定頁，按「傳送測試」確認有收到訊息，再按儲存。',
    ],
    links: [
      ['LINE Official Account Manager', 'https://manager.line.biz/'],
      ['LINE Developers Console', 'https://developers.line.biz/console/'],
    ],
    note: '官方帳號的免費方案每月可傳送的訊息則數有限（實際則數請參考 LINE 官方帳號的方案說明），建議 LINE 只用在「上網摘要報告」，封鎖 / 瀏覽通知改用其他工具，以免額度很快用完。也建議在官方帳號的回應設定中關閉自動回應訊息。',
  },
  discord: {
    intro: '使用 Discord 頻道的 Webhook，把通知送到你的伺服器頻道。完全免費。',
    steps: [
      '在 Discord 開啟你的伺服器（沒有的話可以按左側「＋」建立一個只有自己的伺服器）。',
      '對要接收通知的頻道按 <b>⚙ 編輯頻道</b> → <b>整合</b> → <b>Webhook</b> → <b>新 Webhook</b>。',
      '可以修改 Webhook 名稱與大頭貼，然後按 <b>複製 Webhook 網址</b>（<code>https://discord.com/api/webhooks/…</code>）。',
      '貼到設定頁的「Webhook 網址」，按「傳送測試」確認頻道有收到訊息，再按儲存。',
    ],
    links: [['Discord 說明：Webhook 簡介', 'https://support.discord.com/hc/zh-tw/articles/228383668']],
    note: '單則訊息上限 2000 字，網站很多時報告會自動截斷。',
  },
  custom: {
    intro: '送到你自己的伺服器、或上面沒有列出的服務（例如 Microsoft Teams、Google Chat、Make、n8n、IFTTT 等支援 Webhook 的服務）。',
    steps: [
      '在該服務取得接收 Webhook 的網址，並確認它需要的 Method 與 JSON 格式。',
      '在設定頁填寫 Method、URL 與 Payload。Payload 中可以使用 <code>{{message}}</code>（Markdown 格式的定型化訊息）、<code>{{messageText}}</code>（純文字），以及下方列出的其他變數。',
      '按「傳送測試」確認服務有收到，再按儲存。',
    ],
    links: [],
    note: '例如 Google Chat：Payload 填 <code>{"text":"{{messageText}}"}</code>。',
  },
};
