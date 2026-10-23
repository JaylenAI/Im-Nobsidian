/**
 * 연결 하나 — 볼트 안 폴더 하나를 Notion 루트 페이지 하나와 맞춘다(ADR-038). 볼트 맨 위가 폴더 `""` 다.
 *
 * 연결마다 상태 DB(`<폴더>/.im-nobsidian/sync.db`) · 오케스트레이터 · 컨트롤러를 따로 둔다. 엔진은 연결 폴더를
 * 볼트처럼 본다 — 경로는 그 폴더 기준이고, 안쪽의 다른 연결 폴더는 올리지도 덮어쓰지도 않는다.
 */
import { Notice, requestUrl, type App } from "obsidian";
import { join } from "node:path";
import sqlJsWasm from "sql.js/dist/sql-wasm-browser.wasm";
import {
  DEFAULT_CONFIG,
  EntryEditor,
  NotionClient,
  STATE_DB_PATH,
  ScopedVaultFS,
  SyncOrchestrator,
  ViewDataProvider,
  getLogger,
  notionIdFromInput,
  type Config,
  type VaultFS,
} from "@im-nobsidian/core";
import { SqlJsStateDB } from "../state/sqljs-state-db.js";
import { previousStateDbClosed } from "../state/state-db-handoff.js";
import { StateDbCopyStaleError, StateDbFile } from "../state/state-db-file.js";
import { ObsidianVaultAdapter } from "../vault-adapter.js";
import { SyncController, type SyncControllerHooks } from "../sync/sync-controller.js";
import type { ImNobsidianSettings } from "../main.js";

/** 엔진이 플러그인에게 받는 것 — 앱 · 알림 · 다시 연결. */
export interface EngineHost {
  readonly app: App;
  readonly manifestName: string;
  /** 이 연결의 컨트롤러가 내보내는 표시 — 플러그인이 패널 · 상태바로 보낸다. */
  hooks(engine: ConnectionEngine): SyncControllerHooks;
  /** 쓸 수 없게 된 사본을 버리고 다시 연다 — 플러그인의 초기화 줄에 선다. */
  reopen(): void;
}

/** 연결 하나를 여는 데 드는 것. */
export interface EngineOptions {
  readonly token: string;
  readonly rootPageId: string;
  readonly settings: ImNobsidianSettings;
  /** 볼트의 연결 폴더 전부 — 이 연결은 안쪽 것을 비켜 간다. */
  readonly connections: readonly string[];
}

export class ConnectionEngine {
  controller: SyncController | null = null;
  stateDb: SqlJsStateDB | null = null;
  /** 상태 DB 파일과 그 잠금 — 닫으면서 푼다({@link close}). */
  stateDbFile: StateDbFile | null = null;
  /** 동기화 엔진이 쓰는 볼트 어댑터 — 그 쓰기의 볼트 이벤트를 가린다. 경로는 볼트 기준이다. */
  syncVault: ObsidianVaultAdapter | null = null;
  viewProvider: ViewDataProvider | null = null;
  entryEditor: EntryEditor | null = null;
  /** 마지막 초기화가 왜 실패했나 — 명령과 패널이 이 이유를 보인다. */
  failure: string | null = null;

  constructor(
    /** 볼트 기준 연결 폴더 — 맨 위면 `""`. */
    readonly folder: string,
    private readonly host: EngineHost,
  ) {}

  /** 화면에 보이는 연결 이름. */
  get label(): string {
    return this.folder === "" ? "볼트" : this.folder;
  }

  /** 상태 DB 파일 — 볼트 기준 상대 경로. */
  get stateDbPath(): string {
    return this.folder === "" ? STATE_DB_PATH : `${this.folder}/${STATE_DB_PATH}`;
  }

  /** 이 연결의 경로 → 볼트 경로. */
  toVault(path: string): string {
    return this.folder === "" ? path : `${this.folder}/${path}`;
  }

  /** 볼트 경로 → 이 연결의 경로. 이 연결 폴더 밖이면 null. */
  toLocal(path: string): string | null {
    if (this.folder === "") return path;
    return path.startsWith(`${this.folder}/`) ? path.slice(this.folder.length + 1) : null;
  }

