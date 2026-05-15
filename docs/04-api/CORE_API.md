# @im-nobsidian/core API Reference

Im-Nobsidian의 코어 엔진을 라이브러리로 사용할 수 있습니다.

## Installation

```bash
npm install @im-nobsidian/core
```

## Quick Start

```typescript
import {
  SyncOrchestrator,
  ConfigManager,
  StateDB,
  NotionClient,
  NodeVaultFS,
} from "@im-nobsidian/core";

const config = await new ConfigManager("/path/to/vault").load();
const stateDb = StateDB.open("/path/to/vault/.im-nobsidian/sync.db");
const client = new NotionClient({ token: config.notion.token });
const vaultFs = new NodeVaultFS("/path/to/vault", config.paths);

const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

// Push (Obsidian → Notion)
const pushResult = await orchestrator.push({ dryRun: false });
console.log(`Created: ${pushResult.created}, Updated: ${pushResult.updated}`);

// Pull (Notion → Obsidian)
const pullResult = await orchestrator.pull({ dryRun: false });

// Bidirectional sync
const syncResult = await orchestrator.sync({ dryRun: false });
```

## Core Classes

### SyncOrchestrator

동기화 엔진의 진입점. Push/Pull/Sync/Status 전체 흐름을 관리합니다.

```typescript
class SyncOrchestrator {
  constructor(config: SyncConfig, stateDb: StateDB, notionClient: NotionClient, vaultFs: VaultFS);

  push(options?: { dryRun?: boolean; force?: boolean }): Promise<SyncResult>;
  pull(options?: { dryRun?: boolean }): Promise<SyncResult>;
  sync(options?: { dryRun?: boolean }): Promise<SyncResult>;
  status(): Promise<StatusResult>;
}
```

#### SyncResult

```typescript
interface SyncResult {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  conflicts: number;
  errors: SyncError[];
}
```

### ConfigManager

설정 파일 (`config.json`) 관리.

```typescript
class ConfigManager {
  constructor(vaultPath: string);

  load(): Promise<SyncConfig>;
  save(config: SyncConfig): Promise<void>;
  exists(): boolean;
}
```

### StateDB

SQLite 기반 동기화 상태 추적.

```typescript
class StateDB {
  static open(path: string): StateDB;

  getSyncState(path: string): SyncState | null;
  upsertSyncState(state: SyncState): void;
  getAllSyncStates(): SyncState[];
  deleteSyncState(path: string): void;
}
```

### NotionClient

Notion API 래퍼. Rate limiting + 재시도가 내장되어 있습니다.

```typescript
class NotionClient {
  constructor(options: { token: string });

  getPage(pageId: string): Promise<NotionPage>;
  createPage(parentId: string, title: string, content: string): Promise<NotionPage>;
  updatePage(pageId: string, content: string): Promise<void>;
  getChildPages(pageId: string): Promise<NotionPage[]>;
}
```

### ConversionPipeline

마크다운 ↔ Notion 변환 파이프라인.

```typescript
class ConversionPipeline {
  registerPreProcessor(processor: Processor): void;
  registerPostProcessor(processor: Processor): void;

  convertToNotion(markdown: string, context: ConversionContext): ConversionResult;
  convertToMarkdown(content: string, context: ConversionContext): string;
}
```

### NodeVaultFS

로컬 파일 시스템 접근.

```typescript
class NodeVaultFS implements VaultFS {
  constructor(basePath: string, pathConfig?: PathConfig);

  listMarkdownFiles(): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readBinary(path: string): Promise<Buffer>;
}
```

## Conversion Functions

### Enhanced Markdown Converter

Notion Enhanced Markdown ↔ Obsidian 마크다운 변환.

```typescript
import { notionEnhancedToObsidian, obsidianToNotionEnhanced } from "@im-nobsidian/core";

// Notion Enhanced Markdown → Obsidian
const obsidianMd = notionEnhancedToObsidian(notionMarkdown);

// Obsidian → Notion Enhanced Markdown
const notionMd = obsidianToNotionEnhanced(obsidianMarkdown);
```

변환 대상:

- `<details>` 토글 → `%%im-nobsidian:toggle%%` 마커
- `<mention-page>` → `[[위키링크]]`
- `<page>` 링크 → `[[위키링크]]`
- `<span color>` → 보존 마커 (`%%im-nobsidian:color:...%%`)
- `<span underline>` → 보존 마커 (`%%im-nobsidian:underline%%`)
- `<audio>/<video>/<pdf>/<file>` → 이모지 링크
- `<tab>` → `> [!tab]` 콜아웃
- `<unknown>` → 보존 마커 (`%%im-nobsidian:unknown:...%%`)
- `<empty-block/>` → 제거
- HTML 테이블 → 마크다운 테이블
- 수학 수식 (inline/block) 정규화
- 콜아웃 (`:::`) → Obsidian 콜아웃 (`> [!type]`)

## Types

주요 타입 정의는 `@im-nobsidian/core`에서 export됩니다:

```typescript
import type {
  SyncConfig,
  SyncResult,
  StatusResult,
  SyncState,
  ConversionContext,
  ConversionResult,
  VaultFS,
  PathConfig,
} from "@im-nobsidian/core";
```
