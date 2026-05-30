import { describe, it, expect, vi, beforeEach } from "vitest";
import { ViewDataProvider } from "../../src/view/view-data-provider.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { DatabaseViewsConfig } from "../../src/types/view.js";

function createMockVaultFs(files: Record<string, string> = {}): VaultFS {
  return {
    readFile: vi.fn(async (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`File not found: ${path}`);
    }),
    readBinary: vi.fn(),
    writeFile: vi.fn(),
    writeBinary: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    exists: vi.fn(),
    ensureFolder: vi.fn(),
    listMarkdownFiles: vi.fn(async () =>
      Object.keys(files)
        .filter((p) => p.endsWith(".md"))
        .map((p) => ({ path: p, mtime: "2026-05-18T00:00:00.000Z" })),
    ),
    listNonMarkdownFiles: vi.fn(async () => []),
  };
}

const sampleViewsConfig: Record<string, DatabaseViewsConfig> = {
  "db-123": {
    databaseId: "db-123",
    databaseName: "마음AI",
    lastSynced: "2026-05-18T00:00:00.000Z",
    views: [
      {
        id: "view-1",
        name: "갤러리",
        type: "gallery",
        properties: [
          { propertyId: "company", propertyName: "회사", visible: true },
          { propertyId: "stage", propertyName: "단계", visible: true },
          { propertyId: "hidden", propertyName: "비공개", visible: false },
        ],
        cover: { type: "page_cover" },
        coverSize: "medium",
      },
      {
        id: "view-2",
        name: "보드",
        type: "board",
        groupBy: {
          type: "select",
          propertyId: "stage-id",
          propertyName: "단계",
          sort: "ascending",
          hideEmptyGroups: true,
        },
      },
      {
        id: "view-3",
        name: "캘린더",
        type: "calendar",
        datePropertyId: "due-id",
        datePropertyName: "마감일",
      },
    ],
  },
};

const sampleFiles: Record<string, string> = {
  ".im-nobsidian/db-views.json": JSON.stringify(sampleViewsConfig),
  "jobs/CompanyA.md": [
    "---",
    "title: A사",
    "icon: 🏢",
    "cover: attachments/a-cover.jpg",
    "회사: A사",
    "단계: 서류전형",
    "마감일: 2026-05-20",
    "---",
    "",
    "A사 지원 내용",
  ].join("\n"),
  "jobs/CompanyB.md": [
    "---",
    "title: B사",
    "icon: 🔬",
    "회사: B사",
    "단계: 면접",
    "마감일: 2026-06-01",
    "---",
    "",
    "B사 지원 내용",
  ].join("\n"),
  "jobs/CompanyC.md": ["---", "title: C사", "단계: 서류전형", "---", "", "C사 지원 내용"].join(
    "\n",
  ),
};

