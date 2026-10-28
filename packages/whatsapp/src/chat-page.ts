// The emulator's /dev/chat page: a phone-style messaging client for driving Dockhand locally and for screen
// recordings. Our own styling and icons (no messenger logos or assets). Plain HTML/CSS/JS from strings; every
// piece of message text is rendered with textContent (WhatsApp-style *bold* etc. become elements, never HTML).
// DOM hooks used by pnpm demo:check: #from #text #file #asdoc #voice #send #error #reset, rows [data-wa],
// buttons [data-button-id].

export function chatPage(opts: { base: string; defaultFrom: string; business: string }): string {
  // JSON inside <script>: escape "<" so a value can never close the tag.
  const config = JSON.stringify(opts).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dockhand chat (emulator)</title>
<style>${CSS}</style>
</head>
<body>
<main class="phone">
  <header class="top">
    <div class="avatar" aria-hidden="true">${MARK}</div>
    <div class="who">
      <div class="name">Dockhand</div>
      <div class="sub" id="status">business account</div>
    </div>
    <label class="from" title="The rep's number (E.164 digits)">
      <span>You</span><input id="from" inputmode="numeric" autocomplete="off" placeholder="5511999990000">
    </label>
    <button type="button" id="reset" class="icon-btn" title="Clear the emulator's messages and media" aria-label="Reset">${ICONS.reset}</button>
  </header>
  <section id="thread" class="thread" aria-live="polite"></section>
  <form id="composer" class="composer">
    <div id="replybar" class="bar" hidden>
      <div class="bar-quote"><b>Replying to</b><span id="replytext"></span></div>
      <button type="button" id="replyclear" class="x" aria-label="Cancel reply">${ICONS.close}</button>
    </div>
    <div id="filebar" class="bar" hidden>
      <span class="file-ico">${ICONS.file}</span>
      <span id="filename" class="bar-name"></span>
      <label class="toggle" id="voicewrap"><input type="checkbox" name="voice" id="voice"> voice note</label>
      <label class="toggle"><input type="checkbox" name="asDocument" id="asdoc"> as document</label>
      <button type="button" id="fileclear" class="x" aria-label="Remove file">${ICONS.close}</button>
    </div>
    <div id="error" class="error" role="alert" hidden></div>
    <div class="row">
      <label class="round attach" title="Attach a voice note (OGG), photo, PDF or MP4">${ICONS.clip}
        <input type="file" id="file" name="file" accept="audio/*,.ogg,.opus,image/jpeg,image/png,application/pdf,video/mp4">
      </label>
      <div class="field">
        <input id="text" name="text" class="text" autocomplete="off" placeholder="Message">
        <label class="fwd" title="Mark as forwarded"><input type="checkbox" name="forwarded" id="forwarded">${ICONS.forward}</label>
      </div>
      <button type="submit" id="send" class="round send" aria-label="Send">${ICONS.send}</button>
    </div>
  </form>
</main>
<div id="lightbox" class="lightbox" hidden><img alt=""></div>
<script id="cfg" type="application/json">${config}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

// A dock cleat on a rounded square: Dockhand's own mark.
const MARK = `<svg viewBox="0 0 32 32" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M7 13h18M11 13v8M21 13v8M8 21h16"/></svg>`;

const ICONS = {
  send: `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12.5 2-12.5 2z"/></svg>`,
  clip: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
  reset: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  file: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>`,
  forward: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 6 6-6 6"/><path d="M21 11H9a6 6 0 0 0-6 6v2"/></svg>`,
};

const CSS = `
:root {
  --ink:#101c26; --muted:#5f6f7c; --line:#d9e1e7; --accent:#0d6e6e; --accent-ink:#0a5858; --navy:#0b3048;
  --bg:#e9eef1; --rep:#d3eeea; --bot:#ffffff; --chip:#ffffffd9; --read:#2f8fd8; --danger:#c43c2c;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; }
body { background: radial-gradient(1200px 700px at 30% 10%, #f6f8fa 0%, #dfe6eb 60%, #d3dce2 100%);
  font: 15.5px/1.42 "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--ink); }
.phone { width: 100%; max-width: 440px; height: 100vh; margin: 0 auto; display: flex; flex-direction: column; background: var(--bg); overflow: hidden; }
@media (min-width: 560px) { .phone { height: calc(100vh - 40px); margin: 20px auto; border-radius: 28px; border: 10px solid #15232e; box-shadow: 0 24px 60px rgba(16,28,38,.28); } }
.top { display: flex; align-items: center; gap: 10px; padding: 12px 12px 12px 14px; background: var(--navy); color: #fff; }
.avatar { width: 40px; height: 40px; flex: none; border-radius: 12px; background: linear-gradient(135deg,#1f8a8a,#0d6e6e); display: grid; place-items: center; color: #fff; }
.who { flex: 1; min-width: 0; }
.name { font-weight: 650; font-size: 16.5px; letter-spacing: .01em; }
.sub { font-size: 12.5px; color: #b9d3e0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub.typing { color: #8ee0d2; font-style: italic; }
.from { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #b9d3e0; }
.from input { width: 118px; border: 0; border-radius: 8px; padding: 5px 7px; font: inherit; font-size: 12.5px; background: #ffffff1f; color: #fff; }
.from input::placeholder { color: #ffffff80; }
button { font: inherit; cursor: pointer; }
.icon-btn { border: 0; background: #ffffff1a; color: #fff; width: 32px; height: 32px; border-radius: 10px; display: grid; place-items: center; }
.icon-btn:hover { background: #ffffff2e; }
.thread { flex: 1; overflow-y: auto; padding: 14px 12px 8px; display: flex; flex-direction: column; gap: 4px; scroll-behavior: smooth; }
.day { align-self: center; margin: 6px 0 8px; padding: 4px 12px; border-radius: 10px; background: var(--chip); color: var(--muted); font-size: 12px; font-weight: 600; box-shadow: 0 1px 1px rgba(16,28,38,.06); }
.empty { margin: auto; max-width: 300px; color: var(--muted); font-size: 13.5px; text-align: center; background: var(--chip); padding: 12px 14px; border-radius: 14px; }
.msg { max-width: 86%; display: flex; flex-direction: column; animation: pop .16s ease-out; }
.msg.in { align-self: flex-end; }
.msg.out { align-self: flex-start; }
.msg + .msg.in, .msg + .msg.out { margin-top: 2px; }
.msg.out + .msg.in, .msg.in + .msg.out { margin-top: 8px; }
@keyframes pop { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.bubble { position: relative; padding: 7px 10px 5px; border-radius: 14px; box-shadow: 0 1px 1.5px rgba(16,28,38,.12); overflow-wrap: anywhere; }
.in .bubble { background: var(--rep); border-bottom-right-radius: 4px; }
.out .bubble { background: var(--bot); border-bottom-left-radius: 4px; }
.has-buttons .bubble { border-bottom-left-radius: 4px; border-bottom-right-radius: 4px; }
.fwdlabel { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12.5px; font-style: italic; margin-bottom: 2px; }
.quote { border-left: 3px solid var(--accent); background: #10202c0d; border-radius: 6px; padding: 4px 8px; margin-bottom: 5px; font-size: 13px; color: var(--muted); max-height: 3.3em; overflow: hidden; }
.body { white-space: pre-wrap; }
.body code { font: 13.5px/1.3 "Cascadia Mono", Consolas, "SF Mono", Menlo, monospace; background: #10202c12; padding: 1px 5px; border-radius: 5px; }
.body pre { margin: 4px 0; font: 13px/1.35 "Cascadia Mono", Consolas, Menlo, monospace; background: #10202c0f; padding: 6px 8px; border-radius: 8px; white-space: pre-wrap; }
.header-text { font-weight: 650; margin-bottom: 3px; }
.footer { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
.media { margin: -3px -6px 5px; }
.media img, .media video { display: block; width: 100%; max-height: 330px; object-fit: cover; border-radius: 10px; background: #dfe6eb; cursor: zoom-in; }
.media video { cursor: auto; object-fit: contain; background: #000; }
.media audio { display: block; width: 250px; max-width: 100%; margin: 3px 6px; }
.doc { display: flex; align-items: center; gap: 10px; margin: 0 -2px 5px; padding: 9px 10px; border-radius: 10px; background: #10202c0b; color: inherit; text-decoration: none; }
.doc:hover { background: #10202c14; }
.doc .badge { flex: none; width: 36px; height: 42px; border-radius: 6px; background: #c9493a; color: #fff; display: grid; place-items: center; font-size: 10.5px; font-weight: 800; letter-spacing: .03em; text-transform: uppercase; }
.doc .badge.video { background: #5a4fcf; } .doc .badge.audio { background: #b7791f; } .doc .badge.image { background: #2b6cb0; }
.doc .meta-col { min-width: 0; }
.doc .fname { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 250px; }
.doc .size { color: var(--muted); font-size: 12px; }
.tag { color: var(--muted); font-size: 12px; margin: 0 6px; }
.meta { display: flex; justify-content: flex-end; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); margin-top: 2px; float: right; margin-left: 10px; position: relative; top: 4px; }
.body + .meta, .meta.solo { float: none; top: 0; margin-left: 0; }
.meta .reply { border: 0; background: none; color: var(--muted); padding: 0 2px; font-size: 11.5px; opacity: 0; transition: opacity .12s; }
.bubble:hover .meta .reply { opacity: 1; }
.ticks { display: inline-flex; color: #8a99a5; } .ticks.read { color: var(--read); }
.failed { color: var(--danger); font-weight: 700; }
.buttons { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.buttons button { display: flex; align-items: center; justify-content: center; gap: 6px; background: var(--bot); color: var(--accent); border: 0; padding: 9px 10px; font-weight: 600; font-size: 15px; box-shadow: 0 1px 1.5px rgba(16,28,38,.12); }
.buttons button:last-child { border-radius: 0 0 14px 14px; }
.buttons button:first-child { border-top-left-radius: 4px; border-top-right-radius: 4px; }
.buttons button:hover { background: #f2f7f7; }
.buttons button:disabled { cursor: wait; opacity: .7; }
.buttons button.chosen { color: #fff; background: var(--accent); }
.buttons.answered button:not(.chosen) { color: #93a3ae; }
.typing-row { align-self: flex-start; display: flex; gap: 4px; padding: 11px 13px; border-radius: 14px; border-bottom-left-radius: 4px; background: var(--bot); box-shadow: 0 1px 1.5px rgba(16,28,38,.12); margin-top: 6px; }
.typing-row i { width: 7px; height: 7px; border-radius: 50%; background: #9aa9b4; animation: blink 1.2s infinite ease-in-out; }
.typing-row i:nth-child(2) { animation-delay: .15s; } .typing-row i:nth-child(3) { animation-delay: .3s; }
@keyframes blink { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
.composer { background: #f3f6f8; padding: 8px 10px 10px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.bar { display: flex; align-items: center; gap: 8px; background: #fff; border-radius: 12px; padding: 7px 10px; font-size: 13px; box-shadow: 0 1px 1px rgba(16,28,38,.06); }
.bar-quote { flex: 1; min-width: 0; border-left: 3px solid var(--accent); padding-left: 8px; display: flex; flex-direction: column; }
.bar-quote span, .bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.bar-name { flex: 1; min-width: 0; color: var(--ink); }
.file-ico { color: var(--accent); display: grid; }
.toggle { white-space: nowrap; color: var(--muted); display: flex; align-items: center; gap: 3px; }
.x { border: 0; background: none; color: var(--muted); padding: 2px; display: grid; }
.error { color: var(--danger); font-size: 13px; background: #fbe9e6; border-radius: 10px; padding: 6px 10px; }
.row { display: flex; align-items: center; gap: 8px; }
.round { width: 44px; height: 44px; flex: none; border-radius: 50%; display: grid; place-items: center; border: 0; }
.attach { background: #fff; color: var(--muted); cursor: pointer; box-shadow: 0 1px 1px rgba(16,28,38,.08); }
.attach input { display: none; }
.field { flex: 1; min-width: 0; display: flex; align-items: center; background: #fff; border-radius: 22px; padding-right: 8px; box-shadow: 0 1px 1px rgba(16,28,38,.08); }
.text { flex: 1; min-width: 0; border: 0; border-radius: 22px; padding: 11px 14px; font: inherit; background: transparent; outline: none; }
.fwd { display: grid; color: #a3b1bb; cursor: pointer; }
.fwd input { display: none; }
.fwd:has(input:checked) { color: var(--accent); }
.send { background: var(--accent); color: #fff; }
.send:hover { background: var(--accent-ink); }
.send:disabled { opacity: .55; }
.lightbox { position: fixed; inset: 0; background: rgba(8,16,22,.86); display: grid; place-items: center; z-index: 10; cursor: zoom-out; }
.lightbox img { max-width: 94vw; max-height: 94vh; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
`;

const SCRIPT = `
(function () {
  const CFG = JSON.parse(document.getElementById("cfg").textContent);
  const $ = (id) => document.getElementById(id);
  const thread = $("thread"), form = $("composer"), fromInput = $("from"), textInput = $("text");
  const fileInput = $("file"), voiceBox = $("voice"), docBox = $("asdoc"), fwdBox = $("forwarded");
  const entries = new Map();
  let replyTo = null;
  let typingTimer = null;
  const TYPING_MS = 25000; // like the real indicator: dismissed by the next reply or after 25 s

  try { fromInput.value = localStorage.getItem("dockhand.from") || CFG.defaultFrom || ""; } catch { fromInput.value = CFG.defaultFrom || ""; }
  fromInput.addEventListener("change", () => { try { localStorage.setItem("dockhand.from", fromInput.value.trim()); } catch {} });
  const idleStatus = () => "business account \\u00b7 +" + CFG.business;
  $("status").textContent = idleStatus();

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function svg(markup) { const t = document.createElement("template"); t.innerHTML = markup; return t.content.firstChild; }
  const TICKS = '<svg viewBox="0 0 18 12" width="17" height="11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 6.5 4.2 9.6 11 2.5"/><path d="M7.5 9.6 8.4 10.4 16.8 2.5"/></svg>';
  const mediaUrl = (id) => CFG.base + "/media/" + encodeURIComponent(id);
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function size(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }
  function snippet(entry) {
    if (!entry) return "message";
    if (entry.text) return entry.text.replace(/[*_~\\x60]/g, "");
    if (entry.caption) return entry.caption.replace(/[*_~\\x60]/g, "");
    if (entry.media && entry.media.filename) return entry.media.filename;
    return entry.type === "audio" ? "Voice message" : entry.type === "image" ? "Photo" : entry.type;
  }

  // WhatsApp formatting: \\x60\\x60\\x60block\\x60\\x60\\x60, \\x60code\\x60, *bold*, _italic_, ~strike~. Built as nodes, never HTML.
  function formatted(text) {
    const out = document.createDocumentFragment();
    const blocks = text.split(/\\x60\\x60\\x60/);
    blocks.forEach((part, i) => {
      if (i % 2 === 1) { out.append(el("pre", "", part)); return; }
      inline(part, out);
    });
    return out;
  }
  function inline(text, parent) {
    const re = /\\x60([^\\x60\\n]+)\\x60|\\*([^*\\n]+)\\*|_([^_\\n]+)_|~([^~\\n]+)~/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      const before = text[m.index - 1], after = text[m.index + m[0].length];
      const wordy = (c) => c !== undefined && /[\\p{L}\\p{N}]/u.test(c);
      if (!m[1] && (wordy(before) || wordy(after))) continue; // snake_case and 2*3 stay plain
      parent.append(text.slice(last, m.index));
      if (m[1] !== undefined) parent.append(el("code", "", m[1]));
      else if (m[2] !== undefined) parent.append(el("strong", "", m[2]));
      else if (m[3] !== undefined) parent.append(el("em", "", m[3]));
      else parent.append(el("s", "", m[4]));
      last = m.index + m[0].length;
    }
    parent.append(text.slice(last));
  }

  function zoom(src) {
    const box = $("lightbox");
    box.querySelector("img").src = src;
    box.hidden = false;
  }
  $("lightbox").addEventListener("click", () => { $("lightbox").hidden = true; });

  function renderMedia(entry, box) {
    const m = entry.media;
    if (!m) return;
    if (entry.type === "image") {
      const wrap = el("div", "media");
      const img = el("img");
      img.src = mediaUrl(m.id);
      img.alt = entry.caption ? snippet(entry) : "photo";
      img.addEventListener("click", () => zoom(img.src));
      wrap.append(img);
      box.append(wrap);
    } else if (entry.type === "audio") {
      const wrap = el("div", "media");
      const audio = el("audio");
      audio.controls = true;
      audio.src = mediaUrl(m.id);
      wrap.append(audio, el("div", "tag", m.voice ? "Voice note" : "Audio"));
      box.append(wrap);
    } else if (entry.type === "video") {
      const wrap = el("div", "media");
      const video = el("video");
      video.controls = true;
      video.preload = "metadata";
      video.src = mediaUrl(m.id);
      wrap.append(video);
      box.append(wrap);
    } else {
      const doc = el("a", "doc");
      doc.href = mediaUrl(m.id);
      doc.target = "_blank";
      const name = m.filename || "document";
      const ext = name.includes(".") ? name.split(".").pop() : "file";
      const kind = (m.mime || "").split("/")[0];
      const badge = el("span", "badge " + (["video", "audio", "image"].includes(kind) ? kind : ""), ext.slice(0, 4));
      const col = el("span", "meta-col");
      col.append(el("div", "fname", name), el("div", "size", size(m.bytes) + " \\u00b7 " + (ext || "").toUpperCase()));
      doc.append(badge, col);
      box.append(doc);
    }
  }

  function chosenTitle(card) {
    for (const e of entries.values()) if (e.type === "button_reply" && e.replyTo === card.waId) return e.text;
    return null;
  }

  function render(entry) {
    const row = el("div", "msg " + entry.dir);
    row.dataset.wa = entry.waId;
    row.dataset.dir = entry.dir;
    row.dataset.type = entry.type;
    const bubble = el("div", "bubble");
    if (entry.forwarded) {
      const f = el("div", "fwdlabel");
      f.append(svg('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 5 6 6-6 6"/><path d="M21 11H9a6 6 0 0 0-6 6v2"/></svg>'), "Forwarded");
      bubble.append(f);
    }
    if (entry.replyTo && entry.type !== "button_reply") bubble.append(el("div", "quote", snippet(entries.get(entry.replyTo))));
    if (entry.header && entry.header.type === "image") {
      renderMedia({ type: "image", media: { id: entry.header.mediaId }, caption: "" }, bubble);
    }
    if (entry.header && entry.header.type === "text") bubble.append(el("div", "header-text", entry.header.text));
    renderMedia(entry, bubble);
    const words = entry.type === "button_reply" ? entry.text : entry.text || entry.caption;
    if (words) {
      const body = el("div", "body");
      body.append(formatted(words));
      bubble.append(body);
    }
    if (entry.footer) bubble.append(el("div", "footer", entry.footer));
    const meta = el("div", "meta" + (words ? "" : " solo"));
    const reply = el("button", "reply", "reply");
    reply.type = "button";
    reply.addEventListener("click", () => setReply(entry));
    meta.append(reply, el("span", "", time(entry.ts)));
    if (entry.dir === "in") {
      const ticks = svg(TICKS);
      const wrap = el("span", "ticks" + (entry.read ? " read" : ""));
      wrap.title = entry.read ? "Read" : "Delivered";
      wrap.append(ticks);
      meta.append(wrap);
    }
    if (entry.failed) {
      const failed = el("span", "failed", "!");
      failed.title = "Not delivered: " + entry.failed;
      meta.append(failed);
    }
    bubble.append(meta);
    row.append(bubble);
    if (entry.type === "interactive" && entry.buttons) {
      row.classList.add("has-buttons");
      const chosen = chosenTitle(entry);
      const buttons = el("div", "buttons" + (chosen ? " answered" : ""));
      for (const b of entry.buttons) {
        const button = el("button", chosen === b.title ? "chosen" : "", b.title);
        button.type = "button";
        button.dataset.buttonId = b.id;
        button.addEventListener("click", () => tap(entry, b, button));
        buttons.append(button);
      }
      row.append(buttons);
    }
    return row;
  }

  let lastDay = null;
  function dayLabel(ts) {
    const d = new Date(ts), today = new Date();
    return d.toDateString() === today.toDateString() ? "Today" : d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }
  function showEmpty() {
    if (!thread.querySelector(".msg")) {
      lastDay = null;
      thread.replaceChildren(el("div", "empty", "No messages yet. As the rep, send a text, a voice note (OGG), a photo, a PDF or an MP4 screen recording."));
    }
  }
  function typing(on) {
    clearTimeout(typingTimer);
    let dots = $("typing");
    if (!on) {
      if (dots) dots.remove();
      $("status").textContent = idleStatus();
      $("status").classList.remove("typing");
      return;
    }
    if (!dots) {
      dots = el("div", "typing-row");
      dots.id = "typing";
      dots.append(el("i"), el("i"), el("i"));
    }
    thread.append(dots);
    $("status").textContent = "typing\\u2026";
    $("status").classList.add("typing");
    thread.scrollTop = thread.scrollHeight;
    typingTimer = setTimeout(() => typing(false), TYPING_MS);
  }
  function append(entry, live) {
    entries.set(entry.waId, entry);
    const empty = thread.querySelector(".empty");
    if (empty) empty.remove();
    const day = dayLabel(entry.ts);
    if (day !== lastDay) { thread.insertBefore(el("div", "day", day), $("typing")); lastDay = day; }
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
    thread.insertBefore(render(entry), $("typing"));
    if (entry.type === "button_reply" && entry.replyTo) refresh(entry.replyTo);
    if (live) typing(entry.dir === "in");
    if (nearBottom || entry.dir === "in" || live) thread.scrollTop = thread.scrollHeight;
  }
  function refresh(waId) {
    const entry = entries.get(waId);
    const old = entry && thread.querySelector('[data-wa="' + CSS.escape(waId) + '"]');
    if (old) old.replaceWith(render(entry));
  }
  function update(entry) {
    entries.set(entry.waId, entry);
    refresh(entry.waId);
  }

  function showError(message) {
    const box = $("error");
    box.textContent = message || "";
    box.hidden = !message;
  }
  function from() {
    const value = fromInput.value.trim().replace(/^\\+/, "");
    if (!/^\\d{6,15}$/.test(value)) {
      showError("Set your number (You) first: E.164 digits, e.g. 5511999990000.");
      fromInput.focus();
      return null;
    }
    return value;
  }
  function setReply(entry) {
    replyTo = entry ? entry.waId : null;
    $("replybar").hidden = !entry;
    $("replytext").textContent = entry ? snippet(entry) : "";
    if (entry) textInput.focus();
  }
  function syncFileBar() {
    const file = fileInput.files && fileInput.files[0];
    $("filebar").hidden = !file;
    if (!file) return;
    $("filename").textContent = file.name + " \\u00b7 " + size(file.size);
    const audio = (file.type || "").startsWith("audio/") || /\\.(ogg|opus)$/i.test(file.name);
    $("voicewrap").hidden = !audio;
    voiceBox.checked = audio;
    docBox.checked = false;
  }
  fileInput.addEventListener("change", syncFileBar);
  $("fileclear").addEventListener("click", () => { fileInput.value = ""; syncFileBar(); });
  $("replyclear").addEventListener("click", () => setReply(null));

  async function post(path, body) {
    const res = await fetch(CFG.base + path, body instanceof FormData
      ? { method: "POST", body }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sender = from();
    if (!sender) return;
    const data = new FormData(form);
    data.set("from", sender);
    if (replyTo) data.set("replyTo", replyTo);
    if (!fileInput.files || !fileInput.files[0]) data.delete("file");
    if (!String(data.get("text") || "").trim() && !data.get("file")) return;
    const send = $("send");
    send.disabled = true;
    try {
      await post("/send", data);
      showError("");
      textInput.value = "";
      fileInput.value = "";
      fwdBox.checked = false;
      syncFileBar();
      setReply(null);
    } catch (err) {
      showError(err.message);
    } finally {
      send.disabled = false;
      textInput.focus();
    }
  });

  async function tap(entry, button, node) {
    const sender = from();
    if (!sender) return;
    node.disabled = true;
    try {
      await post("/tap", { from: sender, waId: entry.waId, buttonId: button.id });
      showError("");
    } catch (err) {
      showError(err.message);
    } finally {
      node.disabled = false;
    }
  }

  $("reset").addEventListener("click", async () => {
    if (!confirm("Clear all emulator messages and media?")) return;
    try { await post("/reset", {}); } catch (err) { showError(err.message); }
  });

  const events = new EventSource(CFG.base + "/events");
  events.addEventListener("snapshot", (e) => {
    entries.clear();
    lastDay = null;
    thread.replaceChildren();
    typing(false);
    JSON.parse(e.data).entries.forEach((entry) => append(entry, false));
    showEmpty();
    thread.scrollTop = thread.scrollHeight;
  });
  events.addEventListener("entry", (e) => append(JSON.parse(e.data), true));
  events.addEventListener("update", (e) => update(JSON.parse(e.data)));
  events.onerror = () => { $("status").textContent = "reconnecting\\u2026"; };
  events.onopen = () => { if (!$("typing")) $("status").textContent = idleStatus(); };
})();
`;
