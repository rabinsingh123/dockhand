// The emulator's /dev/chat page: a phone-sized WhatsApp-like thread for driving Dockhand locally.
// Plain HTML/CSS/JS from strings (a dev tool, not product UI). All text is rendered with textContent.

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
    <div class="who">
      <div class="avatar">D</div>
      <div>
        <div class="name">Dockhand</div>
        <div class="sub" id="status">WhatsApp emulator</div>
      </div>
    </div>
    <div class="controls">
      <label class="from">You <input id="from" inputmode="numeric" autocomplete="off" placeholder="5511999990000"></label>
      <button type="button" id="reset" class="ghost" title="Clear the emulator's messages and media">Reset</button>
    </div>
  </header>
  <section id="thread" class="thread" aria-live="polite"></section>
  <form id="composer" class="composer">
    <div id="replybar" class="bar" hidden>
      <span>Replying to <b id="replytext"></b></span>
      <button type="button" id="replyclear" class="x" aria-label="Cancel reply">x</button>
    </div>
    <div id="filebar" class="bar" hidden>
      <span id="filename"></span>
      <label id="voicewrap"><input type="checkbox" name="voice" id="voice"> voice note</label>
      <label><input type="checkbox" name="asDocument" id="asdoc"> send as document</label>
      <button type="button" id="fileclear" class="x" aria-label="Remove file">x</button>
    </div>
    <div id="error" class="error" role="alert" hidden></div>
    <div class="row">
      <label class="attach" title="Attach a voice note (OGG), image, PDF or MP4">
        +<input type="file" id="file" name="file" accept="audio/*,.ogg,.opus,image/jpeg,image/png,application/pdf,video/mp4">
      </label>
      <label class="fwd" title="Mark as forwarded"><input type="checkbox" name="forwarded" id="forwarded"> fwd</label>
      <input id="text" name="text" class="text" autocomplete="off" placeholder="Message">
      <button type="submit" id="send" class="send">Send</button>
    </div>
  </form>
