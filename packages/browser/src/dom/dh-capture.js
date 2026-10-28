// biome-ignore-all lint: in-page script; the first part is the capture code tested in docs/reviews/computer-use-review.md 1.4, kept verbatim.
// biome-ignore-all format: kept byte-for-byte with the tested snippet.
// dh-capture.js. Exposes window.__dh.{describeAt, viewMap, describeActive, fingerprintOf, formState}.
(() => {
  if (window.__dh) return;
  const ROLES = 'button link checkbox radio switch tab menuitem menuitemcheckbox menuitemradio option combobox textbox searchbox spinbutton slider treeitem gridcell'.split(' ');
  const INTERACTIVE = ['button', 'a[href]', 'input:not([type=hidden])', 'select', 'textarea', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]', ...ROLES.map(r => `[role="${r}"]`)].join(',');
  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
  // Heuristic: ids/classes/names a build or a render can regenerate. Never used as anchors.
  const generated = s => !!s && (/^(:r[0-9a-z]+:|«r[0-9a-z]+»)$/i.test(s) ||
    /^(mui|radix|headlessui|react-select|downshift|rc-|ember|ext-gen|css-|sc-|jsx-)/i.test(s) ||
    /\d{3,}/.test(s) || /(^|[-_])(?=[0-9a-z]*\d[0-9a-z]*\d)[0-9a-z]{5,}$/i.test(s) || /__[0-9a-z]{5}$/i.test(s));
  const uids = new WeakMap(); let seq = 0;
  const uid = el => { if (!uids.has(el)) uids.set(el, ++seq); return uids.get(el); };

  // 1) Hit-test exactly what a real click at (x, y) hits (descends open shadow roots).
  function hit(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  // 2) Climb to the element that owns the interaction.
  function owner(el) {
    for (let n = el, d = 0; n && n !== document.body && d < 10; n = n.parentElement, d++) {
      if (n.tagName === 'LABEL') return n.control || n;          // a label click activates its control
      if (n.matches(INTERACTIVE)) return n;
    }
    let n = el;                                                   // div-with-onClick: topmost cursor:pointer ancestor
    if (getComputedStyle(n).cursor === 'pointer')
      while (n.parentElement && n.parentElement !== document.body &&
             getComputedStyle(n.parentElement).cursor === 'pointer') n = n.parentElement;
    return n;
  }
  function role(el) {
    const r = el.getAttribute('role');
    if (r) return r.trim().split(/\s+/)[0];
    const t = el.tagName.toLowerCase(), type = (el.getAttribute('type') || 'text').toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : '';
    if (t === 'button') return 'button';
    if (t === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      if (el.list) return 'combobox';
      return { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
               button: 'button', submit: 'button', reset: 'button', image: 'button', file: 'button' }[type] || 'textbox';
    }
    return '';
  }
  const textOf = n => { const c = n.cloneNode(true); c.querySelectorAll('input,select,textarea').forEach(x => x.remove()); return norm(c.textContent); };
  // Approximate accessible name. Node side re-checks every candidate with Playwright's own engine.
  function name(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) return norm(ids.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
    const aria = norm(el.getAttribute('aria-label')); if (aria) return aria;
    if (el.labels && el.labels.length) return norm([...el.labels].map(textOf).join(' '));
    if (el.matches('input[type=submit],input[type=button],input[type=reset]')) return norm(el.value);
    if (['button', 'link', 'option', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'treeitem', 'gridcell'].includes(role(el)))
      return norm(el.innerText);
    return norm(el.getAttribute('title') || el.getAttribute('placeholder'));
  }
  function section(el) {                                          // nearest named container, for scoping duplicates
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'FIELDSET') { const lg = n.querySelector(':scope > legend'); if (lg) return { role: 'group', name: norm(lg.textContent) }; }
      const r = n.getAttribute('role') || { FORM: 'form', DIALOG: 'dialog', SECTION: 'region' }[n.tagName];
      if (['group', 'region', 'dialog', 'form', 'tabpanel'].includes(r)) { const nm = name(n); if (nm) return { role: r, name: nm }; }
    }
    return null;
  }
  function heading(el) {                                          // nearest preceding heading in document order
    let best = '';
    for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'))
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = norm(h.textContent);
    return best;
  }
  function cssPath(el) {                                          // shortest unique path, anchored on stable id/name
    const parts = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.id && !generated(n.id)) parts.unshift('#' + CSS.escape(n.id));
      else {
        const nm = n.getAttribute('name'), sib = n.parentElement ? [...n.parentElement.children].filter(s => s.tagName === n.tagName) : [];
        parts.unshift(n.tagName.toLowerCase() + (nm && !generated(nm) ? `[name="${CSS.escape(nm)}"]`
          : sib.length > 1 ? `:nth-of-type(${sib.indexOf(n) + 1})` : ''));
      }
      const css = parts.join(' > ');
      if (document.querySelectorAll(css).length === 1) return { css, positional: css.includes(':nth-of-type(') };
    }
    return { css: parts.join(' > '), positional: true };
  }
  function candidates(el) {
    const out = [], r = role(el), n = name(el), sec = section(el);
    const tid = el.getAttribute('data-testid');
    if (tid && !generated(tid)) out.push({ kind: 'testid', value: tid });
    if (r && n) out.push({ kind: 'role', role: r, name: n });
    if (el.labels && el.labels.length) out.push({ kind: 'label', text: textOf(el.labels[0]) });
    const ph = norm(el.getAttribute('placeholder')); if (ph) out.push({ kind: 'placeholder', text: ph });
    const nm = el.getAttribute('name');
    if (nm && !generated(nm)) out.push({ kind: 'css', css: `${el.tagName.toLowerCase()}[name="${CSS.escape(nm)}"]`, positional: false });
    if (el.id && !generated(el.id)) out.push({ kind: 'css', css: '#' + CSS.escape(el.id), positional: false });
    if (!n) { const t = norm(el.innerText).slice(0, 60); if (t) out.push({ kind: 'text', text: t }); }
    out.push({ kind: 'css', ...cssPath(el) });
    const seen = new Set();                                       // name/id anchors and cssPath can coincide
    return { list: out.filter(c => !seen.has(c.css || JSON.stringify(c)) && seen.add(c.css || JSON.stringify(c))),
             scope: sec };                                        // Node adds the scope only when a candidate is ambiguous
  }
  function state(el) {
    return { value: el.matches('input,select,textarea') ? String(el.value) : null,
             checked: typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked'),
             expanded: el.getAttribute('aria-expanded'), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
             invalid: el.getAttribute('aria-invalid') === 'true' };
  }
  // A control the page never tied to its label (no <label for>, no aria-*, no placeholder; EspoCRM's form cells):
  // the single <label> of the nearest ancestor (up to 4 levels) that holds no other label. It fills only the
  // fingerprint and the snapshot key, never a candidate (Playwright would not resolve it by label).
  function visualLabel(el) {
    if ((el.labels && el.labels.length) || name(el)) return '';
    for (let n = el.parentElement, d = 0; n && n !== document.body && d < 4; n = n.parentElement, d++) {
      const labels = n.querySelectorAll('label');
      if (labels.length > 1) return '';
      if (labels.length === 1) return labels[0].control && labels[0].control !== el ? '' : textOf(labels[0]);
    }
    return '';
  }
  function fingerprint(el) {
    const b = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', role: role(el), name: name(el),
      label: el.labels && el.labels.length ? textOf(el.labels[0]) : visualLabel(el), placeholder: norm(el.getAttribute('placeholder')),
      nameAttr: el.getAttribute('name') || '', id: generated(el.id) ? '' : el.id, testid: el.getAttribute('data-testid') || '',
      text: norm(el.innerText).slice(0, 80), section: section(el)?.name || '', heading: heading(el),
      classes: [...el.classList].filter(c => !generated(c)).slice(0, 6),
      box: { x: Math.round(b.x + scrollX), y: Math.round(b.y + scrollY), w: Math.round(b.width), h: Math.round(b.height) },
      ordinal: [...(el.form || document).querySelectorAll(INTERACTIVE)].indexOf(el) };
  }
  function describe(el, h) {
    window.__dh.last = el;                                        // Node grabs it with evaluateHandle for identity checks
    return { uid: uid(el), interactive: el.matches(INTERACTIVE), hitTag: h ? h.tagName.toLowerCase() : null,
             viaLabel: !!(h && h !== el && h.closest('label')),
             candidates: candidates(el), fingerprint: fingerprint(el), state: state(el) };
  }
  window.__dh = {
    describeAt(x, y) { const h = hit(x, y); return h ? describe(owner(h), h) : null; },
    viewMap() {                                                   // taken with every screenshot: what the model saw, where
      const out = [];
      for (const el of document.querySelectorAll(INTERACTIVE + ',label')) {
        const b = el.getBoundingClientRect();
        if (b.width < 1 || b.height < 1 || b.bottom <= 0 || b.right <= 0 || b.top >= innerHeight || b.left >= innerWidth) continue;
        const o = el.tagName === 'LABEL' ? el.control : el;
        if (!o) continue;
        const top = hit(Math.min(b.x + b.width / 2, innerWidth - 1), Math.min(b.y + b.height / 2, innerHeight - 1));
        if (!top || !(top === el || el.contains(top) || top === o)) continue;   // centre covered by something else
        out.push({ uid: uid(o), x: b.x, y: b.y, w: b.width, h: b.height, role: role(o), name: name(o) });
      }
      return out;
    },
    describeActive() {
      let a = document.activeElement;
      while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
      return a && a !== document.body ? describe(a, null) : null;
    },
    fingerprintOf: el => fingerprint(el),                         // runner: sanity-check whatever a locator resolved to
    formState() {                                                 // value snapshot of every control, keyed by uid
      return [...document.querySelectorAll('input:not([type=hidden]),select,textarea,[role=combobox]')]
        .map(el => ({ uid: uid(el), label: name(el), visible: el.checkVisibility ? el.checkVisibility() : true, ...state(el) }));
    },
  };

  // ---- Dockhand additions (additive only: nothing above is changed) ----
  const bare = s => norm(s).replace(/^[\s*]+|[\s*:]+$/g, '');
  const isVisible = el => (el.checkVisibility ? el.checkVisibility() : el.getClientRects().length > 0);
  const isFile = el => el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file';
  // File inputs are usually visually hidden behind a button: judge them by their container.
  const shown = el => (isFile(el) ? !!el.parentElement && isVisible(el.parentElement) : isVisible(el));
  const BUTTONISH = 'button,input[type=submit],input[type=button],input[type=image],input[type=reset],[role=button]';
  const DEFAULT_BUTTON = 'button:not([type]),button[type=submit],input[type=submit],input[type=image]';
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  };
  function fieldValue(el) {
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return String(el.checked);
      if (type === 'file') return [...(el.files || [])].map(f => f.name).join(', ');
      return String(el.value);
    }
    if (el.tagName === 'SELECT') return [...el.selectedOptions].map(o => norm(o.text)).join(', ');
    if (el.tagName === 'TEXTAREA') return String(el.value);
    const r = role(el);
    if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(r)) return String(el.getAttribute('aria-checked') === 'true');
    if (r === 'combobox') {
      const inner = el.querySelector('input,select,textarea');
      return inner ? fieldValue(inner) : norm(el.getAttribute('aria-valuetext') || el.innerText);
    }
    return norm(el.innerText || el.textContent || '');
  }
  function groupName(el) {
    const g = el.closest('[role=radiogroup],[role=group],fieldset');
    if (!g) return '';
    if (g.tagName === 'FIELDSET' && !g.getAttribute('aria-labelledby') && !g.getAttribute('aria-label')) {
      const lg = g.querySelector(':scope > legend');
      return lg ? bare(textOf(lg)) : '';
    }
    return bare(name(g));
  }
  function groupedCheckbox(el) {
    const g = el.closest('[role=group],fieldset');
    return !!g && g.querySelectorAll('input[type=checkbox],[role=checkbox]').length >= 2;
  }
  // label -> value of every visible control. Radio groups give the chosen option; checkbox groups the ticked options.
  function formSnapshot() {
    const entries = [], groups = new Map();
    const sel = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea,[role=combobox],[role=checkbox],[role=radio],[role=switch],[contenteditable=""],[contenteditable="true"]';
    for (const el of document.querySelectorAll(sel)) {
      const wrapper = el.parentElement && el.parentElement.closest('[role=combobox]');
      if (wrapper && wrapper !== el) continue;                    // reported by its combobox wrapper
      if (!shown(el)) continue;
      const r = role(el);
      if (r === 'radio' || (r === 'checkbox' && groupedCheckbox(el))) {
        const container = el.closest('[role=radiogroup],[role=group],fieldset') || el.form || document.body;
        const key = r === 'radio' && el.getAttribute('name') ? 'n:' + el.getAttribute('name') : container;
        let g = groups.get(key);
        if (!g) {
          g = { key: groupName(el) || el.getAttribute('name') || bare(name(el)), picked: [], el };
          groups.set(key, g); entries.push(g);
        }
        if (fieldValue(el) === 'true') g.picked.push(bare(name(el)));
        continue;
      }
      entries.push({ key: bare(name(el)) || el.getAttribute('name') || el.id || bare(visualLabel(el)) || el.tagName.toLowerCase(), value: fieldValue(el), el });
    }
    const out = {};
    for (const e of entries) {
      let k = e.key || '(unlabelled)';
      if (k in out) {
        const sec = section(e.el), base = sec ? `${k} (${bare(sec.name)})` : k;
        k = base;
        for (let n = 2; k in out; n++) k = `${base} #${n}`;
      }
      out[k] = e.picked ? e.picked.join(', ') : e.value;
    }
    return out;
  }
  function interactiveList() {
    const list = [], out = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (!shown(el)) continue;
      const b = el.getBoundingClientRect();
      if (!isFile(el) && (b.width < 1 || b.height < 1)) continue;
      list.push(el);
      out.push({ index: list.length - 1, uid: uid(el), fingerprint: fingerprint(el), state: state(el), formSubmit: formSubmit(el) });
    }
    window.__dh.list = list;
    return out;
  }
  function submitType(el) {
    if (el.tagName === 'BUTTON') return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit';
    if (el.tagName === 'INPUT') return ['submit', 'image'].includes((el.getAttribute('type') || '').toLowerCase());
    return false;
  }
  function formSubmit(el) {
    const form = el.form || null;
    return !!form && (submitType(el) || form.querySelector(DEFAULT_BUTTON) === el);
  }
  function filledFields() {
    let n = 0;
    for (const e of document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea')) {
      if (!shown(e)) continue;
      const t = (e.getAttribute('type') || '').toLowerCase();
      if (t === 'checkbox' || t === 'radio' ? e.checked : fieldValue(e).trim() !== '') n++;
    }
    return n;
  }
  function commitInfo(el) {
    if (!el || el === document.body || el === document.documentElement) return null;
    const b = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), name: bare(name(el) || norm(el.innerText).slice(0, 80)),
      buttonLike: el.matches(BUTTONISH), link: el.matches('a[href],[role=link]'), submitType: submitType(el),
      inForm: !!(el.form || el.closest('form,[role=form]')), inDialog: !!el.closest('[role=dialog],[role=alertdialog],dialog,[aria-modal=true]'),
      box: { x: b.x, y: b.y, w: b.width, h: b.height } };
  }
  function signature() {
    const vis = sel => [...document.querySelectorAll(sel)].filter(isVisible);
    const a = deepActive();
    const values = [...document.querySelectorAll('input:not([type=hidden]),select,textarea,[role=checkbox],[role=radio],[role=switch]')]
      .map(e => fieldValue(e)).join('\u0001');
    return { url: location.href, title: document.title,
      dialogs: vis('[role=dialog],[role=alertdialog],dialog[open],[aria-modal=true]').map(uid),
      popups: vis('[role=listbox],[role=menu],[role=tooltip]').map(uid).join(','),
      expanded: [...document.querySelectorAll('[aria-expanded=true]')].map(uid).join(','),
      alerts: vis('[role=alert]').map(e => norm(e.textContent)).join('|'),
      focus: a ? uid(a) : 0, values, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) };
  }
  Object.assign(window.__dh, {
    // Element-returning helpers, so Node can hold a handle without racing on window.__dh.last.
    ownerAt(x, y) { const h = hit(x, y); return h ? owner(h) : null; },
    ownerOf: el => owner(el),
    activeEl: () => deepActive(),
    describeExact: el => describe(el, null),
    uidOf: el => uid(el),
    hitUid(x, y) { const h = hit(x, y); if (!h) return { uid: null, interactive: false }; const o = owner(h); return { uid: uid(o), interactive: o.matches(INTERACTIVE) }; },
    formSubmitOf: el => formSubmit(el),
    fieldValue: el => fieldValue(el),
    fieldValueIfConnected: el => (el && el.isConnected ? fieldValue(el) : null),
    formSnapshot,
    interactiveList,
    listItem: i => (window.__dh.list || [])[i] || null,
    signature,
    commitAt(x, y) { const h = hit(x, y); return { info: commitInfo(h ? owner(h) : null), filled: filledFields() }; },
    commitActive() {
      const a = deepActive(), filled = filledFields();
      if (!a) return { kind: 'none', filled };
      const r = role(a);
      if (a.tagName === 'TEXTAREA' || a.isContentEditable) return { kind: 'multiline', filled };
      if ((r === 'combobox' && a.getAttribute('aria-expanded') === 'true') || ['option', 'listbox', 'menu', 'menuitem'].includes(r)) return { kind: 'listbox', filled };
      if (a.matches(BUTTONISH) || a.matches('a[href],[role=link]')) return { kind: 'button', self: commitInfo(a), filled };
      const form = a.form || a.closest('form');
      const def = form ? form.querySelector(DEFAULT_BUTTON) : null;
      return { kind: 'field', def: def ? commitInfo(def) : null, filled };
    },
    commitButtons() {
      return [...document.querySelectorAll(BUTTONISH)].filter(isVisible).map(commitInfo).filter(Boolean);
    },
    requiredEmpty() {
      const out = new Set();
      for (const el of document.querySelectorAll('[required],[aria-required=true]')) {
        if (!shown(el)) continue;
        let empty;
        if (el.tagName === 'FIELDSET' || role(el) === 'radiogroup') empty = !el.querySelector('input:checked,[aria-checked=true]');
        else if (el.tagName === 'INPUT' && el.type === 'radio') empty = !(el.form || document).querySelector(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`);
        else if (el.tagName === 'INPUT' && el.type === 'checkbox') empty = !el.checked;
        else empty = fieldValue(el).trim() === '';
        if (empty) out.add(el.type === 'radio' ? groupName(el) || bare(name(el)) : bare(name(el)) || el.getAttribute('name') || el.id);
      }
      return [...out];
    },
    pageText: () => (document.body ? document.body.innerText : ''),
    mainHeading: () => norm((document.querySelector('h1') || {}).textContent || ''),
    frames: () => new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 250); }),
    waitScrollIdle(x, y, maxMs) {
      const target = hit(x, y);
      const snap = () => {
        let s = scrollX + ',' + scrollY;
        for (let n = target; n && n.nodeType === 1; n = n.parentElement) s += ';' + n.scrollTop + ',' + n.scrollLeft;
        return s;
      };
      return new Promise(resolve => {
        let last = snap(), frames = 0, still = 0;
        const t0 = performance.now();
        const tick = () => {
          const s = snap();
          frames++;
          if (s === last) still++; else { still = 0; last = s; }
          if ((frames >= 3 && still >= 2) || performance.now() - t0 > maxMs) resolve(s);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(() => resolve(snap()), maxMs + 100);
      });
    },
  });
})();
