const shared = window.PeekNoteShared;
const bridge = window.peekNote;

const appEl = document.getElementById("app");
const compactBar = document.getElementById("compactBar");
const compactAdd = document.getElementById("compactAdd");
const tabsEl = document.getElementById("tabs");
const addTabButton = document.getElementById("addTab");
const deleteTabButton = document.getElementById("deleteTab");
const pinToggle = document.getElementById("pinToggle");
const settingsToggle = document.getElementById("settingsToggle");
const closeSettings = document.getElementById("closeSettings");
const settingsPanel = document.getElementById("settingsPanel");
const noteTitle = document.getElementById("noteTitle");
const richEditor = document.getElementById("richEditor");
const tabMenu = document.getElementById("tabMenu");
const renameTabButton = document.getElementById("renameTab");
const removeTabButton = document.getElementById("removeTab");
const shortcutStatus = document.getElementById("shortcutStatus");

const settingInputs = {
  compactWidth: document.getElementById("compactWidth"),
  expandedWidth: document.getElementById("expandedWidth"),
  expandedHeight: document.getElementById("expandedHeight"),
  topOffset: document.getElementById("topOffset"),
  collapseDelay: document.getElementById("collapseDelay"),
  glassOpacity: document.getElementById("glassOpacity"),
  shortcutInput: document.getElementById("shortcutInput"),
  showTriggerDebug: document.getElementById("showTriggerDebug"),
  launchAtLogin: document.getElementById("launchAtLogin")
};

const settingOutputs = {
  compactWidth: document.getElementById("compactWidthValue"),
  expandedWidth: document.getElementById("expandedWidthValue"),
  expandedHeight: document.getElementById("expandedHeightValue"),
  topOffset: document.getElementById("topOffsetValue"),
  collapseDelay: document.getElementById("collapseDelayValue"),
  glassOpacity: document.getElementById("glassOpacityValue")
};

let store = shared.createDefaultStore();
let runtime = { shortcut: { registered: false, message: "未注册" }, shouldUseDarkColors: true };
let saveTimer;
let settingCommitTimer;
let settingsRequestSerial = 0;
let applyingTitle = false;
let contextTabId = "";
let draggedTabId = "";
let composing = false;
let currentWindowMode = "compact";
let panelInteractionActive = false;
let activeResizeEdge = "";
let activeResizePointerId = null;
let activeResizeTarget = null;

function markPanelActive() {
  if (currentWindowMode !== "expanded") return;
  if (!panelInteractionActive) {
    panelInteractionActive = true;
    bridge.setPanelActive(true);
  }
}

function startResize(event) {
  if (currentWindowMode !== "expanded") return;
  if (event.button !== 0) return;
  const edge = event.currentTarget.dataset.resizeEdge;
  if (!edge) return;
  event.preventDefault();
  event.stopPropagation();
  activeResizeEdge = edge;
  activeResizePointerId = event.pointerId;
  activeResizeTarget = event.currentTarget;
  activeResizeTarget.setPointerCapture?.(activeResizePointerId);
  appEl.classList.add("resizing");
  markPanelActive();
  bridge.resizeStart(edge);
}

function moveResize(event) {
  if (!activeResizeEdge) return;
  event?.preventDefault();
  bridge.resizeMove();
}

function endResize() {
  if (!activeResizeEdge) return;
  if (activeResizeTarget && activeResizePointerId !== null) {
    activeResizeTarget.releasePointerCapture?.(activeResizePointerId);
  }
  activeResizeEdge = "";
  activeResizePointerId = null;
  activeResizeTarget = null;
  appEl.classList.remove("resizing");
  bridge.resizeEnd();
}

function activeTab() {
  return shared.activeTab(store);
}

function normalizeCurrentStore() {
  store = shared.normalizeStore(store);
  return store;
}

function saveNow() {
  clearTimeout(saveTimer);
  normalizeCurrentStore();
  return bridge.saveStore(store);
}

function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    normalizeCurrentStore();
    bridge.saveStore(store);
  }, 120);
}

function applyTheme() {
  const themeMode = store.settings.themeMode;
  const theme = themeMode === "system" ? (runtime.shouldUseDarkColors ? "dark" : "light") : themeMode;
  appEl.dataset.theme = theme;
  appEl.dataset.style = store.settings.visualStyle;
}

