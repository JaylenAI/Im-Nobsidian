import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../../src/config/manager.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";

describe("ConfigManager", () => {
  let tempDir: string;
  let manager: ConfigManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "obsinotion-config-"));
    manager = new ConfigManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("configDir / configPath / dbPath", () => {
    it("경로 올바르게 반환", () => {
      expect(manager.configDir).toBe(join(tempDir, ".obsinotion"));
      expect(manager.configPath).toBe(join(tempDir, ".obsinotion/config.json"));
      expect(manager.dbPath).toBe(join(tempDir, ".obsinotion/sync.db"));
    });
  });

  describe("init", () => {
    it("설정 파일 생성", async () => {
      const config = await manager.init({
        token: "ntn_test_token_12345",
        rootPageId: "abc-123",
      });

      expect(config.notion.token).toBe("ntn_test_token_12345");
      expect(config.notion.rootPageId).toBe("abc-123");

      const raw = await readFile(manager.configPath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.notion.token).toBe("ntn_test_token_12345");
    });

    it(".gitignore에 .obsinotion/ 추가", async () => {
      await manager.init({ token: "ntn_test_init", rootPageId: "root" });

      const gitignore = await readFile(join(tempDir, ".gitignore"), "utf-8");
      expect(gitignore).toContain(".obsinotion/");
    });

    it("기존 .gitignore에 추가 (중복 안 함)", async () => {
      await writeFile(join(tempDir, ".gitignore"), "node_modules/\n.obsinotion/\n");
      await manager.init({ token: "ntn_test_dup", rootPageId: "root" });

      const gitignore = await readFile(join(tempDir, ".gitignore"), "utf-8");
      const count = (gitignore.match(/\.obsinotion\//g) ?? []).length;
      expect(count).toBe(1);
    });
  });

  describe("load", () => {
    it("저장된 설정 로드", async () => {
      await manager.init({ token: "ntn_test_load", rootPageId: "page-id" });

      const freshManager = new ConfigManager(tempDir);
      const config = await freshManager.load();

      expect(config.notion.token).toBe("ntn_test_load");
      expect(config.notion.rootPageId).toBe("page-id");
    });

    it("설정 파일 없으면 에러", async () => {
      await expect(manager.load()).rejects.toThrow("설정 파일을 찾을 수 없습니다");
    });
  });

  describe("save", () => {
    it("설정 저장", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        notion: { token: "ntn_saved", rootPageId: "saved-root" },
      };

      await manager.save(config);

      const raw = await readFile(manager.configPath, "utf-8");
      expect(JSON.parse(raw).notion.token).toBe("ntn_saved");
    });
  });

  describe("getConfig", () => {
    it("load 전에 호출하면 에러", () => {
      expect(() => manager.getConfig()).toThrow("설정이 로드되지 않았습니다");
    });

    it("load 후에는 설정 반환", async () => {
      await manager.init({ token: "ntn_get", rootPageId: "get-root" });
      await manager.load();
      const config = manager.getConfig();
      expect(config.notion.token).toBe("ntn_get");
    });
  });

  describe("isInitialized", () => {
    it("초기화 안 된 상태 false", async () => {
      expect(await manager.isInitialized()).toBe(false);
    });

    it("초기화 후 true", async () => {
      await manager.init({ token: "ntn_check", rootPageId: "check" });
      expect(await manager.isInitialized()).toBe(true);
    });
  });
});
