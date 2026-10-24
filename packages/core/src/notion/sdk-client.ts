import { Client } from "@notionhq/client";

/**
 * 동기화가 쓴 페이지가 사람에게 알림을 보내나(2026-10-08 changelog «Control notifications from page writes»).
 *
 * - `silent` — 페이지 수정 · @멘션 · 사람 속성 알림을 보내지 않는다. DB 자동화 · 리마인더 · 웹훅은 그대로다
 * - `default` — Notion 이 정한 대로 보낸다
 */
export const NOTIFICATION_MODES = ["silent", "default"] as const;
export type NotificationMode = (typeof NOTIFICATION_MODES)[number];

type RequestParameters = Parameters<Client["request"]>[0];

/**
 * 알림을 고를 수 있는 쓰기 — 페이지 만들기 · 수정, 블록 추가. 본문 markdown 쓰기는 문서에 없다.
 * 읽기(GET)는 같은 경로라도 아니다.
 */
const NOTIFYING_WRITE_PATHS: readonly RegExp[] = [
  /^pages$/,
  /^pages\/[^/]+$/,
  /^blocks\/[^/]+\/children$/,
];

/**
 * 쓰기마다 `notifications.mode` 를 붙이는 SDK 클라이언트. SDK(5.28 까지)는 모르는 매개변수를 요청에서 걸러
 * 내므로, 모든 메서드가 지나는 `request` 에서 붙인다. `default` 면 요청을 바꾸지 않는다.
 */
export class SdkClient extends Client {
  constructor(
    options: ConstructorParameters<typeof Client>[0],
    private readonly notifications: NotificationMode,
  ) {
    super(options);
  }

  override request<ResponseBody extends object>(args: RequestParameters): Promise<ResponseBody> {
    return super.request<ResponseBody>(
      this.notifications === "default" ? args : withNotifications(args, this.notifications),
    );
  }
}

function withNotifications(args: RequestParameters, mode: NotificationMode): RequestParameters {
  if (args.method === "get") return args;
  if (!NOTIFYING_WRITE_PATHS.some((path) => path.test(args.path))) return args;
  return { ...args, body: { ...args.body, notifications: { mode } } };
}
