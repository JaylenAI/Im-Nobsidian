import { isRemoteDeletion } from "@im-nobsidian/core";
import type { Conflict, ResolutionChoice } from "@im-nobsidian/core";

type ChoiceText = { readonly label: string; readonly description: string };

/**
 * 충돌을 무엇으로 풀지 — 모달의 단추와 해결 알림이 같은 말을 쓴다. 적힌 순서대로 단추를 놓는다.
 * 설명은 Notion 에서 무슨 일이 일어나는지까지 말한다 — 고른 결과는 Notion 에 올라간다(N-06).
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
    description: "Obsidian 파일을 Notion 에 올리고, Notion 버전은 .conflict 파일로 남깁니다",
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

/** 이 충돌에서 그 선택이 무엇을 하는지 — 모달의 단추와 해결 알림이 같은 말을 쓴다. */
export function choiceText(conflict: Conflict, choice: ResolutionChoice): ChoiceText {
  return (
    (isRemoteDeletion(conflict) ? REMOTE_DELETION_CHOICES[choice] : undefined) ??
    RESOLUTION_CHOICES[choice]
  );
}
