/**
 * 데스크톱(Electron)의 Node 모듈 — 모바일 앱에는 Node 가 없다(P11, ADR-053).
 *
 * 플러그인 빌드는 core 와 의존성이 부르는 Node 모듈(`fs` · `path` · `crypto` · `os` · `url` · `events`)을 `shims/` 로
 * 잇는다(esbuild `alias`). 예전에는 main.js 가 처음에 `require("fs")` 를 불러 모바일에서는 플러그인이 아예 뜨지
 * 않았다. shim 은 데스크톱이면 진짜 모듈을 그대로 넘기고(예전과 같다), 모바일이면 갈음하는 구현을 쓴다. 갈음할 수
 * 없는 파일 시스템은 부를 때 까닭을 던진다 — 모바일 경로는 그것을 부르지 않는다(`Platform.isDesktopApp`).
 */
type NodeRequire = (id: string) => unknown;

/** 데스크톱의 Node 모듈 — 모바일이면(또는 읽지 못하면) undefined. */
export function nodeModule<T>(id: string): T | undefined {
  const load = (globalThis as { require?: NodeRequire }).require;
  if (typeof load !== "function") return undefined;
  try {
    return load(id) as T;
  } catch {
    return undefined;
  }
}

/** 모바일에서 부르면 안 되는 Node 함수 — 부르면 어디가 빠졌는지 알리며 던진다. */
export function desktopOnly(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`모바일에는 ${name} 이(가) 없음 — 데스크톱에서만 쓰는 길이 불렸습니다`);
  };
}
