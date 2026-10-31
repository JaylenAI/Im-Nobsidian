/**
 * 모바일 앱처럼 — Node(`require` · `Buffer` · `process`)가 없는 곳에서 빌드한 main.js 를 띄운다(P11). Obsidian 은
 * 플러그인 코드를 `(require, module, exports)` 로 감싸 부르고, 그 `require` 는 `obsidian` · `@codemirror/*` 만 준다.
 *
 * 볼트는 메모리 — 노트 API(`Vault`)와 어댑터(`DataAdapter`)가 같은 파일을 본다. Notion 은 `requestUrl` 로 부른다
 * (부르는 쪽이 준다).
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}
export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

/** 플러그인이 쓰는 Obsidian 의 것 — 모바일이 주는 것과 같은 이름. */
function obsidianModule(requestUrl: (param: RequestUrlParam) => Promise<RequestUrlResponse>) {
  class TAbstractFile {
    vault: unknown;
    parent: TFolder | null = null;
    constructor(public path: string) {}
    get name(): string {
      return this.path.slice(this.path.lastIndexOf("/") + 1);
    }
  }
  class TFile extends TAbstractFile {
    stat = { ctime: 0, mtime: 0, size: 0 };
    get extension(): string {
      const dot = this.name.lastIndexOf(".");
      return dot < 0 ? "" : this.name.slice(dot + 1);
    }
    get basename(): string {
      const dot = this.name.lastIndexOf(".");
      return dot < 0 ? this.name : this.name.slice(0, dot);
    }
  }
  class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
    isRoot(): boolean {
      return this.path === "";
    }
  }
  const element = (): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_target, key) => (key === "then" ? undefined : (..._args: unknown[]) => element()),
      },
    );
  class Component {
    load() {}
    unload() {}
    addChild<T>(child: T) {
      return child;
    }
    register() {}
    registerEvent() {}
    registerInterval(id: number) {
      return id;
    }
    registerDomEvent(target: EventTarget, type: string, listener: (event: Event) => void) {
      target.addEventListener(type, listener);
    }
  }
  const stored: { data: unknown } = { data: null };
  class Plugin extends Component {
    constructor(
      public app: MobileApp,
      public manifest: { id: string; name: string; version: string; dir: string },
    ) {
      super();
    }
    // data.json — 다시 불러와도 남는다
    loadData() {
      return Promise.resolve(structuredClone(stored.data));
    }
    saveData(data: unknown) {
      stored.data = structuredClone(data);
      return Promise.resolve();
    }
    addSettingTab() {}
    addCommand() {}
    addRibbonIcon() {
      return element();
    }
    registerView() {}
    registerMarkdownCodeBlockProcessor() {}
    registerMarkdownPostProcessor() {}
    registerEditorExtension() {}
    addStatusBarItem() {
      return element();
    }
  }
  const notices: string[] = [];
  class Notice {
    constructor(message: string | DocumentFragment) {
      notices.push(String(message));
    }
    setMessage() {
      return this;
    }
    hide() {}
  }
  class Modal extends Component {
    contentEl = element();
    titleEl = element();
    constructor(public app: unknown) {
      super();
    }
    open() {}
    close() {}
  }
  class PluginSettingTab {
    containerEl = element();
    constructor(
      public app: unknown,
      public plugin: unknown,
    ) {}
  }
  class ItemView extends Component {
    containerEl = element();
    contentEl = element();
    constructor(public leaf: unknown) {
      super();
    }
  }
  class MarkdownRenderChild extends Component {
    constructor(public containerEl: unknown) {
      super();
    }
  }
  const builder = (): unknown =>
    new Proxy(function () {}, {
      get: (_target, key) => (key === "then" ? undefined : () => builder()),
      apply: () => builder(),
    });
  return {
    notices,
    module: {
      Platform: {
        isDesktop: false,
        isMobile: true,
        isDesktopApp: false,
        isMobileApp: true,
        isIosApp: true,
        isAndroidApp: false,
      },
      Plugin,
      Notice,
      Modal,
      PluginSettingTab,
      ItemView,
      MarkdownRenderChild,
      Setting: class {
        constructor() {
          return builder();
        }
      },
      ButtonComponent: class {
        constructor() {
          return builder();
        }
      },
      SecretComponent: class {
        constructor() {
          return builder();
        }
      },
      TAbstractFile,
      TFile,
      TFolder,
      setIcon() {},
      normalizePath: (path: string) =>
        path
          .replace(/\\/g, "/")
          .replace(/\/+/g, "/")
          .replace(/^\/|\/$/g, ""),
      requestUrl,
      requireApiVersion: () => true,
      editorLivePreviewField: nodeRequire("@codemirror/state").StateField.define({
        create: () => true,
        update: (value: boolean) => value,
      }),
    },
  };
}

