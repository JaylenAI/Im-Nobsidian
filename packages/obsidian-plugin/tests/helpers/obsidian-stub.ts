import { StateField } from "@codemirror/state";

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
  registerMarkdownPostProcessor() {}
  registerEditorExtension() {}
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

/**
 * 설정 줄 — 시험이 이름 · 설명 · 고르개를 읽고, 사용자가 바꾼 것처럼 부를 수 있게 적어 둔다.
 * `Setting.rows` 는 만든 차례대로 쌓인다 — 시험이 비운다.
 */
export class Setting {
  static rows: Setting[] = [];
  name = "";
  desc = "";
  heading = false;
  controls: StubControl[] = [];
  descEl = {
    classes: new Set<string>(),
    toggleClass(cls: string, on: boolean) {
      if (on) this.classes.add(cls);
      else this.classes.delete(cls);
    },
  };
  constructor(_el: unknown) {
    Setting.rows.push(this);
  }
  setName(name: string) {
    this.name = name;
    return this;
  }
  setDesc(desc: string) {
    this.desc = desc;
    return this;
  }
  setHeading() {
    this.heading = true;
    return this;
  }
  addText(cb: (t: StubControl) => void) {
    return this.add("text", cb);
  }
  addTextArea(cb: (t: StubControl) => void) {
    return this.add("textarea", cb);
  }
  addDropdown(cb: (d: StubControl) => void) {
    return this.add("dropdown", cb);
  }
  addToggle(cb: (t: StubControl) => void) {
    return this.add("toggle", cb);
  }
  addButton(cb: (b: StubControl) => void) {
    return this.add("button", cb);
  }
  addComponent(cb: (el: unknown) => StubControl) {
    this.controls.push(cb(createMockElement()));
    return this;
  }
  private add(kind: string, cb: (c: StubControl) => void) {
    const control = new StubControl(kind);
    cb(control);
    this.controls.push(control);
    return this;
  }
}

/** 고르개 하나 — 값 · 고를 수 있는 것 · 바뀜 처리를 적어 둔다. */
export class StubControl {
  value: unknown = undefined;
  options: [string, string][] = [];
  placeholder = "";
  buttonText = "";
  disabled = false;
  inputEl = { type: "text" };
  private handler: ((value?: unknown) => unknown) | undefined;
  constructor(readonly kind: string) {}
  setValue(value: unknown) {
    this.value = value;
    return this;
  }
  setPlaceholder(placeholder: string) {
    this.placeholder = placeholder;
    return this;
  }
  addOption(value: string, label: string) {
    this.options.push([value, label]);
    return this;
  }
  onChange(cb: (value?: unknown) => unknown) {
    this.handler = cb;
    return this;
  }
  setButtonText(text: string) {
    this.buttonText = text;
    return this;
  }
  setCta() {
    return this;
  }
  setWarning() {
    return this;
  }
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    return this;
  }
  onClick(cb: () => unknown) {
    this.handler = cb;
    return this;
  }
  /** 사용자가 값을 바꾼 것처럼 — 바뀜 처리가 끝날 때까지 기다린다. */
  async change(value: unknown) {
    this.value = value;
    await this.handler?.(value);
  }
  /** 사용자가 단추를 누른 것처럼. */
  async click() {
    await this.handler?.();
  }
}

/** 키체인 고르개(1.11.1) — 고른 비밀의 «이름» 을 값으로 준다. */
export class SecretComponent extends StubControl {
  constructor(_app: unknown, _containerEl: unknown) {
    super("secret");
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
  /** 띄운 알림 — 시험이 무엇을 알렸는지 본다. */
  static shown: string[] = [];
  constructor(msg: string) {
    Notice.shown.push(msg);
  }
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

/** 편집기가 Live Preview 인가 — Obsidian 이 편집기 상태에 싣는 필드. 시험에서는 켜진 채로 둔다. */
export const editorLivePreviewField = StateField.define<boolean>({
  create: () => true,
  update: (value) => value,
});

export function requireApiVersion(): boolean {
  return true;
}
