/**
 * I4 — DB 충실도 불변식 (실 Notion).
 *
 * Notion API 는 비-table 뷰(calendar/board 등) 생성을 지원하지 않으므로 미지원 뷰 보존은
 * 오프라인 단위 테스트(`tests/view/sidecar-generator.test.ts`)가 전수 검증한다. 이 파일은
 * API 로 가능한 두 가지를 실 Notion 으로 잠근다:
 *   1) 사이드카가 실제 DB 스키마(select 옵션 포함)를 무손실 캡처 + 결정적 직렬화(멱등).
 *   2) **스키마 진화**(속성 추가) 시 신규 속성 캡처 + 기존 속성 무손실(I4 핵심 요구).
 *
 * 격리 루트 아래에 임시 DB 를 만들고 afterAll 에서 루트를 archive(서브트리 정리)한다.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "@notionhq/client";
import { NotionClient } from "../../src/notion/client.js";
import { SidecarGenerator } from "../../src/view/sidecar-generator.js";
import { rawNotion, createIsolatedRoot, archivePages, sleep, SKIP, TOKEN } from "./harness.js";

const raw = SKIP ? null : rawNotion();
const client = SKIP ? null : new NotionClient({ token: TOKEN });
const sidecar = new SidecarGenerator();

const created: string[] = [];
let dbId = "";
let dataSourceId = "";

const EMPTY_VIEWS = (id: string) => ({ databaseId: id, lastSynced: "", views: [] });

describe.skipIf(SKIP)("I4 DB 충실도 불변식", () => {
  beforeAll(async () => {
    const rootId = await createIsolatedRoot(raw!, "db-fidelity");
    created.push(rootId);

    const db = (await raw!.databases.create({
      parent: { type: "page_id", page_id: rootId },
      title: [{ type: "text", text: { content: "할 일" } }],
      initial_data_source: {
        properties: {
          이름: { title: {} },
          상태: {
            select: { options: [{ name: "할 일" }, { name: "진행" }, { name: "완료" }] },
          },
          마감: { date: {} },
        },
      },
    } as Parameters<Client["databases"]["create"]>[0])) as unknown as {
      id: string;
      data_sources?: Array<{ id: string }>;
    };

    dbId = db.id;
    dataSourceId = db.data_sources?.[0]?.id ?? "";
    await sleep(500);
  }, 60000);

  afterAll(async () => {
    if (raw) await archivePages(raw, created);
  });

  it("사이드카가 실 Notion 스키마(select 옵션)를 캡처하고 결정적으로 직렬화한다", async () => {
    const schema = await client!.getDatabaseSchemaFull(dbId);
    const views = await client!.getDatabaseViewsConfig(dbId);
    const built = sidecar.build({
      databaseId: dbId,
      databaseName: "할 일",
      schema,
      viewsConfig: views,
    });

    const status = built.properties.find((p) => p.name === "상태");
    expect(status?.type).toBe("select");
    expect(status?.options).toEqual(["할 일", "진행", "완료"]);
    expect(built.properties.map((p) => p.name).sort()).toEqual(["마감", "상태", "이름"].sort());

    // 결정적: 동일 입력 두 번 직렬화 → 바이트 동일(멱등 / drift 0).
    const again = sidecar.build({
      databaseId: dbId,
      databaseName: "할 일",
      schema,
      viewsConfig: views,
    });
    expect(sidecar.serialize(built)).toBe(sidecar.serialize(again));
  });

  it("스키마 진화: 속성 추가 시 신규 캡처 + 기존 무손실(I4)", async () => {
    expect(dataSourceId).not.toBe("");

    await raw!.dataSources.update({
      data_source_id: dataSourceId,
      properties: {
        우선순위: { select: { options: [{ name: "높음" }, { name: "낮음" }] } },
      },
    } as Parameters<Client["dataSources"]["update"]>[0]);
    await sleep(500);

    const schema = await client!.getDatabaseSchemaFull(dbId);
    const built = sidecar.build({
      databaseId: dbId,
      databaseName: "할 일",
      schema,
      viewsConfig: EMPTY_VIEWS(dbId),
    });

    const names = built.properties.map((p) => p.name);
    // 신규 속성 캡처
    expect(names).toContain("우선순위");
    // 기존 속성 전부 무손실
    expect(names).toContain("이름");
    expect(names).toContain("상태");
    expect(names).toContain("마감");

    const prio = built.properties.find((p) => p.name === "우선순위");
    expect(prio?.options).toEqual(["높음", "낮음"]);
    // 기존 상태 옵션도 진화 후 그대로 보존
    expect(built.properties.find((p) => p.name === "상태")?.options).toEqual([
      "할 일",
      "진행",
      "완료",
    ]);
  });
});