  /** 상태 DB 를 열고 오케스트레이터 · 컨트롤러를 만든다. 실패하면 던진다 — 연 DB 는 쥔 채로 둔다(닫기는 {@link close}). */
  async open(options: EngineOptions): Promise<void> {
    const { settings } = options;
    const basePath = (this.host.app.vault.adapter as unknown as { basePath: string }).basePath;
    const stateDb = await this.openStateDb(join(basePath, this.stateDbPath));

    // 동기화가 쓰는 어댑터는 따로 둔다 — 그 쓰기의 볼트 이벤트만 가린다. 보기 편집(EntryEditor)은 사용자의 편집이다.
    const vaultAdapter = new ObsidianVaultAdapter(this.host.app.vault);
    this.syncVault = vaultAdapter;

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: {
        token: options.token,
        // 예전 버전은 붙여 넣은 주소를 그대로 적었다 — 연결할 때 ID 로 읽는다(부른 쪽이 읽을 수 있는지 봤다).
        rootPageId: notionIdFromInput(options.rootPageId)!,
        parentMode: "page" as const,
        databases: [],
      },
      sync: {
        ...DEFAULT_CONFIG.sync,
        direction: settings.syncDirection,
        conflictStrategy: settings.conflictStrategy,
        // 플러그인은 늘 삭제를 맞춘다(README 의 deleteSync 설명) — CLI 기본값(false)과 다르다.
        deleteSync: true,
      },
      paths: {
        ...DEFAULT_CONFIG.paths,
        attachments: settings.attachments,
      },
      conversion: {
        ...DEFAULT_CONFIG.conversion,
        ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
      },
    };

