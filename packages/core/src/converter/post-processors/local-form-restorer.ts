import type {
  ConversionContext,
  Processor,
  ProcessorInput,
  ProcessorOutput,
} from "../../types/convert.js";
import { restoreLocalForm } from "../local-form.js";
import { splitFrontmatter } from "../../utils/frontmatter.js";

/** 노트를 push 가 보낼 꼴로 — 파이프라인이 자기로 만들어 넘긴다(`sentForm`). */
export type SentFormFn = (note: string, context: ConversionContext) => string;

/**
 * 받은 글에서 Notion 에 같은 모양으로 올라가는 자리를 받기 직전의 로컬 노트(`localContent`) 표기로
 * 되돌린다({@link restoreLocalForm}) — 콜아웃 접힘 · 종류 별칭, `<details>` · `<mark>`, frontmatter 의
 * 모양, 빈 줄 배치, 끝 줄바꿈(F-06 · S-30).
 *
 * pull 전용, 맨 끝(order 130) — 주석까지 되살린 글(CommentRestorer, 120)이어야 로컬 노트와 줄이 맞는다.
 * frontmatter 를 읽지 못하는 노트는 그대로 받는다 — push 가 frontmatter 째 본문으로 보내는 노트라, 바꿔 볼
 * 때마다 파이프라인이 실패를 적는다.
 */
export class LocalFormRestorer implements Processor {
  readonly name = "LocalFormRestorer";
  readonly order = 130;

  constructor(private readonly sent: SentFormFn) {}

  process(input: ProcessorInput): ProcessorOutput {
    const local = input.metadata.localContent;
    if (
      input.context.direction !== "pull" ||
      local === undefined ||
      !readable(local) ||
      !readable(input.content)
    ) {
      return { content: input.content, metadata: input.metadata };
    }
    // 줄을 섞어 본 노트의 frontmatter 가 깨질 수 있다 — push 의 눈으로 보지 않고 맞지 않는 노트로 친다.
    // 보면 파이프라인이 실패를 적는다. 받은 노트는 읽히므로 그 꼴(JSON 배열)과 같을 수 없다.
    const content = restoreLocalForm(input.content, local, (note) =>
      readable(note) ? this.sent(note, input.context) : UNREADABLE,
    );
    return { content, metadata: input.metadata };
  }
}

/** frontmatter 를 읽지 못하는 노트의 꼴 — `sentForm` 의 JSON 배열과 겹치지 않는다. */
const UNREADABLE = "";

function readable(note: string): boolean {
  try {
    splitFrontmatter(note);
    return true;
  } catch {
    return false;
  }
}
