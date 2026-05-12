# Obsidian Plugin API 리서치

> 작성일: 2026-05-08
> 최종 수정: 2026-05-08
> 상태: active
> 목적: Im-Nobsidian 양방향 동기화 플러그인 개발을 위한 Obsidian Plugin API 종합 리서치

---

## 1. Plugin Architecture

### Plugin 클래스 구조

모든 Obsidian 플러그인은 `Plugin` 클래스를 상속하여 구현한다.

```typescript
import { Plugin } from "obsidian";

export default class ImNobsidianPlugin extends Plugin {
  settings: ImNobsidianSettings;

  async onload() {
    // 플러그인 활성화 시 호출
    // 커맨드, 이벤트, UI 등 모든 리소스 등록
    await this.loadSettings();
    this.addSettingTab(new ImNobsidianSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "Sync with Notion", () => this.syncNow());
    this.registerEvent(this.app.vault.on("modify", this.onFileModified.bind(this)));
  }

  onunload() {
    // 플러그인 비활성화 시 호출
    // registerEvent, addCommand 등으로 등록한 리소스는 자동 정리
    // 수동 정리가 필요한 리소스만 여기서 처리
  }
}
```

### Lifecycle 메서드

| 메서드                       | 호출 시점                                           | 용도                                                                        |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------- |
| `onload()`                   | 플러그인 활성화 시, 또는 플러그인 업데이트 시       | 리소스 등록, 설정 로드, UI 초기화                                           |
| `onunload()`                 | 플러그인 비활성화 시                                | 수동 정리가 필요한 리소스 해제                                              |
| `onUserEnable()`             | 사용자가 최초로 플러그인을 활성화할 때 (1회만)      | 웰컴 메시지, 초기 데이터 마이그레이션, 기본 설정 생성. v1.7.2에서 추가      |
| `onExternalSettingsChange()` | `data.json`이 외부에서 변경될 때 (Obsidian Sync 등) | 설정 재로드. 주의: 플러그인 폴더명이 `manifest.json`의 `id`와 일치해야 작동 |

### manifest.json 구조

```json
{
  "id": "im-nobsidian",
  "name": "Im-Nobsidian",
  "version": "0.1.0",
  "minAppVersion": "1.5.0",
  "description": "Bidirectional sync between Obsidian and Notion",
  "author": "Im-Nobsidian Team",
  "authorUrl": "https://github.com/im-nobsidian",
  "fundingUrl": "",
  "isDesktopOnly": false
}
```

**필수 필드:**

- `id` — 고유 식별자. `"obsidian"` 문자열을 포함하면 안 됨
- `name` — 표시 이름
- `version` — SemVer 형식 (x.y.z). 릴리스 태그와 정확히 일치해야 함 (v 접두어 없이)
- `minAppVersion` — 최소 요구 Obsidian 버전
- `description` — 플러그인 설명
- `author` — 저자
- `isDesktopOnly` — NodeJS/Electron API 사용 시 `true`

**선택 필드:** `authorUrl`, `fundingUrl`

### 플러그인 로딩/활성화/비활성화

- 플러그인 파일은 `.obsidian/plugins/<plugin-id>/` 디렉토리에 위치
- 필수 파일: `main.js`, `manifest.json`
- 선택 파일: `styles.css`, `data.json` (설정 데이터)
- 사용자가 Community Plugins 설정에서 활성화/비활성화
- `onload()`에서 등록한 모든 리소스(커맨드, 이벤트, UI 요소)는 `onunload()` 시 자동 정리

---

## 2. Vault File System API

### 파일 읽기/쓰기

```typescript
// 파일 읽기
const content = await this.app.vault.read(file); // string 반환
const binary = await this.app.vault.readBinary(file); // ArrayBuffer 반환

// 파일 수정
await this.app.vault.modify(file, newContent); // 전체 내용 교체
await this.app.vault.modifyBinary(file, arrayBuffer); // 바이너리 수정
await this.app.vault.append(file, additionalText); // 내용 추가

// 파일 생성
const newFile = await this.app.vault.create("path/to/file.md", content);
const newBinary = await this.app.vault.createBinary("path/to/image.png", buffer);

// 파일 삭제
await this.app.vault.delete(file); // 영구 삭제
await this.app.vault.trash(file, true); // 시스템 휴지통으로
await this.app.vault.trash(file, false); // .trash 폴더로

// 파일 이동/이름변경
await this.app.vault.rename(file, "new/path/file.md");
await this.app.vault.copy(file, "copy/path/file.md");
```

### vault.process() — Atomic 파일 수정

```typescript
// vault.process()는 읽기+수정을 atomic하게 처리
await this.app.vault.process(file, (content) => {
  // content를 받아서 수정된 content를 반환
  return content.replace("old text", "new text");
});
```

**주의:** `vault.process()`와 `vault.modify()`는 `requestSave` debounce 이벤트가 진행 중이면 작동하지 않는다. 파일 편집 후 약 2초 이내에 호출하면 실패할 수 있다.

### 파일/폴더 검색

```typescript
// 경로로 파일/폴더 가져오기
const abstractFile = this.app.vault.getAbstractFileByPath("folder/note.md");

// TFile인지 TFolder인지 확인
if (abstractFile instanceof TFile) {
  // 파일 처리
}
if (abstractFile instanceof TFolder) {
  // 폴더 처리
}

// 전체 파일 목록
const allFiles: TFile[] = this.app.vault.getFiles();
const mdFiles: TFile[] = this.app.vault.getMarkdownFiles();
```

### TFile / TFolder / TAbstractFile 타입

```typescript
// TAbstractFile (부모 클래스)
interface TAbstractFile {
  vault: Vault;
  path: string; // 볼트 내 상대 경로 (예: "folder/note.md")
  name: string; // 파일/폴더 이름 (예: "note.md")
  parent: TFolder | null;
}

// TFile
interface TFile extends TAbstractFile {
  stat: FileStats; // { ctime, mtime, size }
  basename: string; // 확장자 제외 이름
  extension: string; // 확장자
}

// TFolder
interface TFolder extends TAbstractFile {
  children: TAbstractFile[];
  isRoot(): boolean;
}
```

### Adapter (Raw 파일시스템 접근)

`vault.adapter`를 통해 볼트의 파일 시스템에 직접 접근할 수 있다. 일반적으로는 Vault API를 사용하는 것이 권장되지만, `.obsidian/plugins/` 내부 파일 접근 등 특수한 경우 필요하다.

