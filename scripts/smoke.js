const assert = require("assert");
const fs = require("fs");
const path = require("path");
const shared = require("../src/shared");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "package.json",
  "src/main.js",
  "src/preload.js",
  "src/index.html",
  "src/styles.css",
  "src/renderer.js",
  "src/shared.js"
];

for (const file of requiredFiles) {
  assert.ok(fs.existsSync(path.join(root, file)), `${file} should exist`);
}

const store = shared.normalizeStore({
  version: 3,
  tabs: [{ id: "a", text: "# Demo\n\n- [ ] one", createdAt: "2026-05-20T00:00:00.000Z" }],
  activeTabId: "a",
  settings: {
    compactWidth: 999,
    expandedWidth: 9999,
    expandedHeight: 9999,
    topOffset: 999,
    glassOpacity: 999,
    showTriggerDebug: true,
    themeMode: "light",
    visualStyle: "glass",
    shortcut: "Ctrl+Shift+K"
  }
});

assert.equal(shared.activeTab(store).id, "a");
shared.activeTab(store).text = "# Changed";
assert.equal(store.tabs[0].text, "# Changed");
assert.equal(shared.titleFromText("# Demo"), "Demo");
assert.equal(store.settings.compactWidth, 800);
assert.equal(store.settings.expandedWidth, 1200);
assert.equal(store.settings.expandedHeight, 1200);
assert.equal(store.settings.topOffset, 300);
assert.equal(store.settings.glassOpacity, 50);
assert.equal(store.settings.showTriggerDebug, true);
assert.equal(store.settings.themeMode, "light");
assert.equal(store.settings.shortcut, "CommandOrControl+Shift+K");
assert.equal(shared.shortcutDisplay(store.settings.shortcut), "Ctrl + Shift + K");
assert.deepEqual(shared.extractTaskLines("- [ ] one\n- [x] two").map((task) => task.checked), [false, true]);
assert.equal(shared.toggleTaskLine("- [ ] one", 0, true), "- [x] one");

const rendered = shared.renderMarkdown("# Title\n\n1. first\n2. second\n\n- [x] **done**\n\n> quote\n\n---\n\n```\ncode\n```\n\n![alt](data:image/png;base64,abc)");
assert.ok(rendered.includes("<h1>Title</h1>"));
assert.ok(rendered.includes("<ol>"));
assert.ok(rendered.includes("<li>first</li>"));
assert.ok(rendered.includes("<strong>done</strong>"));
assert.ok(rendered.includes("<blockquote>quote</blockquote>"));
assert.ok(rendered.includes("<hr>"));
assert.ok(rendered.includes("<pre><code>code</code></pre>"));
assert.ok(rendered.includes("md-image"));

const lowOpacitySettings = shared.normalizeSettings({ glassOpacity: -10 });
assert.equal(lowOpacitySettings.glassOpacity, 10);

console.log("smoke ok");
