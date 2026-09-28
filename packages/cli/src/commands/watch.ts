import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
  WatchSyncService,
} from "@im-nobsidian/core";
import type { SyncResult, WatchSyncScope } from "@im-nobsidian/core";

function formatResult(result: SyncResult): string {
  const pull = `Pull: +${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}`;
  const moved = result.push.moved > 0 ? ` →${result.push.moved}` : "";
  const push = `Push: +${result.push.created} ~${result.push.updated} -${result.push.deleted}${moved}`;
  const parts = [pull, push];

  if (result.conflicts.length > 0) {
    parts.push(`충돌 ${result.conflicts.length}건`);
  }

  return parts.join(" | ");
}

function timestamp(): string {
  return new Date().toLocaleTimeString("ko-KR", { hour12: false });
}

/** 로그의 sync 이름 — 주기 sync 는 볼트 전체를 본다. */
function syncLabel(scope: WatchSyncScope): string {
  return scope === "full" ? "주기적 동기화" : "동기화";
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

    const client = NotionClient.fromConfig(config);
    const vaultFs = new NodeVaultFS(cwd, config.paths);
    const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

    const debounceMs = parseInt(options.debounce, 10);
    const intervalSec = parseInt(options.interval, 10);

    const service = new WatchSyncService(cwd, orchestrator, {
      debounceMs,
      onFileChange: (event, path) => {
        console.log(`[${timestamp()}] ${event}: ${path}`);
      },
      onSyncStart: (scope) => {
        console.log(`[${timestamp()}] ${syncLabel(scope)} 시작...`);
      },
      onSyncComplete: (result, scope) => {
        console.log(`[${timestamp()}] ${syncLabel(scope)} 완료 — ${formatResult(result)}`);
      },
      onSyncCancelled: (result, scope) => {
        console.log(
          `[${timestamp()}] ${syncLabel(scope)} 취소 — 멈추기 전까지 ${formatResult(result)}`,
        );
      },
      onSyncError: (error, scope) => {
        console.error(`[${timestamp()}] ${syncLabel(scope)} 실패: ${error.message}`);
      },
    });

    let pullTimer: ReturnType<typeof setInterval> | null = null;
    let shuttingDown = false;

    const shutdown = async (): Promise<void> => {
      // 도는 sync 를 기다리는 중에 한 번 더 누르면 기다리지 않고 끝낸다.
      if (shuttingDown) {
        console.log(`[${timestamp()}] 강제 종료`);
        return process.exit(1);
      }
      shuttingDown = true;
      console.log(`\n[${timestamp()}] 감시 종료 중... (도는 동기화를 멈추고 기다립니다)`);
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
      // 파일 변경 sync 와 같은 줄에 세운다 — 도는 sync 가 있으면 끝난 뒤 한 번 돈다(S-09).
      pullTimer = setInterval(() => service.requestFullSync(), intervalSec * 1000);
    }

    await new Promise(() => {});
  });
