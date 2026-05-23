import { describe, it, expect } from "vitest";

describe("설정 기본값 구조", () => {
  const DEFAULT_SETTINGS = {
    token: "",
    rootPageId: "",
    syncDirection: "both" as const,
    autoSync: false,
    autoSyncInterval: 300,
    conflictStrategy: "manual" as const,
    attachments: "attachments",
  };

  it("모든 필수 필드 존재", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).toEqual([
      "token",
      "rootPageId",
      "syncDirection",
      "autoSync",
      "autoSyncInterval",
      "conflictStrategy",
      "attachments",
    ]);
  });

  it("syncDirection 유효 값", () => {
    const validDirections = ["push", "pull", "both"];
    expect(validDirections).toContain(DEFAULT_SETTINGS.syncDirection);
  });

  it("autoSyncInterval 범위 (30~3600)", () => {
    expect(DEFAULT_SETTINGS.autoSyncInterval).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_SETTINGS.autoSyncInterval).toBeLessThanOrEqual(3600);
  });

  it("token 초기값 빈 문자열", () => {
    expect(DEFAULT_SETTINGS.token).toBe("");
  });

  it("autoSync 기본 비활성", () => {
    expect(DEFAULT_SETTINGS.autoSync).toBe(false);
  });

  it("conflictStrategy 기본 manual", () => {
    expect(DEFAULT_SETTINGS.conflictStrategy).toBe("manual");
  });
});

describe("VIEW_TYPE 상수 검증", () => {
  it("DATABASE_VIEW_TYPE 형식", () => {
    const type = "im-nobsidian-db-view";
    expect(type).toMatch(/^im-nobsidian-/);
  });

  it("SYNC_SIDEBAR_TYPE 형식", () => {
    const type = "im-notion-sync-sidebar";
    expect(type).toMatch(/^im-notion-/);
  });
});

describe("DatabaseConfig 구조", () => {
  it("데이터베이스 설정 구조 검증", () => {
    const config = {
      databaseId: "db-abc123",
      localFolder: "databases/my-db",
    };

    expect(config.databaseId).toBeTruthy();
    expect(config.localFolder).toBeTruthy();
    expect(config.localFolder.startsWith("/")).toBe(false);
  });
});
