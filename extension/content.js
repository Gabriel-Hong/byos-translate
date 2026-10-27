// Bilingual page view: finds paragraph-like blocks, translates the ones near the
// viewport in batches, and appends each translation under its source block.
(() => {
  if (globalThis.__byosTranslate) return;
  globalThis.__byosTranslate = true;

  const TR_TAG = "byos-tr";
  // Text inside these elements is never collected or translated.
  const SKIP_SUBTREE = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "PRE", "SVG", "MATH", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT", "EMBED", "BYOS-TR",
  ]);
  const INLINE_TAGS = new Set([
    "A", "ABBR", "ACRONYM", "B", "BDI", "BDO", "BIG", "CITE", "CODE", "DATA", "DEL", "DFN", "EM",
    "FONT", "I", "IMG", "INS", "KBD", "LABEL", "MARK", "NOBR", "Q", "RB", "RP", "RT", "RUBY", "S",
    "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "TT", "U", "VAR", "WBR",
  ]);
  const CODE_TAGS = new Set(["CODE", "KBD", "SAMP", "VAR", "TT"]);
  const EXCLUDED = [
    "nav", "footer", "[role=navigation]", "[aria-hidden=true]", "[hidden]", "[translate=no]",
    ".notranslate", "[contenteditable='']", "[contenteditable=true]", "pre", TR_TAG,
    // Controls whose layout breaks when a block is appended inside them.
    "button", "[role=button]", "[role=search]", "[role=menu]", "[role=menubar]", "[role=toolbar]", "[role=tablist]",
  ].join(",");
  const TARGET_SCRIPTS = {
    ko: { letters: /\p{Script=Hangul}/u },
    ja: { letters: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, requires: /[\p{Script=Hiragana}\p{Script=Katakana}]/u },
    "zh-CN": { letters: /\p{Script=Han}/u },
    "zh-TW": { letters: /\p{Script=Han}/u },
  };
  const LETTER = /\p{L}/u;
  const LETTERS = /\p{L}/gu;

  let settings = null;
  let enabled = false;
  let generation = 0;
  let records = new WeakMap();
  let translated = new Set();
  let queue = [];
  let flushTimer = null;
  let rescanTimer = null;
  let dirty = new Set();
  let visibility = null;
  let mutations = null;

  const isInline = (element) => INLINE_TAGS.has(element.tagName);

  function containerOf(node) {
    let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (element && isInline(element)) element = element.parentElement;
    if (!element || element === document.documentElement || element === document.head) return null;
    return element;
  }

  // Hidden by style, or the 1px clipped box used for skip links and
  // screen-reader-only labels.
  function isHidden(element) {
    if (element.checkVisibility && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
      return true;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width >= 3 && rect.height >= 3) return false;
    const { position } = getComputedStyle(element);
    return position === "absolute" || position === "fixed";
  }

  // Collects the inline text of a block, leaving nested blocks to their own
  // records. `anchor` is the last child holding text, so the translation is
  // placed after this block's own text rather than after nested blocks.
  // With `layout`, text in hidden inline elements is left out; this reads
  // layout, so it runs only for blocks that reached the viewport.
  function extract(container, layout = false) {
    let text = "";
    let prose = 0;
    let anchor = null;
    const visit = (node, top, inCode) => {
      for (const child of node.childNodes) {
        const owner = top ?? child;
        if (child.nodeType === Node.TEXT_NODE) {
          const value = child.nodeValue;
          if (/\S/.test(value)) anchor = owner;
          text += value;
          if (!inCode) prose += value.match(LETTERS)?.length ?? 0;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === "BR") {
            text += "\n";
          } else if (isInline(child) && !SKIP_SUBTREE.has(child.tagName) && !child.hidden && !(layout && isHidden(child))) {
            visit(child, owner, inCode || CODE_TAGS.has(child.tagName));
          }
        }
      }
    };
    visit(container, null, false);
    text = text.replace(/[ \t\f\r ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text, prose, anchor };
  }

  function alreadyInTarget(text) {
    const script = TARGET_SCRIPTS[settings.targetLang];
    if (!script) return false;
    const letters = text.match(LETTERS) ?? [];
    if (letters.length === 0) return true;
    if (script.requires && !script.requires.test(text)) return false;
    return letters.filter((letter) => script.letters.test(letter)).length / letters.length >= 0.5;
  }

  function candidateContainers(root) {
    const found = new Set();
    if (root.nodeType === Node.TEXT_NODE || (root.nodeType === Node.ELEMENT_NODE && isInline(root))) {
      const container = containerOf(root);
      if (container) found.add(container);
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return found;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return SKIP_SUBTREE.has(node.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return LETTER.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const container = containerOf(node);
      if (container) found.add(container);
    }
    return found;
  }

  function removeTranslation(record) {
    record.node?.remove();
    record.node = null;
    translated.delete(record);
  }

  function translatable({ text, prose }) {
    return text.length >= 2 && prose >= 2 && !alreadyInTarget(text);
  }

  // Registers new blocks and re-queues blocks whose source text changed.
  // `text` is the layout-free extraction used to notice changes; the text sent
  // for translation is extracted again once the block becomes visible.
  function scan(root) {
    for (const container of candidateContainers(root)) {
      if (container.closest(EXCLUDED)) continue;
      const extracted = extract(container);
      const previous = records.get(container);
      if (previous && previous.text === extracted.text) continue;
      if (previous) removeTranslation(previous);
      if (!translatable(extracted)) {
        records.delete(container);
        continue;
      }
      records.set(container, { container, text: extracted.text, sendText: null, anchor: null, node: null, state: "new" });
      visibility.observe(container);
    }
  }

  function ensureNode(record) {
    if (record.node?.isConnected) return record.node;
    const node = document.createElement(TR_TAG);
    node.className = "notranslate";
    node.setAttribute("translate", "no");
    node.lang = settings.targetLang;
    if (record.anchor?.parentNode === record.container) {
      record.anchor.after(node);
    } else {
      record.container.append(node);
    }
    record.node = node;
    translated.add(record);
    return node;
  }

  function render(record, state, text, detail) {
    const node = ensureNode(record);
    record.state = state;
    node.className = `notranslate byos-${state}`;
    node.textContent = text;
    if (detail) node.title = detail;
    else node.removeAttribute("title");
  }

  function enqueue(record) {
    if (record.state !== "new" && record.state !== "error") return;
    record.state = "queued";
    queue.push(record);
    flushTimer ??= setTimeout(flush, 120);
  }

  function flush() {
    flushTimer = null;
    const ready = queue.splice(0).filter((record) => record.container.isConnected && records.get(record.container) === record);
    ready.sort((a, b) => (a.container.compareDocumentPosition(b.container) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    let batch = [];
    let chars = 0;
    for (const record of ready) {
      if (batch.length > 0 && (batch.length >= settings.maxSegmentsPerRequest || chars + record.sendText.length > settings.maxCharsPerRequest)) {
        translateBatch(batch);
        batch = [];
        chars = 0;
      }
      batch.push(record);
      chars += record.sendText.length;
    }
    if (batch.length > 0) translateBatch(batch);
  }

  async function translateBatch(batch) {
    const started = generation;
    for (const record of batch) render(record, "loading", "");
    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "byos:translate",
        texts: batch.map((record) => record.sendText),
        pageTitle: document.title,
      });
    } catch (error) {
      response = { error: String(error?.message ?? error) };
    }
    if (started !== generation) return;
    batch.forEach((record, index) => {
      if (records.get(record.container) !== record) return;
      const translation = response?.translations?.[index];
      if (translation) {
        render(record, "done", translation);
      } else {
        render(record, "error", "⚠ 번역 실패 · 클릭해서 다시 시도", response?.error ?? "알 수 없는 오류");
      }
    });
  }

  function onVisible(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      visibility.unobserve(entry.target);
      const record = records.get(entry.target);
      if (!record || record.state !== "new") continue;
      const visible = isHidden(record.container) ? null : extract(record.container, true);
      if (!visible || !translatable(visible)) {
        record.state = "skipped";
        continue;
      }
      record.sendText = visible.text;
      record.anchor = visible.anchor;
      enqueue(record);
    }
  }

  function onMutations(list) {
    for (const mutation of list) {
      const target = mutation.target;
      const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
      if (element?.closest(TR_TAG)) continue;
      if (mutation.type === "characterData") {
        dirty.add(target);
        continue;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeName !== "BYOS-TR") dirty.add(node);
      }
    }
    if (dirty.size > 0) rescanTimer ??= setTimeout(rescan, 400);
  }

  function rescan() {
    rescanTimer = null;
    const roots = [...dirty];
    dirty = new Set();
    for (const root of roots) if (root.isConnected) scan(root);
  }

  function onClick(event) {
    const node = event.target.closest?.(`${TR_TAG}.byos-error`);
    if (!node) return;
    const record = [...translated].find((candidate) => candidate.node === node);
    if (!record) return;
    event.preventDefault();
    event.stopPropagation();
    enqueue(record);
  }

  function applyStyle() {
    document.documentElement.dataset.byosStyle = settings.displayStyle;
  }

  async function enable() {
    settings = await chrome.runtime.sendMessage({ type: "byos:settings" });
    enabled = true;
    generation++;
    applyStyle();
    visibility = new IntersectionObserver(onVisible, { rootMargin: "600px 0px" });
    mutations = new MutationObserver(onMutations);
    mutations.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener("click", onClick, true);
    scan(document.body);
  }

  function disable() {
    enabled = false;
    generation++;
    visibility?.disconnect();
    mutations?.disconnect();
    document.removeEventListener("click", onClick, true);
    clearTimeout(flushTimer);
    clearTimeout(rescanTimer);
    flushTimer = null;
    rescanTimer = null;
    queue = [];
    dirty = new Set();
    for (const record of translated) record.node?.remove();
    translated = new Set();
    records = new WeakMap();
    delete document.documentElement.dataset.byosStyle;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "byos:toggle") {
      if (enabled) {
        disable();
        sendResponse({ enabled: false });
      } else {
        enable().then(() => sendResponse({ enabled: true }), (error) => sendResponse({ enabled: false, error: String(error) }));
        return true;
      }
    } else if (message?.type === "byos:status") {
      sendResponse({ enabled });
    } else if (message?.type === "byos:settings-changed" && enabled) {
      const retranslate = message.settings.targetLang !== settings.targetLang || message.settings.model !== settings.model;
      if (retranslate) {
        disable();
        enable();
      } else {
        settings = message.settings;
        applyStyle();
      }
    }
    return false;
  });
})();