</main>
<script id="cfg" type="application/json">${config}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const CSS = `
:root { --bg:#efeae2; --in:#d9fdd3; --out:#ffffff; --ink:#111b21; --muted:#667781; --accent:#008069; --link:#027eb5; --line:#d1d7db; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: #d1d7db; font: 15px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--ink); }
.phone { max-width: 430px; height: 100vh; margin: 0 auto; display: flex; flex-direction: column; background: var(--bg); }
@media (min-width: 600px) { .phone { height: calc(100vh - 32px); margin: 16px auto; border-radius: 18px; overflow: hidden; box-shadow: 0 8px 30px rgba(0,0,0,.18); } }
.top { background: var(--accent); color: #fff; padding: 10px 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.who > div { min-width: 0; }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: #fff; color: var(--accent); display: grid; place-items: center; font-weight: 700; flex: none; }
.name { font-weight: 600; }
.sub { font-size: 12px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.controls { display: flex; align-items: center; gap: 6px; flex: none; }
.from { font-size: 12px; display: flex; align-items: center; gap: 4px; }
.from input { width: 128px; border: 0; border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 13px; }
button { font: inherit; cursor: pointer; }
.ghost { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.6); border-radius: 6px; padding: 3px 8px; font-size: 12px; }
.thread { flex: 1; overflow-y: auto; padding: 12px 10px 6px; display: flex; flex-direction: column; gap: 6px; }
.empty { margin: auto; color: var(--muted); font-size: 13px; text-align: center; background: rgba(255,255,255,.7); padding: 8px 12px; border-radius: 8px; }
.msg { max-width: 85%; display: flex; flex-direction: column; }
.msg.in { align-self: flex-end; }
.msg.out { align-self: flex-start; }
.bubble { position: relative; padding: 6px 8px 4px; border-radius: 8px; box-shadow: 0 1px .5px rgba(0,0,0,.13); word-wrap: break-word; }
.in .bubble { background: var(--in); border-top-right-radius: 2px; }
.out .bubble { background: var(--out); border-top-left-radius: 2px; }
.fwdlabel { color: var(--muted); font-size: 12px; font-style: italic; }
.quote { border-left: 3px solid var(--accent); background: rgba(0,0,0,.05); border-radius: 4px; padding: 3px 6px; margin-bottom: 4px; font-size: 13px; color: var(--muted); max-height: 3.2em; overflow: hidden; }
.body { white-space: pre-wrap; }
.header-text { font-weight: 600; margin-bottom: 2px; }
.footer { color: var(--muted); font-size: 12px; margin-top: 2px; }
.media img, .media video { display: block; max-width: 100%; max-height: 320px; border-radius: 6px; margin-bottom: 4px; }
.media audio { display: block; width: 240px; max-width: 100%; margin-bottom: 2px; }
.chip { display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,.05); border-radius: 6px; padding: 6px 8px; margin-bottom: 4px; color: inherit; text-decoration: none; }
.chip .ext { background: #e2533b; color: #fff; font-size: 10px; font-weight: 700; border-radius: 3px; padding: 2px 4px; text-transform: uppercase; }
.chip .fname { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.chip .size { color: var(--muted); font-size: 12px; }
.tag { color: var(--muted); font-size: 12px; }
.meta { display: flex; justify-content: flex-end; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); margin-top: 2px; }
.meta .reply { border: 0; background: none; color: var(--link); padding: 0; font-size: 11px; }
.meta .read { color: #53bdeb; font-weight: 600; }
.meta .failed { color: #d93025; font-weight: 600; }
.buttons { display: flex; flex-direction: column; gap: 3px; margin-top: 3px; }
.buttons button { background: var(--out); color: var(--link); border: 0; border-radius: 8px; padding: 8px; box-shadow: 0 1px .5px rgba(0,0,0,.13); font-weight: 500; }
.buttons button:hover { background: #f5f6f6; }
.buttons button:disabled { color: var(--muted); cursor: wait; }
.composer { background: #f0f2f5; padding: 6px 8px 8px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 5px; }
.bar { display: flex; align-items: center; gap: 10px; background: #fff; border-radius: 8px; padding: 5px 8px; font-size: 13px; }
.bar span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar label { white-space: nowrap; color: var(--muted); }
.x { border: 0; background: none; color: var(--muted); font-size: 15px; padding: 0 4px; }
.error { color: #d93025; font-size: 13px; background: #fde8e7; border-radius: 6px; padding: 4px 8px; }
.row { display: flex; align-items: center; gap: 6px; }
.attach { width: 34px; height: 34px; border-radius: 50%; background: #fff; display: grid; place-items: center; font-size: 22px; color: var(--muted); cursor: pointer; flex: none; }
.attach input { display: none; }
.fwd { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 2px; flex: none; }
.text { flex: 1; min-width: 0; border: 0; border-radius: 18px; padding: 9px 12px; font: inherit; }
.send { border: 0; border-radius: 18px; background: var(--accent); color: #fff; padding: 8px 14px; font-weight: 600; flex: none; }
.send:disabled { opacity: .6; }
`;

