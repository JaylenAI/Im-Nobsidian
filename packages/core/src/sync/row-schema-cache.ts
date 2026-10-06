import { PropertyMapper, type WikilinkResolver } from "../notion/property-mapper.js";
import { compactNotionId } from "../utils/id.js";

type SchemaLoader = (databaseId: string) => Promise<Record<string, { id: string; type: string }>>;

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

  constructor(
    private readonly loadSchema: SchemaLoader,
    private readonly wikilinkResolver: WikilinkResolver,
    /** 빈 매퍼를 만든다 — 설정의 변환 옵션(시간대)을 따르게 호출측이 정한다. */
    private readonly createMapper: () => PropertyMapper = () => new PropertyMapper(),
  ) {}

  mapperFor(databaseId: string): Promise<PropertyMapper> {
    const key = compactNotionId(databaseId);
    const cached = this.mappers.get(key);
    if (cached) return cached;

    const created = this.loadSchema(databaseId).then((schema) => {
      const mapper = this.createMapper();
      mapper.setWikilinkResolver(this.wikilinkResolver);
      mapper.loadSchema(schema);
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
  }
}