function render(forceEditor = false) {
  normalizeCurrentStore();
  applyTheme();
  renderTabs();
  renderEditor(forceEditor);
  renderSettings();

  applyingTitle = true;
  noteTitle.value = shared.titleFromText(activeTab().text);
  applyingTitle = false;
  pinToggle.classList.toggle("active", store.settings.pinExpanded);
}

function renderEditor(force = false) {
  if (!force && document.activeElement === richEditor) return;
  richEditor.innerHTML = shared.renderMarkdown(bodyMarkdown(activeTab().text));
  wireEditorElements();
}

function wireEditorElements() {
  richEditor.querySelectorAll("a[href]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      bridge.openExternal(link.href);
    });
  });
}

function renderTabs() {
  tabsEl.replaceChildren(
    ...store.tabs.map((tab) => {
      const button = document.createElement("button");
      button.className = "tab" + (tab.id === store.activeTabId ? " active" : "");
      button.textContent = shared.titleFromText(tab.text);
      button.title = "双击重命名，右键删除/重命名，拖拽调整顺序";
      button.draggable = true;
      button.dataset.tabId = tab.id;

      button.addEventListener("click", () => {
        hideTabMenu();
        if (store.activeTabId === tab.id) return;
        commitEditor();
        store.activeTabId = tab.id;
        render(true);
        saveNow();
        richEditor.focus();
      });

      button.addEventListener("dblclick", (event) => {
        event.preventDefault();
        startInlineRename(tab.id, button);
      });

      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        showTabMenu(tab.id, event.clientX, event.clientY);
      });

      button.addEventListener("dragstart", (event) => {
        draggedTabId = tab.id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tab.id);
      });

      button.addEventListener("dragover", (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        button.classList.add("drop-target");
      });

      button.addEventListener("dragleave", () => button.classList.remove("drop-target"));
      button.addEventListener("drop", (event) => {
        event.preventDefault();
        button.classList.remove("drop-target");
        moveTab(draggedTabId || event.dataTransfer.getData("text/plain"), tab.id);
      });

      return button;
    })
  );
}

function textContent(node) {
  return (node.textContent || "").replace(/\u00a0/g, " ").trim();
}

function inlineMarkdownFromNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "strong" || tag === "b") return `**${Array.from(node.childNodes).map(inlineMarkdownFromNode).join("")}**`;
  if (tag === "em" || tag === "i") return `*${Array.from(node.childNodes).map(inlineMarkdownFromNode).join("")}*`;
  if (tag === "code") return `\`${node.textContent || ""}\``;
  if (tag === "del" || tag === "s" || tag === "strike") return `~~${Array.from(node.childNodes).map(inlineMarkdownFromNode).join("")}~~`;
  if (tag === "a") return `[${textContent(node)}](${node.getAttribute("href") || ""})`;
  if (tag === "img") return `![${node.getAttribute("alt") || "图片"}](${node.getAttribute("src") || ""})`;
  if (tag === "br") return "\n";
  return Array.from(node.childNodes).map(inlineMarkdownFromNode).join("");
}

function blockToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").trim();
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return `${"#".repeat(Number(tag[1]))} ${textContent(node)}`;
  if (tag === "blockquote") return `> ${textContent(node)}`;
  if (tag === "pre") return "```\n" + (node.textContent || "").trimEnd() + "\n```";
  if (tag === "hr") return "---";
  if (tag === "ul") {
    return Array.from(node.children).map(blockToMarkdown).filter(Boolean).join("\n");
  }
  if (tag === "ol") {
    return Array.from(node.children)
      .map((child, index) => orderedListItemToMarkdown(child, index + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (tag === "li") {
    const checkbox = node.querySelector(":scope > input[type='checkbox']");
    const span = node.querySelector(":scope > span");
    const content = span ? Array.from(span.childNodes).map(inlineMarkdownFromNode).join("").trim() : textContent(node);
    if (checkbox) return `- [${checkbox.checked ? "x" : " "}] ${content}`;
    return `- ${content}`;
  }
  if (tag === "img") return inlineMarkdownFromNode(node);
  if (tag === "div" || tag === "p") {
    const imageOnly = node.children.length === 1 && node.firstElementChild?.tagName?.toLowerCase() === "img";
    if (imageOnly) return inlineMarkdownFromNode(node.firstElementChild);
    return Array.from(node.childNodes).map(inlineMarkdownFromNode).join("").trim();
  }

  return Array.from(node.childNodes).map(inlineMarkdownFromNode).join("").trim();
}

function orderedListItemToMarkdown(node, number) {
  if (!node || node.nodeType !== Node.ELEMENT_NODE || node.tagName.toLowerCase() !== "li") return "";
  const span = node.querySelector(":scope > span");
  const content = span ? Array.from(span.childNodes).map(inlineMarkdownFromNode).join("").trim() : textContent(node);
  return `${number}. ${content}`;
}

function editorToMarkdown() {
  const blocks = Array.from(richEditor.childNodes)
    .map(blockToMarkdown)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  return blocks.join("\n\n").trim();
}

function bodyMarkdown(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (lines[0] && lines[0].startsWith("#")) {
    lines.shift();
    if (lines[0] === "") lines.shift();
  }
  return lines.join("\n").trim();
}

function markdownWithTitle(title, body) {
  const safeTitle = title.trim() || "未命名";
  const cleanBody = String(body || "").trim();
  return cleanBody ? `# ${safeTitle}\n\n${cleanBody}` : `# ${safeTitle}`;
}

function commitEditor() {
  if (composing) return;
  activeTab().text = markdownWithTitle(noteTitle.value, editorToMarkdown());
  renderTabs();
  saveSoon();
}

function formatDelay(ms) {
  if (ms <= 0) return "秒关";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms % 1000 ? 1 : 0)} s`;
}

function syncRangeProgress(input) {
  if (!input || input.type !== "range") return;
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || min);
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--range-progress", `${Math.max(0, Math.min(100, percent))}%`);
}

function renderSettings() {
  const settings = store.settings;
  settingInputs.compactWidth.value = settings.compactWidth;
  settingInputs.expandedWidth.value = settings.expandedWidth;
  settingInputs.expandedHeight.value = settings.expandedHeight;
  settingInputs.topOffset.value = settings.topOffset;
  settingInputs.collapseDelay.value = settings.collapseDelay;
  settingInputs.glassOpacity.value = settings.glassOpacity;
  settingInputs.showTriggerDebug.checked = Boolean(settings.showTriggerDebug);
  settingInputs.launchAtLogin.checked = Boolean(settings.launchAtLogin);
  if (document.activeElement !== settingInputs.shortcutInput) {
    settingInputs.shortcutInput.value = shared.shortcutDisplay(settings.shortcut);
  }

  settingOutputs.compactWidth.textContent = `${settings.compactWidth}px`;
  settingOutputs.expandedWidth.textContent = `${settings.expandedWidth}px`;
  settingOutputs.expandedHeight.textContent = `${settings.expandedHeight}px`;
  settingOutputs.topOffset.textContent = `${settings.topOffset}px`;
  settingOutputs.collapseDelay.textContent = formatDelay(settings.collapseDelay);
  settingOutputs.glassOpacity.textContent = `${settings.glassOpacity}%`;

  document.querySelectorAll("[data-theme-value]").forEach((button) => {
    button.classList.toggle("active", button.dataset.themeValue === settings.themeMode);
  });
  document.querySelectorAll("[data-style-value]").forEach((button) => {
    button.classList.toggle("active", button.dataset.styleValue === settings.visualStyle);
  });
  document.querySelectorAll("[data-delay]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.delay) === settings.collapseDelay);
  });

  const shortcut = runtime.shortcut || {};
  shortcutStatus.textContent = `${shortcut.message || "未注册"}：${shortcut.display || shared.shortcutDisplay(settings.shortcut)}`;
  shortcutStatus.classList.toggle("bad", shortcut.registered === false);
  Object.values(settingInputs).forEach(syncRangeProgress);
}

function setTabTitle(tab, title) {
  const safeTitle = title.trim() || "未命名";
  const lines = tab.text.split(/\r?\n/);
  if (lines[0] && lines[0].startsWith("#")) {
    lines[0] = "# " + safeTitle;
  } else {
    lines.unshift("# " + safeTitle, "");
  }
  tab.text = lines.join("\n");
}

function startInlineRename(tabId, button) {
  const tab = store.tabs.find((item) => item.id === tabId);
  if (!tab) return;
  const input = document.createElement("input");
  input.className = "tab-rename-input";
  input.value = shared.titleFromText(tab.text);
  button.replaceChildren(input);
  button.draggable = false;
  input.focus();
  input.select();
  let finished = false;

  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      setTabTitle(tab, input.value);
      if (tab.id === store.activeTabId) {
        noteTitle.value = shared.titleFromText(tab.text);
      }
      saveNow();
    }
    renderTabs();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true), { once: true });
}

function renameTab(tabId = store.activeTabId) {
  const button = tabsEl.querySelector(`[data-tab-id="${tabId}"]`);
  if (button) startInlineRename(tabId, button);
}

function removeTab(tabId = store.activeTabId) {
  const tab = store.tabs.find((item) => item.id === tabId);
  if (!tab) return;

  if (store.tabs.length <= 1) {
    tab.text = "";
    render(true);
    saveNow();
    return;
  }

  const index = store.tabs.findIndex((item) => item.id === tabId);
  store.tabs.splice(index, 1);
  if (store.activeTabId === tabId) {
    store.activeTabId = store.tabs[Math.max(0, index - 1)].id;
  }
  render(true);
  saveNow();
}

function moveTab(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const from = store.tabs.findIndex((tab) => tab.id === sourceId);
  const to = store.tabs.findIndex((tab) => tab.id === targetId);
  if (from < 0 || to < 0) return;
  const [moved] = store.tabs.splice(from, 1);
  store.tabs.splice(to, 0, moved);
  renderTabs();
  saveNow();
}

function showTabMenu(tabId, x, y) {
  contextTabId = tabId;
  tabMenu.style.left = `${x}px`;
  tabMenu.style.top = `${y}px`;
  tabMenu.classList.add("open");
  tabMenu.setAttribute("aria-hidden", "false");
}

function hideTabMenu() {
  tabMenu.classList.remove("open");
  tabMenu.setAttribute("aria-hidden", "true");
}

function addTab() {
  commitEditor();
  const tab = {
    id: shared.createDefaultStore().activeTabId,
    text: "# 新待办\n\n- [ ] ",
    createdAt: new Date().toISOString()
  };
  store.tabs.push(tab);
  store.activeTabId = tab.id;
  render(true);
  saveNow();
  richEditor.focus();
}

function deleteActiveTab() {
  removeTab(store.activeTabId);
}

function insertHtml(html) {
  richEditor.focus();
  document.execCommand("insertHTML", false, html);
  commitEditor();
}

function currentEditableBlock() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  let node = selection.anchorNode;
  if (!node || !richEditor.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
  while (node && node !== richEditor) {
    if (node.nodeType === Node.ELEMENT_NODE && /^(p|div|h[1-6]|blockquote|li|pre)$/i.test(node.tagName)) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function placeCaretAtEnd(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  richEditor.focus();
}

function replaceBlockTag(block, tagName) {
  const replacement = document.createElement(tagName);
  replacement.innerHTML = block.innerHTML || block.textContent || "";
  block.replaceWith(replacement);
  placeCaretAtEnd(replacement);
  commitEditor();
}

function insertBlock(kind) {
  const block = currentEditableBlock();
  if ((kind === "h1" || kind === "h2") && block) {
    replaceBlockTag(block, kind);
    return;
  }

  const blocks = {
    h1: "<h1>一级标题</h1>",
    h2: "<h2>二级标题</h2>",
    ul: "<ul><li>列表项</li></ul>",
    ol: "<ol><li>列表项</li></ol>",
    quote: "<blockquote>引用</blockquote>",
    code: "<pre><code>code</code></pre>",
    hr: "<hr>"
  };
  Object.assign(blocks, {
    h1: "<h1>一级标题</h1>",
    h2: "<h2>二级标题</h2>",
    ul: "<ul><li>列表项</li></ul>",
    ol: "<ol><li>列表项</li></ol>",
    quote: "<blockquote>引用</blockquote>"
  });
  const html = blocks[kind];
  if (html) insertHtml(html);
}

function updateSetting(key, value, options = {}) {
  const requestSerial = ++settingsRequestSerial;
  store.settings = {
    ...store.settings,
    [key]: value
  };
  applyTheme();
  renderSettings();

  if (options.localOnly) return;

  bridge.updateSettings(store.settings).then((payload) => {
    if (requestSerial !== settingsRequestSerial) return;
    store.settings = {
      ...store.settings,
      ...payload.settings
    };
    runtime = payload.runtime || runtime;
    renderSettings();
    saveSoon();
  });
}

function commitSetting(key, value) {
  clearTimeout(settingCommitTimer);
  settingCommitTimer = setTimeout(() => updateSetting(key, value), 40);
}

function handleShortcutInput() {
  const normalized = shared.normalizeShortcut(settingInputs.shortcutInput.value);
  if (!normalized.valid) {
    shortcutStatus.textContent = normalized.reason;
    shortcutStatus.classList.add("bad");
    return;
  }
  settingInputs.shortcutInput.value = normalized.display;
  updateSetting("shortcut", normalized.accelerator);
}

function pasteImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    insertHtml(`<p><img class="md-image" alt="粘贴图片" src="${reader.result}"></p>`);
  };
  reader.readAsDataURL(file);
}

compactBar.addEventListener("mouseenter", () => bridge.expand());
compactBar.addEventListener("click", () => bridge.expand());
if (compactAdd) {
  compactAdd.addEventListener("click", (event) => {
    event.stopPropagation();
    bridge.expand();
    addTab();
  });
}

appEl.addEventListener(
  "pointerdown",
  (event) => {
    if (!compactBar.contains(event.target)) markPanelActive();
  },
  true
);

addTabButton.addEventListener("click", addTab);
if (deleteTabButton) deleteTabButton.addEventListener("click", deleteActiveTab);
pinToggle.addEventListener("click", () => {
  const next = !store.settings.pinExpanded;
  store.settings.pinExpanded = next;
  bridge.setPinned(next);
  render();
  saveSoon();
});

settingsToggle.addEventListener("click", () => settingsPanel.classList.toggle("open"));
closeSettings.addEventListener("click", () => settingsPanel.classList.remove("open"));
renameTabButton.addEventListener("click", () => {
  renameTab(contextTabId);
  hideTabMenu();
});
removeTabButton.addEventListener("click", () => {
  removeTab(contextTabId);
  hideTabMenu();
});
document.addEventListener("click", (event) => {
  if (!tabMenu.contains(event.target)) hideTabMenu();
});

noteTitle.addEventListener("input", () => {
  markPanelActive();
  if (applyingTitle) return;
  activeTab().text = markdownWithTitle(noteTitle.value, editorToMarkdown());
  renderTabs();
  saveSoon();
});
noteTitle.addEventListener("change", saveNow);
noteTitle.addEventListener("keydown", markPanelActive);

richEditor.addEventListener("compositionstart", () => {
  markPanelActive();
  composing = true;
});
richEditor.addEventListener("compositionend", () => {
  markPanelActive();
  composing = false;
  commitEditor();
});
richEditor.addEventListener("input", () => {
  markPanelActive();
  commitEditor();
});
richEditor.addEventListener("keydown", markPanelActive);
richEditor.addEventListener("blur", saveNow);
richEditor.addEventListener("change", saveNow);
richEditor.addEventListener("paste", (event) => {
  markPanelActive();
  const files = [...(event.clipboardData?.files || [])];
  const image = files.find((file) => file.type.startsWith("image/"));
  if (!image) return;
  event.preventDefault();
  pasteImage(image);
});
richEditor.addEventListener("change", (event) => {
  if (event.target.matches("input[type='checkbox']")) {
    commitEditor();
  }
});
richEditor.addEventListener("click", (event) => {
  if (event.target.matches("input[type='checkbox']")) {
    setTimeout(commitEditor, 0);
  }
});

document.querySelectorAll(".formatbar button").forEach((button) => {
  button.addEventListener("mousedown", (event) => event.preventDefault());
});

document.querySelectorAll("[data-insert]").forEach((button) => {
  button.addEventListener("click", () => {
    markPanelActive();
    if (button.dataset.insert === "- [ ] ") {
      insertHtml(`<ul><li class="md-task"><input type="checkbox" data-md-task> <span>新待办</span></li></ul>`);
    } else if (button.dataset.insert.startsWith("![图片]")) {
      insertHtml(`<p><img class="md-image" alt="图片" src="https://"></p>`);
    } else {
      insertHtml(`<span>${button.dataset.insert}</span>`);
    }
  });
});

document.querySelectorAll("[data-block]").forEach((button) => {
  button.addEventListener("click", () => {
    markPanelActive();
    insertBlock(button.dataset.block);
  });
});

document.querySelectorAll("[data-wrap]").forEach((button) => {
  button.addEventListener("click", () => {
    markPanelActive();
    richEditor.focus();
    if (button.dataset.wrap === "**") document.execCommand("bold");
    if (button.dataset.wrap === "*") document.execCommand("italic");
    if (button.dataset.wrap === "~~") document.execCommand("strikeThrough");
    commitEditor();
  });
});

const liveSettingKeys = new Set(["compactWidth", "glassOpacity"]);

["compactWidth", "expandedWidth", "expandedHeight", "topOffset", "collapseDelay", "glassOpacity"].forEach((key) => {
  settingInputs[key].addEventListener("input", () => {
    markPanelActive();
    syncRangeProgress(settingInputs[key]);
    const value = Number(settingInputs[key].value);
    updateSetting(key, value, { localOnly: !liveSettingKeys.has(key) });
  });
  settingInputs[key].addEventListener("change", () => {
    markPanelActive();
    commitSetting(key, Number(settingInputs[key].value));
  });
  settingInputs[key].addEventListener("pointerup", () => {
    markPanelActive();
    commitSetting(key, Number(settingInputs[key].value));
  });
});

settingInputs.showTriggerDebug.addEventListener("change", () => {
  markPanelActive();
  updateSetting("showTriggerDebug", settingInputs.showTriggerDebug.checked);
});
settingInputs.launchAtLogin.addEventListener("change", () => {
  markPanelActive();
  updateSetting("launchAtLogin", settingInputs.launchAtLogin.checked);
});
settingInputs.shortcutInput.addEventListener("keydown", (event) => {
  markPanelActive();
  if (event.key === "Enter") {
    event.preventDefault();
    handleShortcutInput();
  }
});
settingInputs.shortcutInput.addEventListener("blur", handleShortcutInput);

document.querySelectorAll("[data-theme-value]").forEach((button) => {
  button.addEventListener("click", () => {
    markPanelActive();
    updateSetting("themeMode", button.dataset.themeValue);
  });
});
document.querySelectorAll("[data-style-value]").forEach((button) => {
  button.addEventListener("click", () => {
    markPanelActive();
    updateSetting("visualStyle", button.dataset.styleValue);
  });
});
document.querySelectorAll("[data-delay]").forEach((button) => {
  button.addEventListener("click", () => {
    markPanelActive();
    updateSetting("collapseDelay", Number(button.dataset.delay));
  });
});

document.querySelectorAll(".resize-handle").forEach((handle) => {
  handle.addEventListener("pointerdown", startResize);
  handle.addEventListener("pointermove", moveResize);
  handle.addEventListener("pointerup", endResize);
  handle.addEventListener("pointercancel", endResize);
  handle.addEventListener("lostpointercapture", endResize);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || currentWindowMode !== "expanded") return;
  event.preventDefault();
  bridge.collapse();
});

bridge.onModeChange((mode) => {
  const openingFromHidden = currentWindowMode !== "expanded" && mode === "expanded";
  currentWindowMode = mode;
  if (openingFromHidden) appEl.classList.add("opening-instant");
  if (mode !== "expanded") {
    panelInteractionActive = false;
    endResize();
  }
  appEl.classList.toggle("expanded", mode === "expanded");
  appEl.classList.toggle("compact", mode !== "expanded");
  if (openingFromHidden) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bridge.modeApplied(mode);
        appEl.classList.remove("opening-instant");
      });
    });
  } else {
    bridge.modeApplied(mode);
  }
  if (mode === "expanded") setTimeout(() => richEditor.focus(), 80);
});

bridge.onSettingsChanged((payload) => {
  store.settings = {
    ...store.settings,
    ...(payload.settings || {})
  };
  runtime = payload.runtime || runtime;
  render();
});

window.addEventListener("beforeunload", saveNow);
window.addEventListener("pointerup", endResize);
window.addEventListener("blur", endResize);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveNow();
});

bridge.loadStore().then((payload) => {
  store = shared.normalizeStore(payload.store || payload);
  runtime = payload.runtime || runtime;
  render(true);
});