```typescript
// 파일 읽기/쓰기
const text = await this.app.vault.adapter.read("path/to/file");
await this.app.vault.adapter.write("path/to/file", content);
await this.app.vault.adapter.append("path/to/file", text);

// 존재 여부 확인
const exists = await this.app.vault.adapter.exists("path/to/file");

// 디렉토리 생성
await this.app.vault.adapter.mkdir("path/to/dir");

// 볼트 루트 디렉토리 절대 경로 (데스크톱 전용)
import { FileSystemAdapter } from "obsidian";
if (this.app.vault.adapter instanceof FileSystemAdapter) {
  const basePath = this.app.vault.adapter.getBasePath();
  // 예: "/Users/username/Documents/MyVault"
}
```

**주의:** `adapter.getBasePath()`는 모바일에서 사용 불가. 모바일에서는 `fs` 모듈의 `readFileSync`, `writeFileSync` 등도 사용할 수 없다.

### 파일 변경 이벤트 감시

```typescript
// registerEvent()로 등록하면 플러그인 언로드 시 자동 해제
this.registerEvent(
  this.app.vault.on("create", (file: TAbstractFile) => {
    if (file instanceof TFile) {
      console.log("파일 생성:", file.path);
    }
  }),
);

this.registerEvent(
  this.app.vault.on("modify", (file: TAbstractFile) => {
    if (file instanceof TFile) {
      console.log("파일 수정:", file.path);
    }
  }),
);

this.registerEvent(
  this.app.vault.on("delete", (file: TAbstractFile) => {
    console.log("파일 삭제:", file.path);
  }),
);

this.registerEvent(
  this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
    console.log(`파일 이름 변경: ${oldPath} → ${file.path}`);
  }),
);
```

**중요:** 외부에서 파일을 rename하면 Obsidian은 이를 `delete` + `create` 이벤트 쌍으로 처리한다. 동기화 플러그인 개발 시 이 패턴을 인식하고 처리해야 한다.

---

## 3. Metadata & Frontmatter

### MetadataCache API

`metadataCache`는 볼트 내 모든 마크다운 파일을 사전 파싱하여 인덱싱된 캐시를 유지한다. 파일을 직접 파싱하지 않고도 메타데이터에 빠르게 접근할 수 있다.

```typescript
// 특정 파일의 캐시된 메타데이터 가져오기
const cache: CachedMetadata | null = this.app.metadataCache.getFileCache(file);

if (cache) {
  // frontmatter 접근
  const frontmatter = cache.frontmatter;
  // { tags: [...], date: "2026-05-08", ... }

  // 링크 정보
  const links = cache.links;
  // [{ link: "other-note", displayText: "...", position: {...} }, ...]

  // 제목(heading) 정보
  const headings = cache.headings;
  // [{ heading: "Title", level: 1, position: {...} }, ...]

  // 태그 정보
  const tags = cache.tags;
  // [{ tag: "#project", position: {...} }, ...]
}
```

### CachedMetadata 구조

```typescript
interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  sections?: SectionCache[];
  listItems?: ListItemCache[];
  frontmatter?: FrontMatterCache;
  frontmatterPosition?: Pos; // v1.4.0+에서 분리됨
  frontmatterLinks?: FrontmatterLinkCache[];
  blocks?: Record<string, BlockCache>;
}
```

### processFrontMatter() — Frontmatter 안전 수정

Frontmatter를 수정할 때는 반드시 `fileManager.processFrontMatter()`를 사용해야 한다. 직접 파일 내용을 파싱/수정하면 파일이 손상될 수 있다.

```typescript
// Frontmatter 읽기 + 수정 (atomic)
await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
  // frontmatter 객체를 직접 mutate
  frontmatter["notion-id"] = "abc123";
  frontmatter["notion-last-sync"] = new Date().toISOString();
  frontmatter["tags"] = [...(frontmatter["tags"] || []), "synced"];

  // 키 삭제
  delete frontmatter["old-key"];
});
```

**핵심 장점:**

- YAML 파싱/직렬화를 Obsidian이 처리하므로 포맷 손상 위험 없음
- 캐시 업데이트를 자동으로 트리거
- 동시 수정으로부터 안전 (atomic)

### MetadataCache 이벤트

```typescript
// 파일 메타데이터가 변경되었을 때
this.registerEvent(
  this.app.metadataCache.on("changed", (file: TFile, data: string, cache: CachedMetadata) => {
    // file: 변경된 파일
    // data: 파일의 현재 내용 (string)
    // cache: 새로 파싱된 CachedMetadata
  }),
);

// 모든 파일의 메타데이터 캐시가 완전히 로드되었을 때
this.registerEvent(
  this.app.metadataCache.on("resolved", () => {
    // 초기 로드 후 또는 볼트 전체 재파싱 완료 시
  }),
);
```

**주의:** MetadataCache는 비동기적으로 업데이트된다. 파일을 수정한 직후 캐시를 읽으면 이전 값이 반환될 수 있다. 이벤트 핸들러를 등록하여 변경에 반응하는 것이 권장된다.

---

## 4. Settings & Configuration

### 표준 Settings 패턴

```typescript
// 설정 인터페이스 정의
interface ImNobsidianSettings {
  notionApiKey: string;
  syncIntervalMinutes: number;
  autoSync: boolean;
  syncDirection: "bidirectional" | "obsidian-to-notion" | "notion-to-obsidian";
  conflictResolution: "local-wins" | "remote-wins" | "manual";
  excludedFolders: string[];
  debugMode: boolean;
}

// 기본값 정의
const DEFAULT_SETTINGS: ImNobsidianSettings = {
  notionApiKey: "",
  syncIntervalMinutes: 5,
  autoSync: false,
  syncDirection: "bidirectional",
  conflictResolution: "local-wins",
  excludedFolders: [],
  debugMode: false,
};

// 플러그인에서 사용
export default class ImNobsidianPlugin extends Plugin {
  settings: ImNobsidianSettings;

  async loadSettings() {
    // Object.assign으로 기본값과 저장된 값을 머지
    // 새 설정 키가 추가되어도 기본값이 적용됨
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
```

**`loadData()` / `saveData()`의 동작:**

- `.obsidian/plugins/<plugin-id>/data.json`에 JSON으로 저장/로드
- 디스크에 명시적으로 `loadData()`/`saveData()`를 호출해야만 읽기/쓰기 수행
- `loadData()`가 반환하는 속성이 `DEFAULT_SETTINGS`의 속성을 덮어씀

### PluginSettingTab

