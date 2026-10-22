import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { restoreComments } from "../comments.js";

/**
 * 받기 직전의 로컬 노트(`localContent`)에서 주석을 되살린다 — 주석은 Notion 에 없는 로컬 글이다(S-29).
 * 받은 글과 로컬 노트를 줄 단위로 맞춰, 지운 자리에 지운 글을 그대로 끼운다({@link restoreComments}).
 *
 * 예전에는 push 때 남긴 마커의 앵커 줄 다음에 주석을 따로 한 줄로 끼웠다. 문장 속 주석이 줄 밖으로
 * 빠지고, 콜아웃 · 목록 속 주석이 `>` · 들여쓰기 없이 들어가 그 컨테이너를 끊었다. 로컬 노트가 없으면
 * (지운 노트를 되살리는 pull) 그 마커로 끼운다(`PreserveMarkerInjector`).
 *
 * pull 전용, 맨 끝(order 120) — 간격 정규화(BlockSpacer, 110)까지 마친 글이어야 로컬 노트의 줄과 맞는다.
 */
export class CommentRestorer implements Processor {
  readonly name = "CommentRestorer";
  readonly order = 120;

  process(input: ProcessorInput): ProcessorOutput {
    const local = input.metadata.localContent;
    if (input.context.direction !== "pull" || local === undefined) {
      return { content: input.content, metadata: input.metadata };
    }
    return { content: restoreComments(input.content, local), metadata: input.metadata };
  }
}
