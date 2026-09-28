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
  modalEl = createMockElement();
  contentEl = createMockElement();
  constructor(app: unknown) {
    this.app = app;
  }
  /** Obsidian 처럼 닫으면 onClose 를 부른다 — 단추로 닫든 Esc 로 닫든. */
  close() {
    (this as { onClose?: () => void }).onClose?.();
  }
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

export class ButtonComponent {
  constructor(_containerEl: unknown) {}
  setButtonText() {
    return this;
  }
  setCta() {
    return this;
  }
  setWarning() {
    return this;
  }
  onClick() {
    return this;
  }
}

/**
 * Obsidian(1.13.7) 처럼 첫 자식을 떼고 그 아이콘의 svg 를 붙인다 — Lucide 아이콘은 `svg-icon lucide-<id>` 다.
 * 시험은 어느 아이콘인지를 이 class 로 본다. 앱에 없는 id 를 가려내지는 않는다 — 실제 앱에서 본다.
 */
export function setIcon(parent: HTMLElement, iconId: string): void {
  const svg = parent.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `svg-icon lucide-${iconId}`);
  if (parent.firstChild) parent.removeChild(parent.firstChild);
  parent.appendChild(svg);
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
