(function initShared(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PeekNoteShared = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createShared() {
  const DEFAULT_SHORTCUT = "CommandOrControl+Alt+Space";
  const DEFAULT_TEXT = [
    "# 今天别忘",
    "",
    "- [ ] 把 Windows 顶部胶囊跑起来",
    "- [ ] 支持 hover 展开和自动收起",
    "- [ ] 粘贴图片后预览 Markdown",
    "",
    "> 小胶囊常驻顶部，展开时才占用屏幕。"
  ].join("\n");

  function makeId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }

    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
  }

  function createDefaultStore() {
    const firstId = makeId();
    return {
      version: 3,
      activeTabId: firstId,
      tabs: [
        {
          id: firstId,
          text: DEFAULT_TEXT,
          createdAt: new Date().toISOString()
        }
      ],
      settings: {
        compactWidth: 64,
        expandedWidth: 620,
        expandedHeight: 480,
        topOffset: 0,
        collapseDelay: 350,
        showTriggerDebug: false,
        pinExpanded: false,
        launchAtLogin: false,
        themeMode: "dark",
        visualStyle: "glass",
        glassOpacity: 10,
        shortcut: DEFAULT_SHORTCUT
      }
    };
  }

  function normalizeTheme(value) {
    return ["dark", "light", "system"].includes(value) ? value : "dark";
  }

  function normalizeVisualStyle(value) {
    return value === "solid" ? "solid" : "glass";
  }

  function normalizeSettings(settings) {
    const fallback = createDefaultStore().settings;
    const source = settings && typeof settings === "object" ? settings : {};
    const normalizedShortcut = normalizeShortcut(source.shortcut || fallback.shortcut);

    return {
      compactWidth: clampNumber(source.compactWidth, 44, 800, fallback.compactWidth),
      expandedWidth: clampNumber(source.expandedWidth, 460, 1200, fallback.expandedWidth),
      expandedHeight: clampNumber(source.expandedHeight, 340, 1200, fallback.expandedHeight),
      topOffset: clampNumber(source.topOffset, 0, 300, fallback.topOffset),
      collapseDelay: clampNumber(source.collapseDelay, 0, 5000, fallback.collapseDelay),
      showTriggerDebug: Boolean(source.showTriggerDebug),
      pinExpanded: Boolean(source.pinExpanded),
      launchAtLogin: Boolean(source.launchAtLogin),
      themeMode: normalizeTheme(source.themeMode),
      visualStyle: normalizeVisualStyle(source.visualStyle),
      glassOpacity: clampNumber(source.glassOpacity, 10, 50, fallback.glassOpacity),
      shortcut: normalizedShortcut.accelerator || DEFAULT_SHORTCUT
    };
  }

  function normalizeStore(input) {
    const fallback = createDefaultStore();
    const source = input && typeof input === "object" ? input : {};
    const tabs = Array.isArray(source.tabs)
      ? source.tabs
          .filter((tab) => tab && typeof tab === "object")
          .map((tab) => ({
            id: typeof tab.id === "string" && tab.id ? tab.id : makeId(),
            text: typeof tab.text === "string" ? tab.text : "",
            createdAt: typeof tab.createdAt === "string" ? tab.createdAt : new Date().toISOString()
          }))
      : [];

    const safeTabs = tabs.length ? tabs : fallback.tabs;
    const activeTabId = safeTabs.some((tab) => tab.id === source.activeTabId)
      ? source.activeTabId
      : safeTabs[0].id;

    const sourceSettings = source.settings && typeof source.settings === "object"
      ? {
          ...source.settings,
          compactWidth: source.version >= 3 ? source.settings.compactWidth : fallback.settings.compactWidth
        }
      : source.settings;

    return {
      version: 3,
      activeTabId,
      tabs: safeTabs,
      settings: normalizeSettings(sourceSettings)
    };
  }

  function activeTab(store) {
    if (store && Array.isArray(store.tabs) && store.tabs.length) {
      return store.tabs.find((tab) => tab.id === store.activeTabId) || store.tabs[0];
    }

    const normalized = normalizeStore(store);
    return normalized.tabs.find((tab) => tab.id === normalized.activeTabId) || normalized.tabs[0];
  }

  function titleFromText(text) {
    const firstUsefulLine = String(text || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);

    if (!firstUsefulLine) return "未命名";
    return firstUsefulLine.replace(/^#+\s*/, "").replace(/^- \[[ xX]\]\s*/, "").slice(0, 28);
  }

  function extractTaskLines(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((line, index) => {
        const match = line.match(/^(\s*)- \[([ xX])\]\s+(.*)$/);
        if (!match) return null;

        return {
          index,
          checked: match[2].toLowerCase() === "x",
          label: match[3],
          raw: line
        };
      })
      .filter(Boolean);
  }

  function toggleTaskLine(text, index, checked) {
    const lines = String(text || "").split(/\r?\n/);
    if (index < 0 || index >= lines.length) return String(text || "");

    lines[index] = lines[index].replace(/^(\s*)- \[[ xX]\]/, "$1- [" + (checked ? "x" : " ") + "]");
    return lines.join("\n");
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isSafeUrl(url) {
    return /^(https?:|data:image\/|file:|\.\/|\/|#)/i.test(String(url || ""));
  }

  function inlineMarkdown(raw) {
    let text = escapeHtml(raw);
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
      const safeUrl = String(url || "").trim();
      if (!isSafeUrl(safeUrl)) return escapeHtml(_match);
      return `<img class="md-image" alt="${escapeHtml(alt)}" src="${escapeHtml(safeUrl)}">`;
    });
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
      const safeUrl = String(url || "").trim();
      if (!isSafeUrl(safeUrl)) return escapeHtml(_match);
      return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer">${label}</a>`;
    });
    text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return text;
  }

  function renderMarkdown(markdown) {
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    const html = [];
    let paragraph = [];
    let listOpen = false;
    let orderedListOpen = false;
    let codeOpen = false;
    let codeLines = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      html.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
      paragraph = [];
    }

    function closeList() {
      if (!listOpen) return;
      html.push("</ul>");
      listOpen = false;
    }

    function closeOrderedList() {
      if (!orderedListOpen) return;
      html.push("</ol>");
      orderedListOpen = false;
    }

    function flushCode() {
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      codeLines = [];
    }

    for (const line of lines) {
      const fence = line.match(/^```/);
      if (fence) {
        flushParagraph();
        closeList();
        closeOrderedList();
        if (codeOpen) flushCode();
        codeOpen = !codeOpen;
        continue;
      }

      if (codeOpen) {
        codeLines.push(line);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        closeList();
        closeOrderedList();
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        closeOrderedList();
        html.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
        continue;
      }

      if (/^---+$/.test(line.trim())) {
        flushParagraph();
        closeList();
        closeOrderedList();
        html.push("<hr>");
        continue;
      }

      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        flushParagraph();
        closeList();
        closeOrderedList();
        html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
        continue;
      }

      const task = line.match(/^\s*- \[([ xX])\]\s+(.*)$/);
      if (task) {
        flushParagraph();
        closeOrderedList();
        if (!listOpen) {
          html.push("<ul>");
          listOpen = true;
        }
        const checked = task[1].toLowerCase() === "x" ? " checked" : "";
        html.push(`<li class="md-task"><input type="checkbox" data-md-task${checked}> <span>${inlineMarkdown(task[2])}</span></li>`);
        continue;
      }

      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        flushParagraph();
        closeOrderedList();
        if (!listOpen) {
          html.push("<ul>");
          listOpen = true;
        }
        html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
        continue;
      }

      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ordered) {
        flushParagraph();
        closeList();
        if (!orderedListOpen) {
          html.push("<ol>");
          orderedListOpen = true;
        }
        html.push(`<li>${inlineMarkdown(ordered[1])}</li>`);
        continue;
      }

      closeList();
      closeOrderedList();
      paragraph.push(line);
    }

    if (codeOpen) flushCode();
    flushParagraph();
    closeList();
    closeOrderedList();
    return html.join("");
  }

  function normalizeShortcut(input) {
    const raw = String(input || "").trim();
    if (!raw) return { accelerator: "", display: "", valid: false, reason: "请输入快捷键" };

    const keyMap = new Map([
      ["ctrl", "CommandOrControl"],
      ["control", "CommandOrControl"],
      ["cmd", "CommandOrControl"],
      ["command", "CommandOrControl"],
      ["commandorcontrol", "CommandOrControl"],
      ["option", "Alt"],
      ["alt", "Alt"],
      ["shift", "Shift"],
      ["win", "Super"],
      ["windows", "Super"],
      ["meta", "Super"],
      ["super", "Super"],
      ["space", "Space"],
      ["esc", "Escape"],
      ["escape", "Escape"],
      ["del", "Delete"],
      ["delete", "Delete"],
      ["backspace", "Backspace"],
      ["enter", "Enter"],
      ["return", "Enter"],
      ["tab", "Tab"],
      ["up", "Up"],
      ["down", "Down"],
      ["left", "Left"],
      ["right", "Right"]
    ]);

    const modifiers = new Set();
    let key = "";
    for (const part of raw.split("+").map((item) => item.trim()).filter(Boolean)) {
      const normalized = keyMap.get(part.toLowerCase()) || part.toUpperCase();
      if (["CommandOrControl", "Alt", "Shift", "Super"].includes(normalized)) {
        modifiers.add(normalized);
      } else {
        key = normalized.length === 1 ? normalized.toUpperCase() : normalized;
      }
    }

    if (!key) return { accelerator: "", display: raw, valid: false, reason: "缺少主键" };

    const order = ["CommandOrControl", "Alt", "Shift", "Super"];
    const accelerator = [...order.filter((modifier) => modifiers.has(modifier)), key].join("+");
    return {
      accelerator,
      display: shortcutDisplay(accelerator),
      valid: true,
      reason: ""
    };
  }

  function shortcutDisplay(accelerator) {
    return String(accelerator || "")
      .replace(/CommandOrControl/g, "Ctrl")
      .replace(/Super/g, "Win")
      .replace(/\+/g, " + ");
  }

  return {
    DEFAULT_SHORTCUT,
    createDefaultStore,
    normalizeStore,
    normalizeSettings,
    normalizeShortcut,
    shortcutDisplay,
    activeTab,
    titleFromText,
    extractTaskLines,
    toggleTaskLine,
    renderMarkdown
  };
});
