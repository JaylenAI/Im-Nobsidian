# Obsidian Plugin API 리서치

> 작성일: 2026-05-08
> 상태: draft
> Phase 1에서 상세 작성 예정

## Vault API

| 메서드 | 설명 |
|--------|------|
| `vault.create(path, data)` | 파일 생성 |
| `vault.read(file)` | 파일 읽기 |
| `vault.modify(file, data)` | 파일 수정 |
| `vault.rename(file, newPath)` | 파일 이동/이름변경 |
| `vault.delete(file)` | 파일 삭제 |
| `vault.trash(file, system)` | 휴지통으로 이동 |

## 이벤트 시스템

```typescript
this.registerEvent(this.app.vault.on('create', (file) => { ... }));
this.registerEvent(this.app.vault.on('modify', (file) => { ... }));
this.registerEvent(this.app.vault.on('delete', (file) => { ... }));
this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { ... }));
```

## 상세 조사 항목 (작성 예정)

- [ ] Plugin lifecycle (onload, onunload)
- [ ] Settings persistence (saveData, loadData)
- [ ] Modal, Setting Tab, Status Bar API
- [ ] Command 등록 방법
- [ ] Ribbon 아이콘 추가
- [ ] 제약사항 (fs 직접 접근 불가 등)
- [ ] Obsidian 커뮤니티 플러그인 제출 요구사항