describe("ViewDataProvider", () => {
  let provider: ViewDataProvider;

  beforeEach(() => {
    provider = new ViewDataProvider(createMockVaultFs(sampleFiles));
  });

  describe("loadAllViewConfigs", () => {
    it("db-views.json 로드", async () => {
      const configs = await provider.loadAllViewConfigs();
      expect(configs["db-123"]).toBeDefined();
      expect(configs["db-123"]!.databaseName).toBe("마음AI");
    });

    it("파일 없으면 빈 객체", async () => {
      const emptyProvider = new ViewDataProvider(createMockVaultFs({}));
      const configs = await emptyProvider.loadAllViewConfigs();
      expect(configs).toEqual({});
    });
  });

  describe("getViewConfigs", () => {
    it("특정 DB 설정 조회", async () => {
      const config = await provider.getViewConfigs("db-123");
      expect(config?.views).toHaveLength(3);
    });

    it("없는 DB ID는 null", async () => {
      const config = await provider.getViewConfigs("nonexistent");
      expect(config).toBeNull();
    });
  });

  describe("collectEntries", () => {
    it("폴더 내 .md 파일에서 DBEntry 수집", async () => {
      const entries = await provider.collectEntries("jobs");
      expect(entries).toHaveLength(3);
    });

    it("프론트매터에서 title 추출", async () => {
      const entries = await provider.collectEntries("jobs");
      const companyA = entries.find((e) => e.title === "A사");
      expect(companyA).toBeDefined();
    });

    it("icon/cover 추출", async () => {
      const entries = await provider.collectEntries("jobs");
      const companyA = entries.find((e) => e.title === "A사");
      expect(companyA?.icon).toBe("🏢");
      expect(companyA?.cover).toBe("attachments/a-cover.jpg");
    });

    it("properties에서 title/icon/cover 제외", async () => {
      const entries = await provider.collectEntries("jobs");
      const companyA = entries.find((e) => e.title === "A사");
      expect(companyA?.properties).not.toHaveProperty("title");
      expect(companyA?.properties).not.toHaveProperty("icon");
      expect(companyA?.properties).not.toHaveProperty("cover");
      expect(companyA?.properties).toHaveProperty("회사");
    });

    it("타이틀 없으면 파일명에서 추출", async () => {
      const entries = await provider.collectEntries("jobs");
      const companyC = entries.find((e) => e.path.includes("CompanyC"));
      expect(companyC?.title).toBe("C사");
    });

    /**
     * rank21 회귀(I9 오포함 차단): DB 폴더에 **중첩 하위 폴더**(별도 child_database 나
     * 자식 페이지 본문)가 있어도 그 안의 .md 는 부모 DB 의 행이 아니다. `startsWith(prefix)`
     * 단순 매칭은 이를 카드로 새게 했다 — 직속 행만 수집됨을 결정적으로 잠근다.
     */
    it("중첩 하위 폴더(child_database)의 .md 는 부모 DB 행으로 새지 않는다", async () => {
      const nestedProvider = new ViewDataProvider(
        createMockVaultFs({
          ...sampleFiles,
          // jobs/ 직속 행 3개(sampleFiles) + 중첩 sub-DB 행 2개 + 더 깊은 중첩 1개.
          "jobs/SubDB/Nested A.md": ["---", "title: 중첩A", "---", "", "중첩 DB 행"].join("\n"),
          "jobs/SubDB/Nested B.md": ["---", "title: 중첩B", "---", "", "중첩 DB 행"].join("\n"),
          "jobs/SubDB/Deeper/Leaf.md": ["---", "title: 더깊은", "---", "", "더 깊은 중첩"].join(
            "\n",
          ),
        }),
      );
      const entries = await nestedProvider.collectEntries("jobs");
      // 직속 3개만 — 중첩 3개는 전부 제외.
      expect(entries).toHaveLength(3);
      const titles = entries.map((e) => e.title).sort();
      expect(titles).toEqual(["A사", "B사", "C사"]);
      // 중첩 행 제목은 어떤 것도 새어 들지 않았다.
      expect(entries.some((e) => e.path.includes("SubDB"))).toBe(false);
    });
  });

  describe("buildViewData", () => {
    it("갤러리 뷰 데이터 빌드", async () => {
      const data = await provider.buildViewData("db-123", "view-1", "jobs");
      expect(data).not.toBeNull();
      expect(data!.viewConfig.type).toBe("gallery");
      expect(data!.entries).toHaveLength(3);
      expect(data!.propertyNames).toContain("회사");
      expect(data!.propertyNames).toContain("단계");
      expect(data!.propertyNames).not.toContain("비공개");
    });

    it("보드 뷰 데이터 빌드 (그룹핑)", async () => {
      const data = await provider.buildViewData("db-123", "view-2", "jobs");
      expect(data).not.toBeNull();
      expect(data!.grouped).toBeDefined();

      const groups = data!.grouped!;
      const seoryuGroup = groups.find((g) => g.groupName === "서류전형");
      expect(seoryuGroup?.entries).toHaveLength(2);

      const interviewGroup = groups.find((g) => g.groupName === "면접");
      expect(interviewGroup?.entries).toHaveLength(1);
    });

    it("캘린더 뷰 데이터 빌드", async () => {
      const data = await provider.buildViewData("db-123", "view-3", "jobs");
      expect(data).not.toBeNull();
      expect(data!.calendarEntries).toBeDefined();
      expect(data!.calendarEntries!.length).toBeGreaterThanOrEqual(2);
    });

    it("없는 뷰 ID는 null", async () => {
      const data = await provider.buildViewData("db-123", "nonexistent", "jobs");
      expect(data).toBeNull();
    });

    it("없는 DB ID는 null", async () => {
      const data = await provider.buildViewData("nonexistent", "view-1", "jobs");
      expect(data).toBeNull();
    });
  });

  describe("buildDefaultViewData", () => {
    it("첫 번째 뷰 사용", async () => {
      const data = await provider.buildDefaultViewData("db-123", "jobs");
      expect(data).not.toBeNull();
      expect(data!.viewConfig.name).toBe("갤러리");
    });

    it("뷰 없는 DB는 null", async () => {
      const emptyProvider = new ViewDataProvider(
        createMockVaultFs({
          ".im-nobsidian/db-views.json": JSON.stringify({
            "db-empty": { databaseId: "db-empty", lastSynced: "", views: [] },
          }),
        }),
      );
      const data = await emptyProvider.buildDefaultViewData("db-empty", "jobs");
      expect(data).toBeNull();
    });
  });

  describe("processViewData", () => {
    it("정렬 적용", () => {
      const entries = [
        { path: "a.md", title: "B", properties: { name: "Beta" } },
        { path: "b.md", title: "A", properties: { name: "Alpha" } },
      ];
      const viewConfig = {
        id: "v1",
        name: "T",
        type: "table" as const,
        sorts: [{ property: "name", direction: "ascending" as const }],
      };
      const data = provider.processViewData(entries, viewConfig, "db-1");
      expect(data.entries[0]!.title).toBe("A");
    });
  });
});
