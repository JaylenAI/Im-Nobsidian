export class Plugin {
  app: unknown = {};
  loadData() {
    return Promise.resolve(null);
  }
  saveData() {
    return Promise.resolve();
  }
  addSettingTab() {}
  addCommand() {}
  addRibbonIcon() {}
  registerView() {}
  registerMarkdownCodeBlockProcessor() {}
  addStatusBarItem() {
    return { setText: () => {} };
  }
  registerEvent() {}
}

function createMockElement(): Record<string, unknown> {
  const el: Record<string, unknown> = {};
  el.empty = () => {};
  el.addClass = () => {};
  el.createEl = () => createMockElement();
  el.createDiv = () => createMockElement();
  el.createSpan = () => createMockElement();
  el.setText = () => {};
  return el;
}

export class Modal {
  app: unknown;
  contentEl = createMockElement();
  constructor(app: unknown) {
    this.app = app;
  }
  close() {}
  open() {}
}

export class ItemView {
  contentEl = {
    empty: () => {},
    addClass: () => {},
  };
  leaf: unknown;
  constructor(leaf: unknown) {
    this.leaf = leaf;
  }
  getViewType() {
    return "";
  }
  getDisplayText() {
    return "";
  }
  getIcon() {
    return "";
  }
}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = { empty: () => {} };
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {
  constructor(_el: unknown) {}
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  setHeading() {
    return this;
  }
  addText(cb: (t: unknown) => void) {
    cb({
      setPlaceholder: () => ({
        setValue: () => ({ onChange: () => ({ inputEl: { type: "text" } }) }),
      }),
      setValue: () => ({ onChange: () => ({ inputEl: { type: "text" } }) }),
      onChange: () => ({ inputEl: { type: "text" } }),
      inputEl: { type: "text" },
    });
    return this;
  }
  addDropdown(cb: (d: unknown) => void) {
    cb({
      addOption: function () {
        return this;
      },
      setValue: function () {
        return this;
      },
      onChange: function () {
        return this;
      },
    });
    return this;
  }
  addToggle(cb: (t: unknown) => void) {
    cb({
      setValue: function () {
        return this;
      },
      onChange: function () {
        return this;
      },
    });
    return this;
  }
  addButton(cb: (b: unknown) => void) {
    cb({
      setButtonText: function () {
        return this;
      },
      setCta: function () {
        return this;
      },
      onClick: function () {
        return this;
      },
    });
    return this;
  }
}

export class TFile {
  path = "";
  name = "";
  extension = "";
  stat = { mtime: 0, size: 0, ctime: 0 };
}

export class TFolder {
  path = "";
  name = "";
  children: unknown[] = [];
}

export class MarkdownRenderChild {
  constructor(_el: unknown) {}
}

export class Notice {
  constructor(_msg: string) {}
}

export class WorkspaceLeaf {}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function requestUrl() {
  return Promise.resolve({
    status: 200,
    json: {},
    headers: { "content-type": "application/json" },
    arrayBuffer: new ArrayBuffer(0),
  });
}