```typescript
import { App, PluginSettingTab, Setting } from "obsidian";

class ImNobsidianSettingTab extends PluginSettingTab {
  plugin: ImNobsidianPlugin;

  constructor(app: App, plugin: ImNobsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty(); // 기존 요소 모두 제거

    containerEl.createEl("h2", { text: "Im-Nobsidian Settings" });

    // 텍스트 입력
    new Setting(containerEl)
      .setName("Notion API Key")
      .setDesc("Internal integration token from Notion")
      .addText((text) =>
        text
          .setPlaceholder("ntn_...")
          .setValue(this.plugin.settings.notionApiKey)
          .onChange(async (value) => {
            this.plugin.settings.notionApiKey = value;
            await this.plugin.saveSettings();
          }),
      );

    // 토글
    new Setting(containerEl)
      .setName("Auto Sync")
      .setDesc("Automatically sync on file changes")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );

    // 드롭다운
    new Setting(containerEl)
      .setName("Sync Direction")
      .setDesc("Choose sync direction")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("bidirectional", "Bidirectional")
          .addOption("obsidian-to-notion", "Obsidian → Notion")
          .addOption("notion-to-obsidian", "Notion → Obsidian")
          .setValue(this.plugin.settings.syncDirection)
          .onChange(async (value) => {
            this.plugin.settings.syncDirection = value as ImNobsidianSettings["syncDirection"];
            await this.plugin.saveSettings();
          }),
      );

    // 슬라이더
    new Setting(containerEl)
      .setName("Sync Interval")
      .setDesc("Minutes between auto-sync (1-60)")
      .addSlider((slider) =>
        slider
          .setLimits(1, 60, 1)
          .setValue(this.plugin.settings.syncIntervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalMinutes = value;
            await this.plugin.saveSettings();
          }),
      );

    // 텍스트 영역
    new Setting(containerEl)
      .setName("Excluded Folders")
      .setDesc("Folders to exclude from sync (one per line)")
      .addTextArea((text) =>
        text.setValue(this.plugin.settings.excludedFolders.join("\n")).onChange(async (value) => {
          this.plugin.settings.excludedFolders = value.split("\n").filter((f) => f.trim());
          await this.plugin.saveSettings();
        }),
      );

    // 버튼
    new Setting(containerEl)
      .setName("Sync Now")
      .setDesc("Trigger manual sync")
      .addButton((button) =>
        button
          .setButtonText("Sync")
          .setCta()
          .onClick(async () => {
            await this.plugin.syncNow();
          }),
      );
  }
}
```

### API 토큰 보안 저장

Obsidian v1.11.0+에서 `SecretStorage` API가 도입되었다. OS의 보안 저장소 (macOS Keychain, Windows Credential Manager, Linux libsecret)를 활용한다.

```typescript
// SecretStorage 사용 (v1.11.0+)
// 저장
await this.app.saveLocalStorage("im-nobsidian-api-key", encryptedToken);

// 읽기
const token = await this.app.loadLocalStorage("im-nobsidian-api-key");
```

**현재 상태 (2026년 기준):**

- SecretStorage API (v1.11.4)는 현재 Local Storage에 평문 저장하고 있어 완전히 안전하지는 않음
- 대안 1: `obsidian-secure-store` 플러그인이 AES-256 암호화 제공 (사용자가 별도 설치 필요)
- 대안 2: Electron의 `safeStorage` API로 직접 암호화 (데스크톱 전용)
- **현실적 선택:** 대부분의 기존 플러그인은 `data.json`에 평문 저장. 사용자에게 위험성을 알리고, 가능하면 OAuth 토큰을 사용하여 토큰 로테이션을 지원

---

## 5. UI Components

### StatusBarItem

화면 하단 상태 표시줄에 동기화 상태를 표시할 수 있다.

```typescript
onload() {
  const statusBar = this.addStatusBarItem();
  statusBar.setText('Im-Nobsidian: Ready');
  statusBar.addClass('im-nobsidian-status');

  // 동기화 진행률 표시
  this.updateStatusBar = (status: string) => {
    statusBar.setText(`Im-Nobsidian: ${status}`);
  };
}
```

**참고:** 상태 표시줄은 모바일에서 보이지 않는다.

### Notice (Toast 알림)

```typescript
// 기본 알림 (기본 5초 후 사라짐)
new Notice("Sync completed successfully!");

// 지속 시간 지정 (밀리초)
new Notice("Syncing 42 files...", 10000);

// 0을 전달하면 사용자가 수동으로 닫을 때까지 유지
const persistentNotice = new Notice("Sync in progress...", 0);
// 완료 후 제거
persistentNotice.hide();
```

### Modal (팝업 대화상자)

```typescript
import { App, Modal } from "obsidian";

class ConflictResolutionModal extends Modal {
  result: "local" | "remote" | null = null;
  private resolvePromise: (value: "local" | "remote" | null) => void;

  constructor(
    app: App,
    private filePath: string,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Sync Conflict" });
    contentEl.createEl("p", { text: `Conflict detected in: ${this.filePath}` });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Keep Local")
          .setCta()
          .onClick(() => {
            this.result = "local";
            this.close();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("Keep Remote").onClick(() => {
          this.result = "remote";
          this.close();
        }),
      );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(this.result);
    }
  }

  async waitForResult(): Promise<"local" | "remote" | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }
}

// 사용
const modal = new ConflictResolutionModal(this.app, "conflicted-file.md");
const choice = await modal.waitForResult();
```

### Ribbon Icon (왼쪽 사이드바)

```typescript
onload() {
  this.addRibbonIcon('refresh-cw', 'Sync with Notion', async (evt: MouseEvent) => {
    new Notice('Starting sync...');
    await this.syncNow();
    new Notice('Sync complete!');
  });
}
```

