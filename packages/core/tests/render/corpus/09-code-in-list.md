목록 안 코드블록이다. Notion 은 목록 자식 코드의 경계 펜스만 탭으로 들여쓰고 코드 줄은 열 0 에 둔다.

- 설치 순서
	```bash
npm install --save-dev vitest
npx vitest run
	```
- 설정 파일
	- 중첩 항목의 코드
		```json
{
  "compilerOptions": { "strict": true }
}
		```
1. 번호 항목의 코드
	```python
def greet(name):
    return f"hello {name}"
	```
2. 둘째 번호
- [ ] 할 일 항목의 코드
	```sh
echo "todo"
	```
- 자식 문단과 코드가 섞인 항목
	코드 앞에 오는 자식 문단이다.
	```go
func main() {
	fmt.Println("tab indented")
}
	```
	코드 뒤에 오는 자식 문단이다.
- 코드 속에 펜스 모양 줄이 있는 항목
	```markdown
예시 문서:
```bash
echo nested
```
끝
	```

목록이 끝난 뒤의 문단이다. 코드가 목록 밖으로 새면 이 문단 앞에 코드 줄이 문단으로 보인다.
