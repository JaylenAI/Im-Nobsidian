import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
  WatchSyncService,
} from "@obsinotion/core";
import type { SyncResult } from "@obsinotion/core";

function formatResult(result: SyncResult): string {
  const pull = `Pull: +${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}`;
  const push = `Push: +${result.push.created} ~${result.push.updated} -${result.push.deleted}`;
  const parts = [pull, push];

  if (result.conflicts.length > 0) {
    parts.push(`충돌 ${result.conflicts.length}건`);
  }

  return parts.join(" | ");
}

function timestamp(): string {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

export const watchCommand = new Command("watch")
  .description("파일 변경 감지 + 자동 동기화")
  .option("-d, --debounce <ms>", "디바운스 대기 시간(ms)", "2000")
  .option("-i, --interval <seconds>", "풀 동기화 주기(초, 0이면 비활성)", "0")
  .action(async (options: { debounce: string; interval: string }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    const client = new NotionClient({
      token: config.notion.token,
      concurrency: config.advanced.concurrency,
      timeoutMs: config.advanced.timeoutMs,
    });
    const vaultFs = new NodeVaultFS(cwd, config.paths);
    const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

    const debounceMs = parseInt(options.debounce, 10);
    const intervalSec = parseInt(options.interval, 10);

    const service = new WatchSyncService(cwd, orchestrator, {
      debounceMs,
      onFileChange: (event, path) => {
        console.log(`[${timestamp()}] ${event}: ${path}`);
      },
      onSyncStart: () => {
        console.log(`[${timestamp()}] 동기화 시작...`);
      },
      onSyncComplete: (result) => {
        console.log(`[${timestamp()}] 동기화 완료 — ${formatResult(result)}`);
      },
      onSyncError: (error) => {
        console.error(`[${timestamp()}] 동기화 실패: ${error.message}`);
      },
    });

    let pullTimer: ReturnType<typeof setInterval> | null = null;

    const shutdown = async (): Promise<void> => {
      console.log(`\n[${timestamp()}] 감시 종료 중...`);
      if (pullTimer) clearInterval(pullTimer);
      await service.stop();
      stateDb.close();
      console.log(`[${timestamp()}] 종료 완료`);
      process.exit(0);
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    service.start();
    console.log(`[${timestamp()}] 파일 감시 시작 (debounce: ${debounceMs}ms)`);

    if (intervalSec > 0) {
      console.log(`[${timestamp()}] 풀 동기화 주기: ${intervalSec}초`);
      pullTimer = setInterval(async () => {
        if (service.isSyncing()) return;
        try {
          console.log(`[${timestamp()}] 주기적 동기화 시작...`);
          const result = await orchestrator.sync();
          console.log(`[${timestamp()}] 주기적 동기화 완료 — ${formatResult(result)}`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[${timestamp()}] 주기적 동기화 실패: ${msg}`);
        }
      }, intervalSec * 1000);
    }

    await new Promise(() => {});
  });