const SCRIPT = `
(function () {
  const CFG = JSON.parse(document.getElementById("cfg").textContent);
  const $ = (id) => document.getElementById(id);
  const thread = $("thread"), form = $("composer"), fromInput = $("from"), textInput = $("text");
  const fileInput = $("file"), voiceBox = $("voice"), docBox = $("asdoc"), fwdBox = $("forwarded");
  const entries = new Map();
  let replyTo = null;

  fromInput.value = localStorage.getItem("dockhand.from") || CFG.defaultFrom || "";
  fromInput.addEventListener("change", () => localStorage.setItem("dockhand.from", fromInput.value.trim()));
  $("status").textContent = "WhatsApp emulator \\u00b7 business +" + CFG.business;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  const mediaUrl = (id) => CFG.base + "/media/" + encodeURIComponent(id);
  const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  function size(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }
  function snippet(entry) {
    if (!entry) return "message";
    if (entry.text) return entry.text;
    if (entry.caption) return entry.caption;
    if (entry.media && entry.media.filename) return entry.media.filename;
    return entry.type === "audio" ? "Voice message" : entry.type;
  }

  function renderMedia(entry, box) {
    const m = entry.media;
    if (!m) return;
    const wrap = el("div", "media");
    if (entry.type === "image") {
      const img = el("img");
      img.src = mediaUrl(m.id);
      img.alt = entry.caption || "image";
      img.addEventListener("click", () => window.open(img.src, "_blank"));
      wrap.append(img);
    } else if (entry.type === "audio") {
      const audio = el("audio");
      audio.controls = true;
      audio.src = mediaUrl(m.id);
      wrap.append(audio, el("div", "tag", m.voice ? "Voice note" : "Audio \\u00b7 " + m.mime));
    } else if (entry.type === "video") {
      const video = el("video");
      video.controls = true;
      video.src = mediaUrl(m.id);
      wrap.append(video);
    } else {
      const chip = el("a", "chip");
      chip.href = mediaUrl(m.id);
      chip.target = "_blank";
      const name = m.filename || "document";
      const ext = name.includes(".") ? name.split(".").pop() : "file";
      chip.append(el("span", "ext", ext), el("span", "fname", name), el("span", "size", size(m.bytes)));
      wrap.append(chip);
    }
    box.append(wrap);
  }

  function render(entry) {
    const row = el("div", "msg " + entry.dir);
    row.dataset.wa = entry.waId;
    const bubble = el("div", "bubble");
    if (entry.forwarded) bubble.append(el("div", "fwdlabel", "Forwarded"));
    if (entry.replyTo) bubble.append(el("div", "quote", snippet(entries.get(entry.replyTo))));
    if (entry.header && entry.header.type === "image") renderMedia({ type: "image", media: { id: entry.header.mediaId }, caption: "header" }, bubble);
    if (entry.header && entry.header.type === "text") bubble.append(el("div", "header-text", entry.header.text));
    renderMedia(entry, bubble);
    const words = entry.type === "button_reply" ? entry.text : entry.text || entry.caption;
    if (words) bubble.append(el("div", "body", words));
    if (entry.footer) bubble.append(el("div", "footer", entry.footer));
    const meta = el("div", "meta");
    const reply = el("button", "reply", "reply");
    reply.type = "button";
    reply.addEventListener("click", () => setReply(entry));
    meta.append(reply, el("span", "", time(entry.ts)));
    if (entry.dir === "in" && entry.read) meta.append(el("span", "read", "read"));
    if (entry.failed) {
      const failed = el("span", "failed", "not delivered");
      failed.title = entry.failed;
      meta.append(failed);
    }
    bubble.append(meta);
    row.append(bubble);
    if (entry.type === "interactive" && entry.buttons) {
      const buttons = el("div", "buttons");
      for (const b of entry.buttons) {
        const button = el("button", "", b.title);
        button.type = "button";
        button.dataset.buttonId = b.id;
        button.addEventListener("click", () => tap(entry, b, button));
        buttons.append(button);
      }
      row.append(buttons);
    }
    return row;
  }

  function showEmpty() {
    if (!thread.querySelector(".msg")) {
      thread.replaceChildren(el("div", "empty", "No messages yet. Send a text, voice note (OGG), photo, PDF or MP4 as the rep."));
    }
  }
  function append(entry) {
    entries.set(entry.waId, entry);
    const empty = thread.querySelector(".empty");
    if (empty) empty.remove();
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
    thread.append(render(entry));
    if (nearBottom || entry.dir === "in") thread.scrollTop = thread.scrollHeight;
  }
  function update(entry) {
    entries.set(entry.waId, entry);
    const old = thread.querySelector('[data-wa="' + CSS.escape(entry.waId) + '"]');
    if (old) old.replaceWith(render(entry));
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
    $("filename").textContent = file.name + " (" + size(file.size) + ")";
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
    if (!data.get("text") && !data.get("file")) return;
    const send = form.querySelector(".send");
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
    thread.replaceChildren();
    JSON.parse(e.data).entries.forEach(append);
    showEmpty();
    $("status").textContent = "WhatsApp emulator \\u00b7 business +" + CFG.business;
  });
  events.addEventListener("entry", (e) => append(JSON.parse(e.data)));
  events.addEventListener("update", (e) => update(JSON.parse(e.data)));
  events.onerror = () => { $("status").textContent = "reconnecting..."; };
})();
`;