    const client = NotionClient.fromConfig(config, obsidianFetch);
    const syncFs = this.scoped(vaultAdapter, options.connections);
    const orchestrator = new SyncOrchestrator(config, stateDb, client, syncFs, obsidianFetch);
    // 동기화 실행은 전부 SyncController 가 담당한다. 플러그인은 Notice/사이드바/상태바 표시만 훅으로 넘긴다.
    this.controller = new SyncController(
      orchestrator,
      this.host.hooks(this),
      settings.syncDirection,
    );
    const viewVault = this.scoped(
      new ObsidianVaultAdapter(this.host.app.vault),
      options.connections,
    );
    this.viewProvider = new ViewDataProvider(viewVault);
    this.entryEditor = new EntryEditor(viewVault);
  }

  /** 이 연결 폴더만 보는 볼트 — 볼트 맨 위이고 안쪽 연결이 없으면 어댑터 그대로(예전과 같다). */
  private scoped(adapter: ObsidianVaultAdapter, connections: readonly string[]): VaultFS {
    const nested = connections.some((c) => c !== this.folder && c.startsWith(this.prefix));
    return this.folder === "" && !nested
      ? adapter
      : new ScopedVaultFS(adapter, this.folder, connections);
  }

  private get prefix(): string {
    return this.folder === "" ? "" : `${this.folder}/`;
  }

  /**
   * 도는 작업을 멈추고 끝나기를 기다린 뒤, 상태 DB 의 남은 쓰기를 마치고 닫고 잠금을 푼다(S-09 · ADR-026). 예전에는
   * 도는 sync 아래에서 닫아, 그 sync 가 닫힌 DB 에 쓰다 실패했다. 쓰기도 기다리지 않아, 같은 파일을 다시 여는 쪽이
   * 옛 기록을 읽을 수 있었다. 못 쓰면 DB 와 잠금을 쥔 채 이유를 던진다 — 다음 초기화가 다시 닫는다.
   *
   * 다른 곳이 파일을 바꿔 쓰지 않은 것이면 다시 해도 쓸 수 없다 — 사본을 버리고 알린다. 다음 초기화가 파일에서
   * 다시 연다.
   */
  async close(): Promise<void> {
    const controller = this.controller;
    const stateDb = this.stateDb;
    const stateDbFile = this.stateDbFile;
    this.controller = null;
    this.stateDb = null;
    this.stateDbFile = null;
    this.viewProvider = null;
    this.entryEditor = null;
    await controller?.shutdown();
    try {
      await stateDb?.close();
    } catch (error) {
      if (!(error instanceof StateDbCopyStaleError) || !stateDb) {
        this.stateDb = stateDb;
        this.stateDbFile = stateDbFile;
        throw error;
      }
      await this.dropStaleCopy(stateDb, error);
    }
    stateDbFile?.release();
  }

  /** 쓸 수 없게 된 사본을 버리고 알린다 — 버린 기록이 있으면 무엇을 잃었는지까지. */
  private async dropStaleCopy(stateDb: SqlJsStateDB, error: StateDbCopyStaleError): Promise<void> {
    const dropped = await stateDb.discard();
    const lost = dropped
      ? " 마지막으로 파일에 쓴 뒤의 동기화 기록은 남지 않았습니다 — 그 사이 올린 노트는 다음 push 가 페이지를 " +
        "새로 만들 수 있습니다."
      : "";
    const message = `Im-Nobsidian${this.noticeTag}: ${error.message} — 이 창의 사본을 버리고 파일에서 다시 엽니다.${lost}`;
    getLogger().warn(message);
    // 잃은 기록이 있으면 사용자가 닫을 때까지 둔다
    new Notice(message, dropped ? 0 : undefined);
  }

  /** 알림 머리에 붙이는 연결 이름 — 볼트 맨 위 연결은 붙이지 않는다(예전 문구 그대로). */
  get noticeTag(): string {
    return this.folder === "" ? "" : ` [${this.folder}]`;
  }

  /**
   * 상태 DB 를 연다 — 잠금을 잡고(ADR-026) 파일을 읽는다. 잠금은 닫으면서 푼다.
   *
   * 플러그인을 다시 불러왔으면 옛 인스턴스가 DB 를 다 닫고 잠금을 푼 뒤에 잡는다 — 먼저 잡으면 그 잠금에 막히고,
   * 먼저 읽으면 옛 인스턴스의 마지막 기록이 빠진 DB 를 연다.
   */
  private async openStateDb(path: string): Promise<SqlJsStateDB> {
    await previousStateDbClosed();
    const stateDbFile = StateDbFile.acquire(path, this.host.manifestName);
    let stateDb: SqlJsStateDB;
    try {
      stateDb = await SqlJsStateDB.open(
        await this.readStateDbFile(),
        // 한 번에 갈아 끼운다 — 쓰는 도중에 Obsidian 이 죽어도 파일이 잘리지 않는다.
        (data: Uint8Array) => this.writeStateDb(stateDbFile, data),
        // SQLite 엔진 — 빌드가 main.js 에 싣는다(ADR-031). 디렉터리 설치는 main.js · manifest.json · styles.css
        // 세 파일만 받으므로 플러그인 폴더의 네 번째 파일을 읽지 않는다.
        sqlJsWasm,
      );
    } catch (error) {
      stateDbFile.release();
      throw error;
    }
    this.stateDb = stateDb;
    this.stateDbFile = stateDbFile;
    return stateDb;
  }

  /**
   * 사본을 파일에 쓴다. 다른 곳이 파일을 바꿔 쓰지 않았으면 초기화를 다시 한다 — 닫으면서 사본을 버리고 파일에서
   * 다시 연다({@link close}). 낡은 사본으로 이어 가면 다른 곳이 받아 온 노트를 새 노트로 보고 또 올린다.
   */
  private async writeStateDb(stateDbFile: StateDbFile, data: Uint8Array): Promise<void> {
    try {
      await stateDbFile.write(data);
    } catch (error) {
      // 닫는 중에 쓴 것이면(이미 내려놓은 파일) 닫는 쪽이 사본을 버린다
      if (error instanceof StateDbCopyStaleError && this.stateDbFile === stateDbFile) {
        this.host.reopen();
      }
      throw error;
    }
  }

  /**
   * 상태 DB 파일을 읽는다 — 파일이 없으면(처음) null. 읽지 못하면 이유를 던진다 — 예전에는 «처음» 으로 보고 빈
   * DB 를 열어, 다음 쓰기가 파일의 동기화 기록 전체를 덮었다. 기록이 없으면 다음 push 가 모든 노트의 페이지를
   * 또 만든다.
   */
  private async readStateDbFile(): Promise<Uint8Array | null> {
    const adapter = this.host.app.vault.adapter;
    const path = this.stateDbPath;
    try {
      if (!(await adapter.exists(path))) return null;
      return new Uint8Array(await adapter.readBinary(path));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`상태 DB 를 읽지 못함 (${path}): ${message}`);
    }
  }
}

/** Notion SDK 의 fetch 를 Obsidian 의 requestUrl 로 — 앱의 CORS 제한을 비켜 간다. */
export function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? "GET";
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  }

  let body: string | ArrayBuffer | undefined;
  if (init?.body) {
    body = typeof init.body === "string" ? init.body : (init.body as ArrayBuffer);
  }

  return requestUrl({ url, method, headers, body, throw: false }).then((resp) => {
    const contentType = (
      resp.headers["content-type"] ??
      resp.headers["Content-Type"] ??
      ""
    ).toLowerCase();
    if (contentType.includes("application/json") || contentType.includes("text/")) {
      return new Response(JSON.stringify(resp.json), {
        status: resp.status,
        headers: new Headers(resp.headers),
      });
    }
    return new Response(resp.arrayBuffer, {
      status: resp.status,
      headers: new Headers(resp.headers),
    });
  });
}
