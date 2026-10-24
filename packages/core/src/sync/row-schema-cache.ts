import {
  PropertyMapper,
  type DatabasePropertySchema,
  type PeopleResolver,
  type WikilinkResolver,
} from "../notion/property-mapper.js";
import { compactNotionId } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";

type SchemaLoader = (databaseId: string) => Promise<Record<string, DatabasePropertySchema>>;

/**
 * DB 마다 스키마를 읽은 {@link PropertyMapper} 를 한 번만 만든다.
 *
 * 매퍼 하나에 스키마를 바꿔 끼우며(`loadSchema`) 쓰면, 워커 풀이 서로 다른 DB 의 행을
 * 동시에 밀 때 한 행이 다른 DB 의 스키마로 변환된다. 그래서 DB 마다 따로 둔다.
 *
 * 실행(push · pull)이 시작할 때 {@link clear} 로 비운다 — 그 사이 Notion 에서 속성이
 * 늘었으면 새 스키마를 읽어야 한다. 읽기에 실패한 DB 는 남기지 않아 다음 행이 다시 읽는다.
 */
export class RowSchemaCache {
  private readonly mappers = new Map<string, Promise<PropertyMapper>>();
  private people: Promise<PeopleResolver> | null = null;

  constructor(
    private readonly loadSchema: SchemaLoader,
    private readonly wikilinkResolver: WikilinkResolver,
    /** 빈 매퍼를 만든다 — 설정의 변환 옵션(시간대)을 따르게 호출측이 정한다. */
    private readonly createMapper: () => PropertyMapper = () => new PropertyMapper(),
    /** 사람 이름을 사용자 id 로 — 사람 속성이 있는 DB 를 처음 만날 때 한 번 읽는다. */
    private readonly loadPeople?: () => Promise<PeopleResolver>,
  ) {}

  mapperFor(databaseId: string): Promise<PropertyMapper> {
    const key = compactNotionId(databaseId);
    const cached = this.mappers.get(key);
    if (cached) return cached;

    const created = this.loadSchema(databaseId).then(async (schema) => {
      const mapper = this.createMapper();
      mapper.setWikilinkResolver(this.wikilinkResolver);
      mapper.loadSchema(schema);
      if (mapper.hasPeopleProperty()) mapper.setPeopleResolver(await this.peopleResolver());
      return mapper;
    });
    this.mappers.set(key, created);
    created.catch(() => {
      if (this.mappers.get(key) === created) this.mappers.delete(key);
    });
    return created;
  }

  clear(): void {
    this.mappers.clear();
    this.people = null;
  }

  /** 사용자 목록을 못 읽으면 이름은 풀지 않는다 — id 로 적힌 사람만 보낸다(예전 동작). */
  private peopleResolver(): Promise<PeopleResolver> {
    const load = this.loadPeople;
    if (!load) return Promise.resolve(() => null);
    return (this.people ??= load().catch((error: unknown) => {
      getLogger().warn(
        `[Im-Nobsidian] 사용자 목록을 읽지 못해 이름으로 적힌 사람 속성은 보내지 않습니다: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return () => null;
    }));
  }
}
