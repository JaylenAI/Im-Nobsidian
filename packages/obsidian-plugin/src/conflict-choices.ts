import { isRemoteDeletion } from "@im-nobsidian/core";
import type { Conflict, ConflictStrategy, ResolutionChoice } from "@im-nobsidian/core";

type ChoiceText = { readonly label: string; readonly description: string };

/**
 * 충돌을 무엇으로 풀지 — 모달의 단추와 해결 알림이 같은 말을 쓴다. 적힌 순서대로 단추를 놓는다.
 * 설명은 Notion 에서 무슨 일이 일어나는지까지 말한다 — 고른 결과는 Notion 에 올라간다(N-06). Pull만 하는
 * 설정이면 올리지 않는다({@link choiceText}).
 */
export const RESOLUTION_CHOICES: Readonly<Record<ResolutionChoice, ChoiceText>> = {
  local: { label: "로컬 유지", description: "Obsidian 파일을 그대로 두고 Notion 에 올립니다" },
  remote: { label: "원격 유지", description: "Notion 버전으로 Obsidian 파일을 덮어씁니다" },
  merge: {
    label: "자동 병합",
    description: "두 변경을 3-way 병합해 양쪽에 씁니다 — 겹치는 줄은 충돌 표시로 남습니다",
  },
  duplicate: {
    label: "복제",
    description:
      "Obsidian 파일을 Notion 에 올리고, Notion 버전은 .conflict 파일로 남깁니다 — 이 파일은 올리지 않습니다",
  },
};

/**
 * 둘 다 바뀐 노트를 동기화가 어떻게 하나(`sync.conflictStrategy`) — 설정 화면의 고르개가 이 순서로 놓는다. 키가 엔진의 전략
 * 목록이라 전략이 늘면 여기서 타입 오류가 난다.
 */
export const CONFLICT_STRATEGY_TEXT: Readonly<Record<ConflictStrategy, ChoiceText>> = {
  manual: {
    label: "충돌로 남기기 (기본)",
    description: "둘 다 바뀐 노트는 충돌로 남겨 사이드바에서 하나씩 고릅니다.",
  },
  merge: {
    label: "다른 줄이면 합치기",
    description:
      "서로 다른 줄을 고쳤으면 두 변경을 합쳐 양쪽에 씁니다. 같은 줄을 다르게 고쳤으면 충돌로 남깁니다.",
  },
  "local-first": {
    label: "Obsidian 쪽 따르기",
    description:
      "Notion 의 변경은 받지 않고 노트를 Notion 에 올립니다 — Notion 쪽 변경은 사라집니다.",
  },
  "remote-first": {
    label: "Notion 쪽 따르기",
    description: "Notion 버전으로 노트를 덮어씁니다 — 노트에서 고친 것은 사라집니다.",
  },
  duplicate: {
    label: "둘 다 남기기",
    description:
      "노트를 Notion 에 올리고 Notion 버전은 옆에 .conflict 파일로 남깁니다 — 그 파일은 올리지 않습니다.",
  },
};

/**
 * Notion 에서 지운 노트의 충돌 — 같은 선택이 다른 일을 한다. 병합 · 복제는 합칠 원격 본문이 없어
 * 고를 수 없다(`applicableChoices`).
 */
const REMOTE_DELETION_CHOICES: Readonly<Partial<Record<ResolutionChoice, ChoiceText>>> = {
  local: {
    label: "로컬 유지",
    description: "Obsidian 파일을 그대로 두고 Notion 에 새 페이지로 다시 만듭니다",
  },
  remote: { label: "삭제 따르기", description: "Notion 에서 지운 대로 Obsidian 파일도 지웁니다" },
};

/** 받기 전용(Pull만) — 해소 결과를 Notion 에 올리지 않는다. 고른 것은 Obsidian 에만 남는다. */
const PULL_ONLY_CHOICES: Readonly<Partial<Record<ResolutionChoice, ChoiceText>>> = {
  local: {
    label: "로컬 유지",
    description: "Obsidian 파일을 그대로 둡니다 — Pull만 하는 설정이라 Notion 에는 올리지 않습니다",
  },
  merge: {
    label: "자동 병합",
    description:
      "두 변경을 3-way 병합해 Obsidian 파일에 씁니다 — Pull만 하는 설정이라 Notion 에는 올리지 않습니다",
  },
  duplicate: {
    label: "복제",
    description:
      "Obsidian 파일을 그대로 두고 Notion 버전은 .conflict 파일로 남깁니다 — Notion 에는 올리지 않습니다",
  },
};

const PULL_ONLY_REMOTE_DELETION_CHOICES: Readonly<Partial<Record<ResolutionChoice, ChoiceText>>> = {
  local: {
    label: "로컬 유지",
    description:
      "Obsidian 파일을 그대로 둡니다 — Pull만 하는 설정이라 Notion 에 다시 만들지 않습니다",
  },
};

/**
 * 이 충돌에서 그 선택이 무엇을 하는지 — 모달의 단추와 해결 알림이 같은 말을 쓴다.
 *
 * @param uploads 해소 결과를 Notion 에 올리는 설정인가. Pull만 하는 설정이면 올리지 않는다.
 */
export function choiceText(
  conflict: Conflict,
  choice: ResolutionChoice,
  uploads = true,
): ChoiceText {
  const deleted = isRemoteDeletion(conflict);
  const pullOnly = uploads
    ? undefined
    : (deleted ? PULL_ONLY_REMOTE_DELETION_CHOICES : PULL_ONLY_CHOICES)[choice];
  return (
    pullOnly ??
    (deleted ? REMOTE_DELETION_CHOICES[choice] : undefined) ??
    RESOLUTION_CHOICES[choice]
  );
}