type Listener = (...args: unknown[]) => void;
type ObsidianModule = ReturnType<typeof obsidianModule>["module"];

/** 메모리 볼트 — 노트 API 와 어댑터가 한 저장소를 본다. 경로는 볼트 기준(앞 `/` 없음). */
export class MemoryVault {
  readonly files = new Map<string, { data: Uint8Array; mtime: number }>();
  readonly folders = new Set<string>([""]);
  private readonly listeners = new Map<string, Set<Listener>>();
  private clock = 1_700_000_000_000;

  constructor(private readonly obsidian: ObsidianModule) {}

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private ensureParents(path: string): void {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  write(path: string, data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.ensureParents(path);
    const existed = this.files.has(path);
    this.files.set(path, { data: bytes, mtime: this.tick() });
    const file = this.fileObject(path);
    this.emit(existed ? "modify" : "create", file);
  }

  text(path: string): string | undefined {
    const entry = this.files.get(path);
    return entry ? new TextDecoder().decode(entry.data) : undefined;
  }

  private fileObject(path: string) {
    const entry = this.files.get(path)!;
    const file = new this.obsidian.TFile(path);
    file.stat = { ctime: entry.mtime, mtime: entry.mtime, size: entry.data.byteLength };
    return file;
  }

  private folderObject(path: string) {
    const folder = new this.obsidian.TFolder(path);
    folder.children = this.childrenOf(path).map((child) =>
      this.files.has(child) ? this.fileObject(child) : new this.obsidian.TFolder(child),
    );
    return folder;
  }

  private childrenOf(folder: string): string[] {
    const prefix = folder === "" ? "" : `${folder}/`;
    const all = [...this.files.keys(), ...this.folders];
    return [
      ...new Set(
        all.filter(
          (path) =>
            path !== "" && path.startsWith(prefix) && !path.slice(prefix.length).includes("/"),
        ),
      ),
    ];
  }

  private remove(path: string): void {
    if (this.files.delete(path)) return;
    for (const key of [...this.files.keys()])
      if (key.startsWith(`${path}/`)) this.files.delete(key);
    for (const key of [...this.folders])
      if (key === path || key.startsWith(`${path}/`)) this.folders.delete(key);
  }

  private move(from: string, to: string): void {
    const entry = this.files.get(from);
    if (entry) {
      this.files.delete(from);
      this.ensureParents(to);
      this.files.set(to, entry);
      return;
    }
    for (const [key, value] of [...this.files]) {
      if (key.startsWith(`${from}/`)) {
        this.files.delete(key);
        this.files.set(`${to}${key.slice(from.length)}`, value);
      }
    }
    for (const key of [...this.folders]) {
      if (key === from || key.startsWith(`${from}/`)) {
        this.folders.delete(key);
        this.folders.add(`${to}${key.slice(from.length)}`);
      }
    }
    this.ensureParents(`${to}/x`);
  }

  /** 모바일 어댑터 — 경로가 없으면 던지는 것 · 이름 바꾸기 대상이 있으면 던지는 것까지 데스크톱 앱과 같게. */
  readonly adapter = {
    getName: () => "memory",
    exists: async (path: string) => this.files.has(path) || this.folders.has(path),
    stat: async (path: string) => {
      const entry = this.files.get(path);
      if (entry)
        return {
          type: "file",
          ctime: entry.mtime,
          mtime: entry.mtime,
          size: entry.data.byteLength,
        };
      return this.folders.has(path) ? { type: "folder", ctime: 0, mtime: 0, size: 0 } : null;
    },
    list: async (path: string) => {
      const folder = path === "/" ? "" : path;
      if (!this.folders.has(folder)) throw new Error(`ENOENT: ${path}`);
      const children = this.childrenOf(folder);
      return {
        files: children.filter((child) => this.files.has(child)),
        folders: children.filter((child) => this.folders.has(child)),
      };
    },
    read: async (path: string) => {
      const text = this.text(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    readBinary: async (path: string) => {
      const entry = this.files.get(path);
      if (!entry) throw new Error(`ENOENT: ${path}`);
      return entry.data.slice().buffer;
    },
    write: async (path: string, data: string) => this.write(path, data),
    writeBinary: async (path: string, data: ArrayBuffer) => this.write(path, new Uint8Array(data)),
    mkdir: async (path: string) => {
      this.ensureParents(`${path}/x`);
    },
    remove: async (path: string) => {
      if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`);
      this.files.delete(path);
    },
    rmdir: async (path: string) => this.remove(path),
    rename: async (from: string, to: string) => {
      if (this.files.has(to) || this.folders.has(to))
        throw new Error(`Destination file already exists: ${to}`);
      this.move(from, to);
    },
  };

  readonly vault = {
    adapter: this.adapter,
    getName: () => "mobile-vault",
    configDir: ".obsidian",
    on: (event: string, listener: Listener) => {
      const set = this.listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(event, set);
      return { event, listener };
    },
    offref: () => {},
    getRoot: () => this.folderObject(""),
    getAbstractFileByPath: (path: string) =>
      this.files.has(path)
        ? this.fileObject(path)
        : this.folders.has(path)
          ? this.folderObject(path)
          : null,
    getFileByPath: (path: string) => (this.files.has(path) ? this.fileObject(path) : null),
    getFolderByPath: (path: string) => (this.folders.has(path) ? this.folderObject(path) : null),
    getFiles: () =>
      [...this.files.keys()]
        .filter((path) => !path.split("/").some((part) => part.startsWith(".")))
        .map((path) => this.fileObject(path)),
    getMarkdownFiles: () => this.vault.getFiles().filter((file) => file.extension === "md"),
    getAllLoadedFiles: () => this.vault.getFiles(),
    read: async (file: { path: string }) => this.adapter.read(file.path),
    cachedRead: async (file: { path: string }) => this.adapter.read(file.path),
    readBinary: async (file: { path: string }) => this.adapter.readBinary(file.path),
    create: async (path: string, data: string) => {
      if (this.files.has(path)) throw new Error("File already exists.");
      this.write(path, data);
      return this.fileObject(path);
    },
    createBinary: async (path: string, data: ArrayBuffer) => {
      if (this.files.has(path)) throw new Error("File already exists.");
      this.write(path, new Uint8Array(data));
      return this.fileObject(path);
    },
    createFolder: async (path: string) => {
      if (this.folders.has(path)) throw new Error("Folder already exists.");
      this.ensureParents(`${path}/x`);
      return this.folderObject(path);
    },
    modify: async (file: { path: string }, data: string) => this.write(file.path, data),
    modifyBinary: async (file: { path: string }, data: ArrayBuffer) =>
      this.write(file.path, new Uint8Array(data)),
    process: async (file: { path: string }, fn: (data: string) => string) => {
      const next = fn((await this.adapter.read(file.path)) ?? "");
      this.write(file.path, next);
      return next;
    },
    rename: async (file: { path: string }, to: string) => {
      if (this.files.has(to) || this.folders.has(to))
        throw new Error("Destination file already exists!");
      const from = file.path;
      this.move(from, to);
      this.emit("rename", this.vault.getAbstractFileByPath(to), from);
    },
    delete: async (file: { path: string }) => {
      const object = this.vault.getAbstractFileByPath(file.path);
      this.remove(file.path);
      this.emit("delete", object);
    },
    trash: async (file: { path: string }) => this.vault.delete(file),
  };
}

export interface MobileApp {
  vault: MemoryVault["vault"];
  workspace: Record<string, unknown>;
  secretStorage: {
    getSecret(id: string): string | null;
    setSecret(id: string, value: string): void;
  };
  fileManager: Record<string, unknown>;
  metadataCache: Record<string, unknown>;
}

export type MobilePlugin = {
  onload(): Promise<void>;
  onunload(): void;
  settings: Record<string, unknown>;
  saveData(data: unknown): Promise<void>;
} & Record<string, unknown>;

/**
 * 모바일 앱 한 창 — Node 없는 전역 · Obsidian 모듈 · 메모리 볼트 · 이 기기의 키체인. `load` 는 빌드한 main.js 를 이 창에서
 * 평가해 플러그인을 만든다 — 다시 부르면 다시 불러오기(업데이트 · 끄고 켜기)와 같다. `onload` 는 부르는 쪽이 부른다.
 */
export interface MobileWorld {
  vault: MemoryVault;
  notices: string[];
  /** main.js 를 평가하는 전역 — Node 의 것이 없는지 본다. */
  context: vm.Context;
  /** 다른 앱으로 넘어간 것처럼 — 문서를 가렸다는 알림을 낸다. */
  hide(): void;
  load(mainJs: string, data?: unknown): Promise<MobilePlugin>;
}

export function mobileWorld(
  requestUrl: (param: RequestUrlParam) => Promise<RequestUrlResponse>,
  secrets: Record<string, string> = {},
): MobileWorld {
  const { module: obsidian, notices } = obsidianModule(requestUrl);
  const vault = new MemoryVault(obsidian);
  // WebView 에 있는 것만 — require · Buffer · process · global 은 없다
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    DOMException,
    Event,
    EventTarget,
    Blob,
    Headers,
    Request,
    Response,
    FormData,
    WebAssembly,
    crypto: webcrypto,
    performance,
    atob,
    btoa,
    navigator: { userAgent: "Mozilla/5.0 (iPhone) Mobile Obsidian" },
    // 앱이 보이는지 — 시험이 `hide()` 로 가린다
    document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
  });
  vm.runInContext("globalThis.window = globalThis; globalThis.self = globalThis;", context);
  const pluginRequire = (id: string): unknown => {
    if (id === "obsidian") return obsidian;
    if (id.startsWith("@codemirror/")) return nodeRequire(id);
    throw new Error(`모바일 Obsidian 은 ${id} 를 주지 않는다`);
  };
  const keychain = new Map(Object.entries(secrets));
  const app: MobileApp = {
    vault: vault.vault,
    workspace: {
      on: () => ({}),
      onLayoutReady: (callback: () => void) => callback(),
      getLeavesOfType: () => [],
      getActiveFile: () => null,
      getLeaf: () => ({ setViewState: async () => {}, openFile: async () => {} }),
      getLeftLeaf: () => null,
      getRightLeaf: () => null,
      revealLeaf: async () => {},
      trigger: () => {},
    },
    secretStorage: {
      getSecret: (id) => keychain.get(id) ?? null,
      setSecret: (id, value) => void keychain.set(id, value),
    },
    fileManager: {},
    metadataCache: { on: () => ({}), getFileCache: () => null },
  };
  return {
    vault,
    notices,
    context,
    hide() {
      const document = context.document as EventTarget & { visibilityState: string };
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      document.visibilityState = "visible";
    },
    async load(mainJs, data) {
      const module = { exports: {} as Record<string, unknown> };
      const wrapped = vm.runInContext(
        `(function (require, module, exports) {${mainJs}\n})`,
        context,
        { filename: "main.js" },
      ) as (req: typeof pluginRequire, mod: typeof module, exp: unknown) => void;
      wrapped(pluginRequire, module, module.exports);
      const PluginClass = (module.exports.default ?? module.exports) as new (
        app: MobileApp,
        manifest: unknown,
      ) => MobilePlugin;
      const plugin = new PluginClass(app, {
        id: "im-nobsidian",
        name: "Im-Nobsidian",
        version: "0.0.0",
        dir: ".obsidian/plugins/im-nobsidian",
      });
      if (data !== undefined) await plugin.saveData(data);
      return plugin;
    },
  };
}

export const builtMainJs = (): string =>
  readFileSync(new URL("../../main.js", import.meta.url), "utf-8");
