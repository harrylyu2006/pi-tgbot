/** The one-time input page. Self-contained: no external scripts, fonts or images. */

import { CLIENT_CRYPTO_JS } from "./envelope.ts";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#14171a;--mut:#6b7280;--line:#d7dbe0;--acc:#2563eb;--ok:#15803d;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#e8eaed;--mut:#9aa0a6;--line:#2c313a;--acc:#6ea0ff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Noto Sans SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:19px;margin:0 0 4px}.sub{color:var(--mut);font-size:14px;margin:0 0 16px}
dl{margin:0 0 16px;font-size:14px}dt{color:var(--mut);float:left;clear:left;width:3.2em}dd{margin:0 0 4px 3.2em;word-break:break-all}code{background:var(--bg);padding:1px 6px;border-radius:5px}
input[type=password],input[type=text],textarea{width:100%;font:16px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg)}
textarea{min-height:150px;resize:vertical}textarea.mask{-webkit-text-security:disc;text-security:disc}
input:focus,textarea:focus{outline:2px solid var(--acc);border-color:transparent}
.row{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0;font-size:14px;color:var(--mut)}label.chk{display:flex;gap:8px;align-items:flex-start;margin:10px 0;font-size:14px}label.chk input{margin-top:4px}
button{width:100%;margin-top:6px;padding:13px;border:0;border-radius:9px;background:var(--acc);color:#fff;font-size:16px;font-weight:600}button:disabled{opacity:.5}
button.ghost{background:none;color:var(--acc);width:auto;padding:0;margin:0;font-size:14px;font-weight:400}
#msg{min-height:1.4em;margin-top:12px;font-size:14px}.ok{color:var(--ok)}.bad{color:var(--bad)}
.foot{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);font-size:12px;color:var(--mut)}.hide{display:none}
`;

const PAGE_JS = `
(() => {
  const d = document.body.dataset, $ = (id) => document.getElementById(id);
  const one = $('one'), many = $('many'), go = $('go'), msg = $('msg'), timer = $('timer');
  const exp = Number(d.exp), unlock = d.kind === 'unlock';
  let multi = false, shown = false, done = false;
  const val = () => (multi ? many.value : one.value);
  const say = (t, cls) => { msg.textContent = t; msg.className = cls || ''; };
  $('multi').addEventListener('change', (e) => {
    multi = e.target.checked; one.classList.toggle('hide', multi); many.classList.toggle('hide', !multi);
    (multi ? many : one).focus();
  });
  $('show').addEventListener('click', () => {
    shown = !shown; one.type = shown ? 'text' : 'password'; many.classList.toggle('mask', !shown);
    $('show').textContent = shown ? '隐藏' : '显示';
  });
  many.classList.add('mask');
  const tick = () => {
    const left = Math.max(0, Math.floor((exp - Date.now()) / 1000));
    timer.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    if (left === 0 && !done) { done = true; go.disabled = true; say('链接已过期，请回 Telegram 重新获取。', 'bad'); }
  };
  tick(); const iv = setInterval(() => { if (done) clearInterval(iv); else tick(); }, 1000);
  go.addEventListener('click', async () => {
    if (done) return;
    const v = val().replace(/\\r\\n/g, '\\n');
    if (!v) { say('请先输入内容。', 'bad'); return; }
    go.disabled = true; say('正在本地加密并发送…');
    try {
      const env = await piSealSecret(d.pub, d.token, JSON.stringify({ v, c: unlock ? false : $('confirm').checked }));
      const r = await fetch(location.pathname, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(env), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { const er = new Error(j.error || ('HTTP ' + r.status)); er.retry = r.status === 422 && j.retry !== false; throw er; }
      done = true; one.value = ''; many.value = '';
      $('form').classList.add('hide'); $('tl').classList.add('hide'); timer.classList.add('hide'); $('okbox').classList.remove('hide');
      $('len').textContent = String(j.length);
      if (unlock) { $('oktext').textContent = '已解锁：' + (j.detail || ''); $('okmore').textContent = '现在可以关闭此页面，回 Telegram 继续。主密码不会保存到磁盘。'; }
      if (j.warn) $('warn').textContent = j.warn;
    } catch (e) {
      go.disabled = false;
      if (unlock && e && e.retry) { say(e.message, 'bad'); many.value = ''; one.value = ''; one.focus(); return; }
      say(e && e.message === 'no-webcrypto' ? '这个浏览器不支持加密接口，请改用系统浏览器（Safari/Chrome）打开。' : '发送失败：' + (e && e.message ? e.message : e), 'bad');
    }
  });
})();
`;

export interface PageInfo {
	kind: "secret" | "unlock";
	name: string;
	description: string;
	token: string;
	publicKeyB64u: string;
	expiresAt: number;
	nonce: string;
	replacing: boolean;
}

export function renderPage(p: PageInfo): string {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<title>安全输入</title><style nonce="${p.nonce}">${CSS}</style></head>
<body data-token="${esc(p.token)}" data-pub="${esc(p.publicKeyB64u)}" data-exp="${p.expiresAt}" data-kind="${p.kind}">
<main>
<h1>${p.kind === "unlock" ? "🔓 解锁 KeePass" : "🔐 安全输入"}</h1>
<p class="sub">${p.kind === "unlock" ? "输入 KeePass 主密码。它只在浏览器里加密后发给你自己的服务器，只放在内存里用来打开数据库，不会写入磁盘，也不会出现在聊天记录里。" : "输入的内容只在浏览器里加密后发给你自己的服务器，不会出现在 Telegram 聊天记录里。"}</p>
<dl><dt>名称</dt><dd><code>${esc(p.name)}</code>${p.replacing && p.kind !== "unlock" ? "（将覆盖已有的值）" : ""}</dd>${p.description ? `<dt>用途</dt><dd>${esc(p.description)}</dd>` : ""}<dt id="tl">剩余</dt><dd id="timer">--:--</dd></dl>
<div id="form">
<input id="one" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="在这里输入" aria-label="secret">
<textarea id="many" class="hide" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="多行内容（SSH 私钥、Cookie 等）" aria-label="secret"></textarea>
<div class="row"><label${p.kind === "unlock" ? ' class="hide"' : ""}><input id="multi" type="checkbox"> 多行</label><button id="show" class="ghost" type="button">显示</button></div>
${p.kind === "unlock" ? '<input id="confirm" type="checkbox" class="hide">' : '<label class="chk"><input id="confirm" type="checkbox"><span>每次使用前都要在 Telegram 里点确认（更安全，适合银行/主力账号；不勾选则 AI 可直接使用）</span></label>'}
<button id="go" type="button">${p.kind === "unlock" ? "解锁" : "加密并保存"}</button>
<div id="msg" role="status"></div>
</div>
<div id="okbox" class="hide"><p class="ok" id="oktext">✅ 已加密保存（<span id="len">0</span> 个字符）。</p><p id="okmore">现在可以关闭此页面，回 Telegram 继续。</p><p id="warn" class="bad"></p></div>
<div class="foot">传输：HTTPS + 浏览器端 ECDH/AES-GCM 一次性密钥加密。此链接只能使用一次，到期自动作废。若这个页面不是你在 Telegram 里点开的，请关闭。</div>
</main>
<script nonce="${p.nonce}">${CLIENT_CRYPTO_JS}${PAGE_JS}</script>
</body></html>`;
}

export function renderGone(nonce: string): string {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>链接无效</title><style nonce="${nonce}">${CSS}</style></head><body><main><h1>链接无效或已过期</h1><p class="sub">这个安全输入链接已经用过、过期或不存在。请回 Telegram 重新获取。</p></main></body></html>`;
}
