const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell, globalShortcut, nativeTheme } = require("electron");
const fs = require("fs");
const net = require("net");
const path = require("path");
const shared = require("./shared");

const COMPACT_VISUAL_SIZE = 1;
const PANEL_RADIUS = 26;
const OPEN_SHOW_FALLBACK_MS = 160;
const TRIGGER_EDGE_THICKNESS = 10;
const TRIGGER_DEBUG_PREVIEW_MS = 900;
const CHANNELS = {
  loadStore: "store:load",
  saveStore: "store:save",
  updateSettings: "settings:update",
  expand: "window:expand",
  collapse: "window:collapse",
  toggle: "window:toggle",
  modeApplied: "window:mode-applied",
  setPinned: "window:set-pinned",
  setPanelActive: "panel:set-active",
  resizeStart: "window:resize-start",
  resizeMove: "window:resize-move",
  resizeEnd: "window:resize-end",
  openExternal: "system:open-external"
};

let win;
let singleInstanceServer;
let triggerDebugWin;
let tray;
let store = shared.createDefaultStore();
let storeLoaded = false;
let mode = "compact";
let collapseTimer;
let saveTimer;
let showWindowTimer;
let pendingShowOptions = null;
let mousePollingTimer;
let registeredShortcut = "";
let enteredExpandedPanel = false;
let panelActive = false;
let triggerDebugBoundsKey = "";
let triggerDebugPreviewUntil = 0;
let resizeDragState = null;
let resizeSettingsTimer = null;
let resizePollingTimer = null;
let resizeSafetyTimer = null;
let lastResizeSettingsSentAt = 0;
let shortcutState = { accelerator: shared.DEFAULT_SHORTCUT, display: "Ctrl + Alt + Space", registered: false, message: "未注册" };
const isSelfTest = process.argv.includes("--self-test");
const isCaptureTest = process.argv.includes("--capture-test");
if (isSelfTest || isCaptureTest) {
  app.setPath("userData", path.join(app.getPath("temp"), "peeknote-self-test"));
}
const hasSingleInstanceLock = isSelfTest || isCaptureTest || app.requestSingleInstanceLock();

function singleInstancePipePath() {
  if (process.platform === "win32") return "\\\\.\\pipe\\peeknote-single-instance";
  return path.join(app.getPath("temp"), "peeknote-single-instance.sock");
}

function handleExternalInstanceSignal() {
  if (!win || win.isDestroyed()) {
    pendingShowOptions = { focus: true };
    return;
  }
  setWindowMode("expanded", { focus: true, active: true });
}

function notifyExistingInstance(done = () => {}) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };

  try {
    const client = net.createConnection(singleInstancePipePath(), () => {
      client.end("show");
    });
    client.on("error", finish);
    client.on("close", finish);
    client.setTimeout(250, () => {
      client.destroy();
      finish();
    });
  } catch {
    finish();
  }
}

function acquireAppInstanceGuard() {
  if (isSelfTest || isCaptureTest) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.resume();
      handleExternalInstanceSignal();
    });

    server.on("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        notifyExistingInstance(() => settle(false));
        return;
      }
      settle(true);
    });

    server.listen(singleInstancePipePath(), () => {
      singleInstanceServer = server;
      settle(true);
    });
  });
}

function loginItemOptions(openAtLogin = true) {
  const options = {
    openAtLogin: Boolean(openAtLogin),
    path: process.execPath,
    args: [],
    name: "PeekNote"
  };

  if (!app.isPackaged) {
    options.args = [app.getAppPath()];
  }

  return options;
}

function syncLoginItem(openAtLogin) {
  app.setLoginItemSettings({ openAtLogin: false });
  app.setLoginItemSettings(loginItemOptions(openAtLogin));
}

function refreshLaunchAtLoginSetting() {
  const storedLaunchAtLogin = Boolean(currentSettings().launchAtLogin);
  if (storedLaunchAtLogin) {
    syncLoginItem(true);
  } else {
    app.setLoginItemSettings({ openAtLogin: false });
  }
  store.settings.launchAtLogin = app.getLoginItemSettings(loginItemOptions(true)).openAtLogin;
}

function storePath() {
  return path.join(app.getPath("userData"), "store.json");
}

function loadStoreFromDisk() {
  try {
    const raw = fs.readFileSync(storePath(), "utf8");
    store = shared.normalizeStore(JSON.parse(raw));
  } catch {
    store = shared.createDefaultStore();
  }
  storeLoaded = true;
}

function saveStoreSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStoreNow, 120);
}

function saveStoreNow() {
  if (!storeLoaded) return;
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(shared.normalizeStore(store), null, 2), "utf8");
}

function currentSettings() {
  return shared.normalizeStore(store).settings;
}

function runtimeState() {
  return {
    shortcut: shortcutState,
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  };
}

function targetDisplay() {
  const point = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay();
}

function boundsFor(nextMode) {
  const display = targetDisplay();
  const settings = currentSettings();
  const width = nextMode === "expanded" ? settings.expandedWidth : COMPACT_VISUAL_SIZE;
  const height = nextMode === "expanded" ? settings.expandedHeight : COMPACT_VISUAL_SIZE;
  const x = Math.round(display.bounds.x + (display.bounds.width - width) / 2);
  const y = nextMode === "expanded" ? Math.round(display.bounds.y + settings.topOffset) : display.bounds.y;
  return { x, y, width, height };
}

function compactHotBounds() {
  const display = targetDisplay();
  const settings = currentSettings();
  const width = settings.compactWidth;
  return {
    x: Math.round(display.bounds.x + (display.bounds.width - width) / 2),
    y: display.bounds.y,
    width,
    height: TRIGGER_EDGE_THICKNESS
  };
}

function pointInBounds(point, bounds) {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

function boundsUnion(first, second) {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  const right = Math.max(first.x + first.width, second.x + second.width);
  const bottom = Math.max(first.y + first.height, second.y + second.height);
  return { x, y, width: right - x, height: bottom - y };
}

function boundsKey(bounds) {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
}

function destroyTriggerDebugWindow() {
  triggerDebugBoundsKey = "";
  if (!triggerDebugWin || triggerDebugWin.isDestroyed()) {
    triggerDebugWin = null;
    return;
  }
  triggerDebugWin.close();
  triggerDebugWin = null;
}

function ensureTriggerDebugWindow() {
  if (triggerDebugWin && !triggerDebugWin.isDestroyed()) return triggerDebugWin;

  triggerDebugWin = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  triggerDebugWin.setIgnoreMouseEvents(true, { forward: true });
  triggerDebugWin.setAlwaysOnTop(true, "screen-saver");
  triggerDebugWin.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      .zone {
        width: 100%;
        height: 100%;
        border: 2px solid rgba(255, 72, 72, 0.92);
        background: rgba(255, 72, 72, 0.18);
        box-sizing: border-box;
      }
    </style>
  </head>
  <body><div class="zone"></div></body>
</html>`)
  );
  return triggerDebugWin;
}

function updateTriggerDebugWindow() {
  if (!currentSettings().showTriggerDebug && Date.now() > triggerDebugPreviewUntil) {
    destroyTriggerDebugWindow();
    return;
  }

  const bounds = compactHotBounds();
  const key = boundsKey(bounds);
  const debugWindow = ensureTriggerDebugWindow();
  if (triggerDebugBoundsKey !== key) {
    debugWindow.setBounds(bounds, false);
    triggerDebugBoundsKey = key;
  }
  debugWindow.setAlwaysOnTop(true, "screen-saver");
  if (!debugWindow.isVisible()) debugWindow.showInactive();
  if (typeof debugWindow.moveTop === "function") debugWindow.moveTop();
}

function applyAppearance(nextMode = mode) {
  const settings = currentSettings();
  nativeTheme.themeSource = settings.themeMode;
  if (win && typeof win.setBackgroundMaterial === "function") {
    win.setBackgroundMaterial("none");
  }
}

function clampWindowSize(width, height) {
  return {
    width: Math.round(Math.min(Math.max(width, 460), 1200)),
    height: Math.round(Math.min(Math.max(height, 340), 1200))
  };
}

function clampTopOffset(y) {
  const display = targetDisplay();
  return Math.round(Math.min(Math.max(y - display.bounds.y, 0), 300));
}

function targetWindowOpacity(nextMode = mode) {
  const settings = currentSettings();
  if (nextMode !== "expanded" || settings.visualStyle !== "glass") return 1;
  return Math.min(1, Math.max(0.1, 1.1 - settings.glassOpacity / 100));
}

function applyWindowOpacity(nextMode = mode) {
  if (!win || win.isDestroyed()) return;
  win.setOpacity(targetWindowOpacity(nextMode));
}

function roundedRectShape(width, height, radius = PANEL_RADIUS) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeRadius = Math.max(0, Math.min(Math.round(radius), Math.floor(safeWidth / 2), Math.floor(safeHeight / 2)));
  const rects = [];
  let current = null;

  for (let y = 0; y < safeHeight; y += 1) {
    const cornerY = Math.min(y, safeHeight - 1 - y);
    let inset = 0;
    if (cornerY < safeRadius) {
      const dy = safeRadius - cornerY - 0.5;
      inset = Math.ceil(safeRadius - Math.sqrt(Math.max(0, safeRadius * safeRadius - dy * dy)));
    }
    const rect = {
      x: inset,
      y,
      width: Math.max(1, safeWidth - inset * 2),
      height: 1
    };

    if (current && current.x === rect.x && current.width === rect.width && current.y + current.height === rect.y) {
      current.height += 1;
    } else {
      if (current) rects.push(current);
      current = rect;
    }
  }

  if (current) rects.push(current);
  return rects;
}

function applyWindowShape(nextMode = mode) {
  if (!win || win.isDestroyed() || typeof win.setShape !== "function") return;
  try {
    if (nextMode !== "expanded") {
      win.setShape([]);
      return;
    }
    const bounds = win.getBounds();
    win.setShape(roundedRectShape(bounds.width, bounds.height));
  } catch {
    // setShape is experimental on Windows/Linux; CSS clipping remains the fallback.
  }
}

function revealExpandedWindow(options = {}) {
  clearTimeout(showWindowTimer);
  showWindowTimer = null;
  pendingShowOptions = null;
  if (!win || win.isDestroyed() || mode !== "expanded") return;
  win.setOpacity(targetWindowOpacity("expanded"));
  win.setIgnoreMouseEvents(false);
  win.showInactive();
  if (options.focus) win.focus();
}

function parkCompactWindow() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(showWindowTimer);
  showWindowTimer = null;
  pendingShowOptions = null;
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true, { forward: true });
  if (!win.isVisible()) win.showInactive();
}

function flushResizeSettingsChanged() {
  lastResizeSettingsSentAt = Date.now();
  saveStoreSoon();
  sendSettingsChanged();
}

function syncExpandedSizeFromBounds(bounds, options = {}) {
  const nextSize = clampWindowSize(bounds.width, bounds.height);
  const settings = currentSettings();
  const nextTopOffset = options.syncTopOffset ? clampTopOffset(bounds.y) : settings.topOffset;
  if (
    settings.expandedWidth === nextSize.width &&
    settings.expandedHeight === nextSize.height &&
    settings.topOffset === nextTopOffset
  ) return;
  store = shared.normalizeStore({
    ...store,
    settings: {
      ...settings,
      expandedWidth: nextSize.width,
      expandedHeight: nextSize.height,
      topOffset: nextTopOffset
    }
  });
  const wait = Math.max(0, 80 - (Date.now() - lastResizeSettingsSentAt));
  if (!wait) {
    clearTimeout(resizeSettingsTimer);
    flushResizeSettingsChanged();
    return;
  }
  if (!resizeSettingsTimer) {
    resizeSettingsTimer = setTimeout(() => {
      resizeSettingsTimer = null;
      flushResizeSettingsChanged();
    }, wait);
  }
}

function startResizeDrag(edge) {
  if (!win || win.isDestroyed() || mode !== "expanded") return;
  clearInterval(resizePollingTimer);
  clearTimeout(resizeSafetyTimer);
  resizeDragState = {
    edge: String(edge || ""),
    startPoint: screen.getCursorScreenPoint(),
    startBounds: win.getBounds()
  };
  clearCollapseTimer();
  setPanelActive(true);
  resizePollingTimer = setInterval(() => updateResizeDrag(screen.getCursorScreenPoint()), 16);
  resizeSafetyTimer = setTimeout(endResizeDrag, 15000);
}

function updateResizeDrag(point) {
  if (!win || win.isDestroyed() || !resizeDragState || mode !== "expanded") return;
  const edge = resizeDragState.edge;
  const startBounds = resizeDragState.startBounds;
  const dx = point.x - resizeDragState.startPoint.x;
  const dy = point.y - resizeDragState.startPoint.y;
  let next = { ...startBounds };

  if (edge.includes("right")) next.width = startBounds.width + dx;
  if (edge.includes("left")) {
    next.width = startBounds.width - dx;
    next.x = startBounds.x + dx;
  }
  if (edge.includes("bottom")) next.height = startBounds.height + dy;
  if (edge.includes("top")) {
    next.height = startBounds.height - dy;
    next.y = startBounds.y + dy;
  }

  const size = clampWindowSize(next.width, next.height);
  if (edge.includes("left")) next.x = startBounds.x + startBounds.width - size.width;
  if (edge.includes("top")) next.y = startBounds.y + startBounds.height - size.height;
  next.width = size.width;
  next.height = size.height;

  win.setBounds(next, false);
  applyWindowShape("expanded");
  syncExpandedSizeFromBounds(next, { syncTopOffset: edge.includes("top") });
}

function endResizeDrag() {
  if (resizeDragState && win && !win.isDestroyed()) {
    syncExpandedSizeFromBounds(win.getBounds(), { syncTopOffset: resizeDragState.edge.includes("top") });
  }
  resizeDragState = null;
  clearInterval(resizePollingTimer);
  clearTimeout(resizeSafetyTimer);
  resizePollingTimer = null;
  resizeSafetyTimer = null;
  if (resizeSettingsTimer) {
    clearTimeout(resizeSettingsTimer);
    resizeSettingsTimer = null;
    flushResizeSettingsChanged();
  }
}

function registerConfiguredShortcut() {
  const normalized = shared.normalizeShortcut(currentSettings().shortcut);
  const accelerator = normalized.valid ? normalized.accelerator : shared.DEFAULT_SHORTCUT;

  if (registeredShortcut) {
    globalShortcut.unregister(registeredShortcut);
    registeredShortcut = "";
  }

  let registered = false;
  let message = "";
  try {
    registered = globalShortcut.register(accelerator, () => setWindowMode(mode === "expanded" ? "compact" : "expanded", { focus: true }));
    message = registered ? "已注册" : "快捷键被占用或不可用";
  } catch (error) {
    message = error.message || "快捷键格式无效";
  }

  registeredShortcut = registered ? accelerator : "";
  shortcutState = {
    accelerator,
    display: shared.shortcutDisplay(accelerator),
    registered,
    message
  };
  return shortcutState;
}

function sendSettingsChanged() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("settings:changed", {
    settings: currentSettings(),
    runtime: runtimeState()
  });
}

function setWindowMode(nextMode, options = {}) {
  if (!win || win.isDestroyed()) return;

  const previousMode = mode;
  const wasVisible = win.isVisible();
  mode = nextMode;
  clearCollapseTimer();
  clearTimeout(showWindowTimer);
  showWindowTimer = null;
  pendingShowOptions = null;
  if (nextMode === "expanded" && previousMode !== "expanded") {
    panelActive = Boolean(options.active || options.focus);
  }
  applyAppearance(nextMode);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const nextBounds = boundsFor(nextMode);
  const currentBounds = win.getBounds();
  if (
    currentBounds.x !== nextBounds.x ||
    currentBounds.y !== nextBounds.y ||
    currentBounds.width !== nextBounds.width ||
    currentBounds.height !== nextBounds.height
  ) {
    win.setBounds(nextBounds, false);
  }
  applyWindowShape(nextMode);

  win.webContents.send("window:mode", mode);

  if (nextMode === "expanded") {
    const targetOpacity = targetWindowOpacity(nextMode);
    if (previousMode !== "expanded") enteredExpandedPanel = false;
    if (previousMode !== "expanded" || !wasVisible) {
      win.setOpacity(0);
      pendingShowOptions = { focus: Boolean(options.focus) };
      showWindowTimer = setTimeout(() => {
        revealExpandedWindow(pendingShowOptions || {});
      }, OPEN_SHOW_FALLBACK_MS);
    } else {
      win.setOpacity(targetOpacity);
      revealExpandedWindow({ focus: Boolean(options.focus) });
    }
  } else {
    enteredExpandedPanel = false;
    panelActive = false;
    pendingShowOptions = null;
    parkCompactWindow();
  }

  updateTriggerDebugWindow();
  updateTrayMenu();
}

function scheduleCollapse() {
  if (currentSettings().pinExpanded || panelActive || mode !== "expanded" || collapseTimer) return;
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    setWindowMode("compact");
  }, currentSettings().collapseDelay);
}

function setPanelActive(active = true) {
  if (mode !== "expanded") return;
  panelActive = Boolean(active);
  if (panelActive) clearCollapseTimer();
}

function collapseForExternalIntent() {
  if (currentSettings().pinExpanded || mode !== "expanded") return;
  setWindowMode("compact");
}

function clearCollapseTimer() {
  clearTimeout(collapseTimer);
  collapseTimer = null;
}

function startMousePolling() {
  clearInterval(mousePollingTimer);
  mousePollingTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    updateTriggerDebugWindow();
    const point = screen.getCursorScreenPoint();

    if (mode === "compact") {
      if (pointInBounds(point, compactHotBounds())) setWindowMode("expanded");
      return;
    }

    if (mode === "expanded") {
      if (panelActive) {
        clearCollapseTimer();
        return;
      }

      const panelBounds = win.getBounds();
      const insidePanel = pointInBounds(point, panelBounds);
      const entryBounds = boundsUnion(panelBounds, compactHotBounds());

      if (insidePanel) enteredExpandedPanel = true;

      if (insidePanel || (!enteredExpandedPanel && pointInBounds(point, entryBounds))) {
        clearCollapseTimer();
      } else {
        scheduleCollapse();
      }
    }
  }, 80);
}

function iconImage() {
  const svg = [
    "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>",
    "<rect width='32' height='32' rx='8' fill='#08090b'/>",
    "<path d='M9 17.2l4 4L23.5 10.8' fill='none' stroke='#a7f3d0' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/>",
    "</svg>"
  ].join("");
  return nativeImage.createFromDataURL("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
}

function updateTrayMenu() {
  if (!tray) return;

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: mode === "expanded" ? "收起" : "展开",
        click: () => setWindowMode(mode === "expanded" ? "compact" : "expanded", { focus: true })
      },
      {
        label: "固定展开",
        type: "checkbox",
        checked: currentSettings().pinExpanded,
        click: (item) => setPinned(item.checked)
      },
      { type: "separator" },
      {
        label: "打开数据目录",
        click: () => shell.openPath(app.getPath("userData"))
      },
      {
        label: "退出",
        click: () => app.quit()
      }
    ])
  );
}

function createTray() {
  tray = new Tray(iconImage());
  tray.setToolTip("PeekNote");
  tray.on("click", () => setWindowMode(mode === "expanded" ? "compact" : "expanded", { focus: true }));
  updateTrayMenu();
}

function setPinned(pinned) {
  store.settings = {
    ...currentSettings(),
    pinExpanded: Boolean(pinned)
  };
  saveStoreSoon();
  sendSettingsChanged();
  updateTrayMenu();
}

function createWindow() {
  if (win && !win.isDestroyed()) return win;

  win = new BrowserWindow({
    ...boundsFor("compact"),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.setMenu(null);
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  applyAppearance();
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
  win.on("blur", collapseForExternalIntent);
  win.on("closed", () => {
    win = null;
  });
  win.once("ready-to-show", () => {
    const shouldExpand = pendingShowOptions && pendingShowOptions.focus;
    setWindowMode(shouldExpand ? "expanded" : "compact", pendingShowOptions || {});
    if (isSelfTest) setTimeout(() => app.quit(), 500);
    if (isCaptureTest) {
      setTimeout(async () => {
        fs.rmSync(path.join(app.getPath("temp"), "peeknote-capture-compact.png"), { force: true });
        setWindowMode("expanded");
        setTimeout(async () => {
          const expandedImage = await Promise.race([
            win.capturePage(),
            new Promise((resolve) => setTimeout(() => resolve(null), 2000))
          ]);
          if (expandedImage) {
            fs.writeFileSync(path.join(app.getPath("temp"), "peeknote-capture-expanded.png"), expandedImage.toPNG());
          }
          app.quit();
        }, 500);
      }, 500);
    }
  });
}

function registerIpc() {
  ipcMain.handle(CHANNELS.loadStore, () => ({
    store: shared.normalizeStore(store),
    runtime: runtimeState()
  }));
  ipcMain.handle(CHANNELS.saveStore, (_event, nextStore) => {
    store = shared.normalizeStore(nextStore);
    saveStoreSoon();
    return shared.normalizeStore(store);
  });
  ipcMain.handle(CHANNELS.updateSettings, (_event, settings) => {
    const previousSettings = currentSettings();
    const incomingSettings = settings && typeof settings === "object" ? settings : {};
    store = shared.normalizeStore({
      ...store,
      settings: {
        ...previousSettings,
        ...incomingSettings
      }
    });
    const nextSettings = currentSettings();
    const compactWidthChanged = nextSettings.compactWidth !== previousSettings.compactWidth;
    const boundsChanged =
      nextSettings.expandedWidth !== previousSettings.expandedWidth ||
      nextSettings.expandedHeight !== previousSettings.expandedHeight ||
      nextSettings.topOffset !== previousSettings.topOffset;
    const appearanceChanged =
      nextSettings.themeMode !== previousSettings.themeMode ||
      nextSettings.visualStyle !== previousSettings.visualStyle;
    const opacityChanged =
      nextSettings.glassOpacity !== previousSettings.glassOpacity ||
      nextSettings.visualStyle !== previousSettings.visualStyle;
    const shortcutChanged = nextSettings.shortcut !== previousSettings.shortcut;
    const loginChanged = nextSettings.launchAtLogin !== previousSettings.launchAtLogin;

    if (compactWidthChanged && !nextSettings.showTriggerDebug) {
      triggerDebugPreviewUntil = Date.now() + TRIGGER_DEBUG_PREVIEW_MS;
    }

    if (loginChanged) syncLoginItem(nextSettings.launchAtLogin);
    if (appearanceChanged) applyAppearance();
    if (shortcutChanged) registerConfiguredShortcut();
    saveStoreSoon();
    if (boundsChanged) {
      setWindowMode(mode, { animate: false });
    } else {
      if (opacityChanged) applyWindowOpacity(mode);
      updateTriggerDebugWindow();
    }
    if (
      compactWidthChanged ||
      boundsChanged ||
      appearanceChanged ||
      shortcutChanged ||
      loginChanged ||
      nextSettings.showTriggerDebug !== previousSettings.showTriggerDebug ||
      nextSettings.pinExpanded !== previousSettings.pinExpanded
    ) {
      updateTrayMenu();
    }
    return {
      settings: nextSettings,
      runtime: runtimeState()
    };
  });
  ipcMain.on(CHANNELS.expand, () => setWindowMode("expanded"));
  ipcMain.on(CHANNELS.collapse, collapseForExternalIntent);
  ipcMain.on(CHANNELS.toggle, () => setWindowMode(mode === "expanded" ? "compact" : "expanded", { focus: true }));
  ipcMain.on(CHANNELS.modeApplied, (_event, appliedMode) => {
    if (appliedMode === "expanded" && pendingShowOptions) revealExpandedWindow(pendingShowOptions);
  });
  ipcMain.on(CHANNELS.setPinned, (_event, pinned) => setPinned(pinned));
  ipcMain.on(CHANNELS.setPanelActive, (_event, active) => setPanelActive(active));
  ipcMain.on(CHANNELS.resizeStart, (_event, edge) => startResizeDrag(edge));
  ipcMain.on(CHANNELS.resizeMove, () => updateResizeDrag(screen.getCursorScreenPoint()));
  ipcMain.on(CHANNELS.resizeEnd, endResizeDrag);
  ipcMain.on(CHANNELS.openExternal, (_event, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", handleExternalInstanceSignal);
  app.whenReady().then(async () => {
    const hasAppInstanceGuard = await acquireAppInstanceGuard();
    if (!hasAppInstanceGuard) {
      app.quit();
      return;
    }

    loadStoreFromDisk();
    refreshLaunchAtLoginSetting();
    registerIpc();
    createWindow();
    createTray();
    registerConfiguredShortcut();
    startMousePolling();

    nativeTheme.on("updated", sendSettingsChanged);
    app.on("activate", () => {
      if (!win || win.isDestroyed()) createWindow();
    });
  });
}

app.on("before-quit", saveStoreNow);
app.on("will-quit", () => {
  clearInterval(mousePollingTimer);
  clearInterval(resizePollingTimer);
  clearTimeout(resizeSafetyTimer);
  clearTimeout(resizeSettingsTimer);
  if (singleInstanceServer) {
    singleInstanceServer.close();
    singleInstanceServer = null;
  }
  destroyTriggerDebugWindow();
  globalShortcut.unregisterAll();
});
app.on("window-all-closed", () => {
  // Keep the tray process alive when the floating window is hidden or closed.
});