사용 가능한 아이콘은 [Lucide](https://lucide.dev) 아이콘셋 기반이다.

### Custom View (커스텀 패널)

동기화 상태, 히스토리, 충돌 목록 등을 표시하기 위한 커스텀 뷰 패널을 만들 수 있다.

```typescript
import { ItemView, WorkspaceLeaf } from 'obsidian';

const VIEW_TYPE_SYNC_STATUS = 'im-nobsidian-sync-status';

class SyncStatusView extends ItemView {
  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_SYNC_STATUS;
  }

  getDisplayText(): string {
    return 'Im-Nobsidian Sync Status';
  }

  getIcon(): string {
    return 'refresh-cw';
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.createEl('h4', { text: 'Sync Status' });
    // UI 구성...
  }

  async onClose() {
    // 리소스 정리
  }
}

// 플러그인에서 등록
onload() {
  this.registerView(VIEW_TYPE_SYNC_STATUS, (leaf) => new SyncStatusView(leaf));

  // 뷰 열기 커맨드
  this.addCommand({
    id: 'open-sync-status',
    name: 'Open Sync Status',
    callback: () => this.activateView(),
  });
}

async activateView() {
  const { workspace } = this.app;
  let leaf = workspace.getLeavesOfType(VIEW_TYPE_SYNC_STATUS)[0];
  if (!leaf) {
    const newLeaf = workspace.getRightLeaf(false);
    if (newLeaf) {
      await newLeaf.setViewState({ type: VIEW_TYPE_SYNC_STATUS, active: true });
      leaf = newLeaf;
    }
  }
  if (leaf) {
    workspace.revealLeaf(leaf);
  }
}

// 언로드 시 뷰 정리
onunload() {
  this.app.workspace.detachLeavesOfType(VIEW_TYPE_SYNC_STATUS);
}
```

**중요:** 뷰에 대한 참조를 플러그인에서 직접 관리하면 안 된다. Obsidian이 뷰 팩토리 함수를 여러 번 호출할 수 있다.

### Sync Progress 표시 패턴

```typescript
class SyncProgressTracker {
  private statusBar: HTMLElement;
  private notice: Notice | null = null;

  constructor(statusBar: HTMLElement) {
    this.statusBar = statusBar;
  }

  start(totalFiles: number) {
    this.notice = new Notice(`Syncing 0/${totalFiles} files...`, 0);
    this.statusBar.setText("Im-Nobsidian: Syncing...");
  }

  update(current: number, total: number, fileName: string) {
    if (this.notice) {
      this.notice.setMessage(`Syncing ${current}/${total}: ${fileName}`);
    }
    this.statusBar.setText(`Im-Nobsidian: ${current}/${total}`);
  }

  complete(syncedCount: number) {
    if (this.notice) {
      this.notice.hide();
    }
    new Notice(`Sync complete: ${syncedCount} files synced`);
    this.statusBar.setText(`Im-Nobsidian: Last sync ${new Date().toLocaleTimeString()}`);
  }

  error(message: string) {
    if (this.notice) {
      this.notice.hide();
    }
    new Notice(`Sync error: ${message}`, 10000);
    this.statusBar.setText("Im-Nobsidian: Error");
  }
}
```

---

## 6. Commands & Hotkeys

### addCommand() API

```typescript
onload() {
  // 기본 커맨드 (항상 사용 가능)
  this.addCommand({
    id: 'sync-now',
    name: 'Sync now',
    callback: () => {
      this.syncNow();
    },
  });

  // 조건부 커맨드 (checkCallback)
  this.addCommand({
    id: 'sync-current-file',
    name: 'Sync current file to Notion',
    checkCallback: (checking: boolean) => {
      const file = this.app.workspace.getActiveFile();
      if (file && file.extension === 'md') {
        if (!checking) {
          // 실제 실행
          this.syncFile(file);
        }
        return true; // 커맨드 사용 가능
      }
      return false; // 커맨드 팔레트에서 숨김
    },
  });

  // 에디터 커맨드 (에디터가 활성화된 경우에만)
  this.addCommand({
    id: 'insert-notion-link',
    name: 'Insert Notion page link',
    editorCallback: (editor: Editor, view: MarkdownView) => {
      const cursor = editor.getCursor();
      editor.replaceRange('[Notion Link](notion://...)', cursor);
    },
  });

  // 에디터 조건부 커맨드
  this.addCommand({
    id: 'push-selection-to-notion',
    name: 'Push selected text to Notion',
    editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
      const selection = editor.getSelection();
      if (selection.length > 0) {
        if (!checking) {
          this.pushSelectionToNotion(selection);
        }
        return true;
      }
      return false;
    },
  });
}
```

### Callback 유형 비교

| 유형                  | 파라미터                   | 용도                                                     |
| --------------------- | -------------------------- | -------------------------------------------------------- |
| `callback`            | 없음                       | 항상 사용 가능한 단순 커맨드                             |
| `checkCallback`       | `(checking: boolean)`      | 조건부 커맨드. `checking=true`이면 사용 가능 여부만 반환 |
| `editorCallback`      | `(editor, view)`           | 에디터 활성화 시에만 보이는 커맨드                       |
| `editorCheckCallback` | `(checking, editor, view)` | 에디터 활성 + 추가 조건 확인                             |

**핫키 바인딩:**

- 사용자가 Settings > Hotkeys에서 직접 설정
- 플러그인에서 기본 핫키를 지정할 수도 있지만, 충돌을 피하기 위해 권장하지 않음

---

## 7. Events System

### Vault 이벤트

```typescript
// 파일 생성
this.registerEvent(this.app.vault.on("create", (file: TAbstractFile) => {}));

// 파일 수정
this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {}));

// 파일 삭제
this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {}));

// 파일 이름변경/이동
this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {}));
```

### Workspace 이벤트

```typescript
// 활성 파일 변경
this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null) => {}));

// 파일 열기
this.registerEvent(this.app.workspace.on("file-open", (file: TFile | null) => {}));

// 레이아웃 변경
this.registerEvent(this.app.workspace.on("layout-change", () => {}));

// 에디터 변경
this.registerEvent(
  this.app.workspace.on("editor-change", (editor: Editor, info: MarkdownView) => {}),
);
```

### MetadataCache 이벤트

```typescript
// 파일 메타데이터 변경 (파싱 완료)
this.registerEvent(
  this.app.metadataCache.on("changed", (file: TFile, data: string, cache: CachedMetadata) => {}),
);

// 전체 볼트 메타데이터 해결 완료
this.registerEvent(this.app.metadataCache.on("resolved", () => {}));
```

### 이벤트 Debounce 패턴 (동기화용)

파일 변경 이벤트는 매우 빈번하게 발생한다. 동기화 플러그인에서는 반드시 debounce 처리가 필요하다.

```typescript
import { debounce } from 'obsidian';

onload() {
  // Obsidian 내장 debounce 함수 사용
  const debouncedSync = debounce(
    (file: TFile) => {
      this.queueFileForSync(file);
    },
    2000,   // 2초 대기
    true    // resetTimer: 새 호출마다 타이머 리셋
  );

  this.registerEvent(
    this.app.vault.on('modify', (abstractFile) => {
      if (abstractFile instanceof TFile && abstractFile.extension === 'md') {
        debouncedSync(abstractFile);
      }
    })
  );

  // workspace가 준비된 후 이벤트 등록하는 것이 안전
  this.app.workspace.onLayoutReady(() => {
    // 초기 볼트 스캔 등
  });
}
```

**`debounce()` 함수 시그니처:**

```typescript
function debounce<T extends unknown[], V>(
  cb: (...args: [...T]) => V,
  timeout?: number,
  resetTimer?: boolean,
): Debouncer<T, V>;
```

**참고:** Obsidian의 `debounce` 함수는 실제로는 throttle처럼 동작한다는 커뮤니티 보고가 있다. 정확한 debounce가 필요하면 자체 구현을 고려할 것.

### 이벤트 등록/해제

```typescript
// registerEvent()로 등록 → onunload() 시 자동 해제
this.registerEvent(this.app.vault.on("modify", handler));

// registerInterval()로 주기적 작업 → 자동 해제
this.registerInterval(window.setInterval(() => this.periodicSync(), 5 * 60 * 1000));
```

---

## 8. Network & HTTP

### requestUrl() API

Obsidian 내장 HTTP 클라이언트. CORS 제한을 우회한다.

```typescript
import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

// GET 요청
const response: RequestUrlResponse = await requestUrl({
  url: "https://api.notion.com/v1/pages/page-id",
  method: "GET",
  headers: {
    Authorization: "Bearer ntn_xxx",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});
console.log(response.json); // 자동 파싱된 JSON
console.log(response.status); // HTTP 상태 코드
console.log(response.headers); // 응답 헤더

// POST 요청
const createResponse = await requestUrl({
  url: "https://api.notion.com/v1/pages",
  method: "POST",
  headers: {
    Authorization: "Bearer ntn_xxx",
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    parent: { database_id: "db-id" },
    properties: { Name: { title: [{ text: { content: "New Page" } }] } },
  }),
  throw: false, // 4xx/5xx에서 예외 던지지 않기
});
```

### RequestUrlParam / RequestUrlResponse 타입

```typescript
interface RequestUrlParam {
  url: string;
  method?: string; // GET, POST, PUT, PATCH, DELETE 등
  contentType?: string; // Content-Type 헤더 단축 설정
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean; // 기본 true. false면 4xx/5xx에서 예외 안 던짐
}

interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any; // 자동 파싱된 JSON
  text: string; // 응답 텍스트
}

// Promise 확장 타입
interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  arrayBuffer: Promise<ArrayBuffer>;
  json: Promise<any>;
}
```

### fetch()와의 차이점

| 특성      | `requestUrl()`                      | `fetch()`                    |
| --------- | ----------------------------------- | ---------------------------- |
| CORS      | **우회** (Electron의 net 모듈 사용) | CORS 제한 적용               |
| 플랫폼    | 데스크톱 + 모바일 모두 지원         | 모바일에서 CORS 문제 가능    |
| 응답 파싱 | `response.json` 자동 제공           | `await response.json()` 필요 |
| 에러 처리 | `throw: false` 옵션                 | `response.ok` 확인 필요      |
| 스트리밍  | 미지원 (현재)                       | ReadableStream 지원          |

**권장:** Obsidian 플러그인에서는 항상 `requestUrl()`을 사용할 것. CORS 문제 없이 모든 플랫폼에서 안정적으로 작동한다.

### OAuth 플로우

Obsidian 플러그인에서의 OAuth 구현은 제한적이다:

- 브라우저 리다이렉트가 불가능하므로 표준 OAuth flow가 어려움
- **방법 1 (권장):** Notion의 Internal Integration 토큰 사용 (사용자가 직접 발급하여 입력)
- **방법 2:** 외부 서버를 통한 OAuth 프록시 (서버 유지 필요)
- **방법 3:** `obsidian://` 프로토콜 핸들러를 활용한 콜백 (제한적)

---

## 9. Background Processing

### UI 블로킹 없이 동기화 실행

Obsidian은 단일 메인 스레드에서 동작하므로, 무거운 작업은 UI를 블로킹할 수 있다.

#### Web Worker 현황

- Web Worker는 공식적으로 지원되지 않으며, 최근 버전에서 `Worker is not a constructor` 에러 발생
- esbuild 플러그인을 통한 inline worker 우회 방법이 존재하나 불안정
- WASM 기반 무거운 연산이 아닌 이상, 대부분의 동기화 작업은 async/await로 충분

#### 실용적 패턴

```typescript
class BackgroundSyncManager {
  private syncIntervalId: number | null = null;
  private isSyncing = false;
  private syncQueue: TFile[] = [];

  startPeriodicSync(intervalMinutes: number) {
    // registerInterval()을 사용하여 자동 정리 보장
    this.syncIntervalId = window.setInterval(
      () => this.processQueue(),
      intervalMinutes * 60 * 1000,
    );
  }

  stopPeriodicSync() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  enqueue(file: TFile) {
    if (!this.syncQueue.some((f) => f.path === file.path)) {
      this.syncQueue.push(file);
    }
  }

  async processQueue() {
    if (this.isSyncing || this.syncQueue.length === 0) return;
    this.isSyncing = true;

    try {
      const batch = [...this.syncQueue];
      this.syncQueue = [];

      for (const file of batch) {
        // 각 파일 사이에 yield하여 UI 반응성 유지
        await this.syncSingleFile(file);
        await this.yieldToUI();
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private yieldToUI(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  private async syncSingleFile(file: TFile) {
    // 파일별 동기화 로직
  }
}
```

### 기존 동기화 플러그인 참고

#### Remotely Save

- `syncRun` 메서드가 전체 동기화 프로세스를 오케스트레이션
- 로컬/리모트 파일 상태를 비교하여 필요한 작업 결정
- FakeFs 추상 레이어로 다양한 클라우드 서비스를 통일된 API로 접근
- 주기적 동기화를 `setInterval`로 구현

#### Obsidian Git

- `isomorphic-git` (JS 기반 Git 재구현)으로 모바일 지원
- Pull on startup + 주기적 commit & push (기본 5분)
- 사용자 설정 가능한 auto pull / auto commit 인터벌

#### Self-hosted LiveSync (obsidian-livesync)

- PouchDB(로컬) + CouchDB(원격) 아키텍처
- 파일을 chunk 단위로 분할하여 저장 (마크다운 구조 파싱 기반)
- CouchDB의 내장 충돌 감지/해결 기능 활용
- 실시간 동기화(LiveSync) + 주기적 동기화 모드 모두 지원
- 청크 인큐베이션: 새 청크를 임시로 문서 내에 포함했다가, 안정화되면 독립 청크로 분리

---

## 10. Storage & State

### 플러그인 데이터 저장 위치

- 설정 데이터: `.obsidian/plugins/<plugin-id>/data.json`
  - `loadData()` / `saveData()`로 접근
  - JSON 직렬화 가능한 모든 데이터 저장 가능
- 플러그인 파일: `.obsidian/plugins/<plugin-id>/`
  - `main.js`, `manifest.json`, `styles.css`
  - `adapter.read()` / `adapter.write()`로 이 디렉토리 내 파일에 접근 가능

### 동기화 상태 저장 옵션

#### 옵션 1: data.json (Plugin.saveData)

```typescript
// 간단하지만 파일이 커지면 성능 저하
interface SyncState {
  lastSyncTime: string;
  fileStates: Record<
    string,
    {
      localHash: string;
      remoteHash: string;
      lastSynced: string;
      notionPageId: string;
    }
  >;
}
```

#### 옵션 2: 별도 JSON 파일

```typescript
// 대량 데이터를 별도 파일로 분리
const syncStatePath = `${this.manifest.dir}/sync-state.json`;

async loadSyncState(): Promise<SyncState> {
  try {
    const data = await this.app.vault.adapter.read(syncStatePath);
    return JSON.parse(data);
  } catch {
    return { lastSyncTime: '', fileStates: {} };
  }
}

async saveSyncState(state: SyncState) {
  await this.app.vault.adapter.write(
    syncStatePath,
    JSON.stringify(state, null, 2)
  );
}
```

#### 옵션 3: IndexedDB

```typescript
// 대량 데이터에 적합. obsidian-database-library 사용 가능
// 각 볼트/디바이스별로 독립된 DB 인스턴스
// JSON 직렬화 가능한 모든 값 저장 가능
// 주의: 볼트 간 동기화 안 됨
```

#### 옵션 4: SQLite

- `better-sqlite3` 또는 WASM 기반 SQLite 사용 가능
- 데스크톱에서만 안정적으로 작동
- 대량의 동기화 메타데이터 관리에 적합하지만 모바일 호환성 문제
- `.obsidian/plugins/<plugin-id>/` 내에 DB 파일 저장

**Im-Nobsidian 권장:** 파일 수가 적으면 `data.json`, 수백 개 이상이면 별도 JSON 파일이나 IndexedDB 사용. SQLite는 모바일 지원이 필요하면 피할 것.

---

## 11. Mobile Considerations

### 모바일에서 사용 불가한 API

| API                               | 이유                         |
| --------------------------------- | ---------------------------- |
| `fs` (Node.js)                    | 모바일에는 Node.js 없음      |
| `path` (Node.js)                  | 모바일에는 Node.js 없음      |
| `child_process`                   | Electron 전용                |
| `electron`                        | 데스크톱 전용                |
| `FileSystemAdapter.getBasePath()` | 모바일에서 사용 불가         |
| `better-sqlite3`                  | 네이티브 모듈, 모바일 미지원 |
| Web Workers                       | 안정적으로 사용 불가         |

### 파일 시스템 차이

- **iOS:** 볼트은 반드시 Obsidian 전용 폴더 내에 있어야 함. 외부 폴더 접근 불가
- **Android:** 더 유연한 파일 시스템 접근. 외부 저장소 접근 가능
- **공통:** `vault.adapter`를 통한 API가 플랫폼 차이를 추상화해줌

### isDesktopOnly 결정 기준

```json
// manifest.json
{
  "isDesktopOnly": false // 모바일에서도 동작하려면 false
}
```

**`isDesktopOnly: true`로 설정해야 하는 경우:**

- Node.js 네이티브 모듈 사용 시 (`better-sqlite3`, `sharp` 등)
- Electron API 직접 사용 시 (`safeStorage`, `dialog` 등)
- `child_process` 사용 시

**Im-Nobsidian 관점:** Notion API 호출은 `requestUrl()`로 하고, 파일 접근은 `vault` API로 하면 모바일에서도 동작 가능. `isDesktopOnly: false`로 설정 가능.

---

## 12. Community Plugin 제출 요구사항

### 필수 파일

| 파일            | 위치                             | 설명                 |
| --------------- | -------------------------------- | -------------------- |
| `main.js`       | 리포지토리 루트 + GitHub Release | 번들된 플러그인 코드 |
| `manifest.json` | 리포지토리 루트 + GitHub Release | 플러그인 메타데이터  |
| `styles.css`    | GitHub Release (선택)            | 플러그인 스타일      |
| `README.md`     | 리포지토리 루트                  | 목적 설명 + 사용법   |
| `LICENSE`       | 리포지토리 루트                  | 라이선스 파일        |

### 제출 프로세스

1. GitHub에 플러그인 리포지토리 생성
2. GitHub Release 생성 (버전 번호 = `manifest.json`의 `version`, **v 접두어 없이**)
3. Release assets에 `main.js`, `manifest.json`, (선택: `styles.css`) 첨부
4. `obsidianmd/obsidian-releases`의 `community-plugins.json`에 PR 생성
5. Obsidian 팀이 코드 리뷰 후 머지

### 리뷰 체크리스트 / 주요 가이드라인

- **`normalizePath()` 필수:** 모든 사용자 정의 경로/구성된 경로는 반드시 `normalizePath()`로 처리
- **eslint 설정:** `eslint-plugin-obsidianmd` + `typescript-eslint` type-checked 규칙 사용 필수
- **`innerHTML` 사용 금지:** XSS 위험. `createEl()` 또는 `sanitizeHTMLToDom()` 사용
- **`eval()` 사용 금지:** 보안 위험
- **네트워크 접근 제한:** 불필요한 외부 통신 금지. 텔레메트리/애널리틱스는 허용되지 않음
- **플러그인 ID에 `"obsidian"` 포함 금지**
- **서드파티 코드 적절한 attribution**
- **설명이 공식 플러그인과 혼동되지 않도록 작성**
- **README에 목적과 사용법을 명확히 기술**

### 흔한 거부 사유

1. `normalizePath()` 미사용 — 경로 관련 코드 전체에 적용 필요
2. `typescript-eslint` type-checked 규칙 미설정
3. `innerHTML` 직접 사용
4. 불필요한 네트워크 통신
5. 라이선스 파일 누락
6. README 미비
7. 플러그인 ID에 "obsidian" 포함

---

## 13. 유사 플러그인 분석

### Remotely Save

**아키텍처:**

- `RemotelySavePlugin` → `Plugin` 상속
- `FakeFs` 추상 클래스로 S3/WebDAV/Dropbox/OneDrive/Google Drive 등 통일된 접근
- `RemotelySavePluginSettings` 인터페이스로 설정 관리

**충돌 해결:**

- 기본: 로컬/리모트의 `last modified time` 비교, 나중 것이 승리
- PRO: 마크다운 파일 머지, 비마크다운/대형 파일 복제
- content diff/patch 알고리즘 없음

**백그라운드 동기화:**

- `setInterval` 기반 주기적 동기화
- `syncRun` 메서드가 전체 프로세스 오케스트레이션

**UI:**

- 설정 탭에서 클라우드 서비스 선택 및 설정
- 상태 바에 동기화 상태 표시
- Notice로 동기화 결과 알림

**암호화:**

- 선택적 end-to-end 암호화 (openssl/rclone crypt 형식)

### Obsidian Git

**아키텍처:**

- 데스크톱: 시스템 Git 사용
- 모바일: `isomorphic-git` (JavaScript Git 구현)

**동기화 전략:**

- Pull on startup
- Auto commit + push (기본 5분 인터벌)
- Stage/unstage 개별 파일 지원
- 에디터 내 라인별 변경 표시 (gutter diff)

**충돌 해결:**

- Git의 내장 merge 기능 사용
- 충돌 발생 시 사용자에게 수동 해결 요청

### Self-hosted LiveSync (obsidian-livesync)

**아키텍처:**

- PouchDB (로컬, 브라우저 내장) + CouchDB (리모트)
- 의존성 주입 기반 모듈 아키텍처
- 주요 모듈: `ModuleReplicator`, `ModuleObsidianAPI`
- `LiveSyncLocalDB` (PouchDB 래퍼)
- 문서 타입: `EntryDoc` (파일), `EntryLeaf` (청크)

**동기화 전략:**

- 파일을 마크다운 구조 기반으로 청크 분할
- 수정된 청크만 저장하여 대역폭 절약
- 청크 인큐베이션: 새 청크를 문서 내 임시 보관 후 안정화 시 독립
- LiveSync (실시간) + Periodic (주기적) 모드

**충돌 해결:**

- CouchDB의 내장 충돌 감지 활용
- 자동 해결: 단순 충돌 (예: 체크박스 토글)
- 수동 해결: 양쪽 버전을 사용자에게 제시
- 머지 해결: 변경사항 결합

### 비교표

| 특성          | Remotely Save     | Obsidian Git        | LiveSync  | Im-Nobsidian (계획) |
| ------------- | ----------------- | ------------------- | --------- | ------------------- |
| 동기화 대상   | 클라우드 스토리지 | Git 리포            | CouchDB   | Notion              |
| 실시간 동기화 | 아니오            | 아니오              | 예        | 아니오 (주기적)     |
| 충돌 해결     | 최신 우선         | Git merge           | 자동+수동 | Frontmatter 기반    |
| 모바일 지원   | 예                | 예 (isomorphic-git) | 예        | 예 (requestUrl)     |
| 암호화        | 예                | 아니오              | 예        | 해당 없음           |
| 로컬 DB       | JSON              | Git                 | PouchDB   | JSON/IndexedDB      |

---

## 14. Key Patterns

### 파일 변경 Debounce

```typescript
class FileChangeDebouncer {
  private pendingChanges: Map<string, NodeJS.Timeout> = new Map();
  private readonly delay: number;

  constructor(
    private readonly onFileReady: (file: TFile) => void,
    delay = 3000,
  ) {
    this.delay = delay;
  }

  handleChange(file: TFile) {
    const existing = this.pendingChanges.get(file.path);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      this.pendingChanges.delete(file.path);
      this.onFileReady(file);
    }, this.delay);

    this.pendingChanges.set(file.path, timeout);
  }

  cancelAll() {
    for (const timeout of this.pendingChanges.values()) {
      clearTimeout(timeout);
    }
    this.pendingChanges.clear();
  }
}
```

### Queue 기반 API 호출 (Rate Limiting)

Notion API는 3 req/s 제한이 있으므로 큐 기반 호출이 필수.

```typescript
import { Sema } from "async-sema";

class NotionApiQueue {
  private semaphore = new Sema(3); // 최대 3개 동시 요청
  private requestCount = 0;
  private lastResetTime = Date.now();

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.semaphore.acquire();

    try {
      // Rate limit 준수
      await this.waitIfNeeded();
      this.requestCount++;

      return await fn();
    } catch (error) {
      if (this.isRateLimitError(error)) {
        // 429 에러 시 대기 후 재시도
        await this.waitMs(1000);
        return this.execute(fn);
      }
      throw error;
    } finally {
      this.semaphore.release();
    }
  }

  private async waitIfNeeded() {
    const elapsed = Date.now() - this.lastResetTime;
    if (elapsed >= 1000) {
      this.requestCount = 0;
      this.lastResetTime = Date.now();
    }
    if (this.requestCount >= 3) {
      await this.waitMs(1000 - elapsed);
      this.requestCount = 0;
      this.lastResetTime = Date.now();
    }
  }

  private waitMs(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isRateLimitError(error: unknown): boolean {
    return error instanceof Error && error.message.includes("429");
  }
}
```

### Progress Tracking

```typescript
interface SyncProgress {
  phase: "scanning" | "comparing" | "uploading" | "downloading" | "completing";
  current: number;
  total: number;
  currentFile: string;
  errors: Array<{ file: string; error: string }>;
}

class SyncProgressEmitter extends Events {
  private progress: SyncProgress = {
    phase: "scanning",
    current: 0,
    total: 0,
    currentFile: "",
    errors: [],
  };

  update(partial: Partial<SyncProgress>) {
    this.progress = { ...this.progress, ...partial };
    this.trigger("progress", this.progress);
  }

  onProgress(callback: (progress: SyncProgress) => void) {
    this.on("progress", callback);
  }
}
```

### Error Recovery

```typescript
class SyncErrorHandler {
  private retryCount = new Map<string, number>();
  private readonly maxRetries = 3;

  async withRetry<T>(
    key: string,
    fn: () => Promise<T>,
    onError?: (error: Error, attempt: number) => void,
  ): Promise<T> {
    const attempts = this.retryCount.get(key) || 0;

    try {
      const result = await fn();
      this.retryCount.delete(key);
      return result;
    } catch (error) {
      if (attempts < this.maxRetries) {
        this.retryCount.set(key, attempts + 1);
        onError?.(error as Error, attempts + 1);

        // 지수 백오프
        const delay = Math.pow(2, attempts) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));

        return this.withRetry(key, fn, onError);
      }

      this.retryCount.delete(key);
      throw error;
    }
  }

  resetRetryCount(key: string) {
    this.retryCount.delete(key);
  }
}
```

### Graceful Degradation

```typescript
class GracefulSync {
  async syncWithFallback(file: TFile) {
    try {
      // 1차: 양방향 동기화 시도
      await this.bidirectionalSync(file);
    } catch (error) {
      if (this.isNetworkError(error)) {
        // 네트워크 실패 → 오프라인 큐에 추가
        this.offlineQueue.enqueue(file);
        new Notice("Offline: changes will sync when connected");
      } else if (this.isConflictError(error)) {
        // 충돌 → 사용자에게 선택 요청
        const modal = new ConflictResolutionModal(this.app, file.path);
        const choice = await modal.waitForResult();
        if (choice) await this.resolveConflict(file, choice);
      } else if (this.isApiLimitError(error)) {
        // Rate limit → 큐에 다시 넣고 대기
        this.syncQueue.enqueueWithDelay(file, 60000);
        new Notice("Rate limited: retrying in 1 minute");
      } else {
        // 알 수 없는 에러 → 로그 + 사용자 알림
        console.error("Sync error:", error);
        new Notice(`Sync failed for ${file.name}: ${(error as Error).message}`);
      }
    }
  }
}
```

---

## Sources

### 공식 문서

- [Obsidian Developer Documentation](https://docs.obsidian.md/)
- [Plugin Class Reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin)
- [Anatomy of a plugin](https://docs.obsidian.md/Plugins/Getting+started/Anatomy+of+a+plugin)
- [Vault Documentation](https://docs.obsidian.md/Plugins/Vault)
- [Events Documentation](https://docs.obsidian.md/Plugins/Events)
- [Commands Documentation](https://docs.obsidian.md/Plugins/User+interface/Commands)
- [Views Documentation](https://docs.obsidian.md/Plugins/User+interface/Views)
- [Status bar Documentation](https://docs.obsidian.md/Plugins/User+interface/Status+bar)
- [Settings Documentation](https://docs.obsidian.md/Plugins/User+interface/Settings)
- [Manifest Reference](https://docs.obsidian.md/Reference/Manifest)
- [Plugin Guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Submission Requirements](https://docs.obsidian.md/Plugins/Releasing/Submission+requirements+for+plugins)
- [Submit Your Plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [requestUrl Reference](https://docs.obsidian.md/Reference/TypeScript+API/requestUrl)
- [debounce Reference](https://docs.obsidian.md/Reference/TypeScript+API/debounce)
- [processFrontMatter Reference](https://docs.obsidian.md/Reference/TypeScript+API/FileManager/processFrontMatter)
- [registerView Reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/registerView)
- [onExternalSettingsChange Reference](https://docs.obsidian.md/Reference/TypeScript+API/Plugin/onExternalSettingsChange)

### API 소스 & DeepWiki

- [obsidianmd/obsidian-api (GitHub)](https://github.com/obsidianmd/obsidian-api)
- [obsidian.d.ts 타입 정의](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)
- [obsidianmd/obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
- [Plugin Development (DeepWiki)](https://deepwiki.com/obsidianmd/obsidian-api/3-plugin-development)
- [Event System (DeepWiki)](https://deepwiki.com/obsidianmd/obsidian-api/5.1-event-system)
- [MetadataCache (DeepWiki)](https://deepwiki.com/obsidianmd/obsidian-api/2.4-metadatacache-and-link-resolution)
- [obsidianmd/obsidian-releases (community-plugins)](https://github.com/obsidianmd/obsidian-releases)
- [plugin-review.md](https://github.com/obsidianmd/obsidian-releases/blob/master/plugin-review.md)

### 커뮤니티 가이드

- [Marcus Olsson Plugin Docs](https://marcusolsson.github.io/obsidian-plugin-docs/)
- [Obsidian Plugin Docs - Settings](https://marcusolsson.github.io/obsidian-plugin-docs/user-interface/settings)
- [Obsidian Plugin Docs - Commands](https://marcusolsson.github.io/obsidian-plugin-docs/user-interface/commands)
- [Obsidian Plugin Docs - Views](https://marcusolsson.github.io/obsidian-plugin-docs/user-interface/views)
- [Obsidian requestUrl Example (GitHub)](https://github.com/Zachatoo/obsidian-request-example)
- [Web Worker Example for Obsidian (GitHub)](https://github.com/RyotaUshio/obsidian-web-worker-example)

### 유사 플러그인 소스

- [remotely-save/remotely-save (GitHub)](https://github.com/remotely-save/remotely-save)
- [Remotely Save (DeepWiki)](https://deepwiki.com/remotely-save/remotely-save)
- [Vinzent03/obsidian-git (GitHub)](https://github.com/Vinzent03/obsidian-git)
- [vrtmrz/obsidian-livesync (GitHub)](https://github.com/vrtmrz/obsidian-livesync)
- [LiveSync CouchDB Synchronization (DeepWiki)](https://deepwiki.com/vrtmrz/obsidian-livesync/3.1-couchdb-synchronization)

### 보안 관련

- [Cross-platform Secure Storage Discussion (Forum)](https://forum.obsidian.md/t/cross-platform-secure-storage-for-secrets-and-tokens-that-can-be-syncd/100716)
- [obsidian-secure-store (GitHub)](https://github.com/lvnacy-notes/obsidian-secure-store)
- [Obsidian 1.11.4 Changelog (SecretStorage)](https://obsidian.md/changelog/2026-01-07-desktop-v1.11.4/)
- [obsidian-database-library (IndexedDB)](https://github.com/Fevol/obsidian-database-library)

### 커뮤니티 포럼 논의

- [Make HTTP Requests (Forum)](https://forum.obsidian.md/t/make-http-requests-from-plugins/15461)
- [CORS with Authentication (Forum)](https://forum.obsidian.md/t/https-request-avoiding-cors-with-authentication-and-custom-self-signed-certificate/90725)
- [Can Plugins Use Web Worker? (Forum)](https://forum.obsidian.md/t/can-plugins-use-web-worker/81040)
- [Web Worker Priority Discussion (Forum)](https://forum.obsidian.md/t/plugins-web-worker-should-be-a-priority/111810)
- [vault.process Debounce Issue (Forum)](https://forum.obsidian.md/t/vault-process-and-vault-modify-dont-work-when-there-is-a-requestsave-debounce-event/107862)
- [Debounce is Actually Throttle (Forum)](https://forum.obsidian.md/t/the-debounce-function-provided-by-the-api-is-actually-a-throttle-function/79147)
- [Sync Behavior and File Events (Forum)](https://forum.obsidian.md/t/seeking-guidance-on-sync-behavior-and-file-creation-rename-events/93436)
- [Mobile Adapter Interface (Forum)](https://forum.obsidian.md/t/mobile-obsidians-app-vault-adapter-keeps-changing-its-interface/78705)
