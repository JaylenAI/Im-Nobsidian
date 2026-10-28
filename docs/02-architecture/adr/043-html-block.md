# ADR-043: Notion HTML 블록은 볼트의 `.html` 첨부로 주고받는다

> 상태: 승인
> 결정일: 2026-10-28

## 맥락

- 2026-07-03 changelog: `.html` 파일을 File Upload API 로 올려 embed 블록에 붙이면(`embed.file_upload`) Notion 이 그것을
  HTML 블록으로 그린다(격리된 iframe)
- 실측(2026-10-28, API 2025-09-03): 읽으면 `type: "embed"` 이고 `embed.url` 이 Notion 이 호스팅한 파일의 **서명 URL**(한
  시간 뒤 만료)이다. Markdown API 는 `<embed src="서명 URL">캡션</embed>` 로 준다. 만들 때는 다른 미디어와 같은 꼴
  `{ type: "file_upload", file_upload: { id }, caption }` 을 받는다
- 지금 pull 은 이 embed 를 바깥 embed 와 같이 `[🔗 Embed](서명 URL)` + 보존 마커로 남긴다 — 한 시간 뒤 볼트의 링크가 끊기고
  HTML 내용은 볼트에 없다. 볼트의 `![[a.html]]` 은 파일 블록으로 올라가 Notion 에서 그려지지 않는다
- 실측: 본문 교체(`replace_content`)에 받은 `<embed src="…">` 를 그대로(서명을 떼도) 실으면 Notion 이 그 HTML 블록을 그대로
  둔다(블록 id 같음)

## 결정

1. **pull** — 변환(`convertMediaTags`)이 Notion 이 호스팅한 파일의 embed 를 `[🌐 캡션](URL)` 로 옮기고(캡션이 없으면 자리
   이름 `html`), 받기(`downloadAllFiles`)가 다른 첨부처럼 내려받아 `![[attachments/….html|이름]]` 으로 적는다. 바깥 주소의
   embed 는 예전처럼 링크 · 보존 마커다
2. **push(새 파일)** — 노트의 `![[a.html]]` · `![[a.htm]]` 은 파일을 올려 HTML 블록(embed)으로 만든다(`isHtmlBlockFile`)
3. **push(받은 파일 그대로)** — 바뀌지 않은 첨부는 다시 올리지 않고 받은 `<embed src>` 를 실어 Notion 의 그 블록을 둔다
   (`keepUploadedMedia`, 미디어 태그 이름에 `embed` 를 더했다)
4. **받지 못했으면** — `[🌐 …](URL)` 링크가 남고, push 는 `<embed src>` 로 되돌려 Notion 의 블록을 둔다

## 트레이드오프

- 예전에 파일 블록으로 올라간 `.html` 은 파일이 바뀌어 다시 올릴 때 HTML 블록으로 바뀐다(Notion 에서 내려받기 대신 그려진다).
  바뀌지 않으면 그 파일 블록 그대로다
- 노트 밖 첨부(`syncFiles` 의 `file-handler`)는 파일 블록 그대로다 — 노트에 넣은 것만 그린다
- Obsidian 은 `![[a.html]]` 을 그리지 않는다(파일 링크로 보인다). 내용은 볼트에 그대로 있다

## 영향

- `utils/mime.ts` `isHtmlBlockFile` · `utils/notion-file-url.ts` `fileUrlOfBlock`(embed) · `converter/enhanced-md-converter.ts`
  (`🌐` 링크 ↔ `<embed>`) · `sync/image-handler.ts`(미디어 태그 · 라벨 · 블록 꼴)
