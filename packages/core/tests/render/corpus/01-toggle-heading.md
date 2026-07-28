### 배포 체크리스트 {toggle="true"}

    빌드 산출물을 확인하고 태그를 붙인 뒤 릴리스 노트를 작성한다.
    <details>
    <summary>롤백 절차</summary>
    	직전 태그로 되돌리고 마이그레이션을 역순으로 적용한다.
    	```bash

git checkout v1.2.3
pnpm build
```
</details>

### 관측 지표 {toggle="true"}

    <table>
    <tr>
    <td>지표</td>
    <td>임계값</td>
    </tr>
    <tr>
    <td>지연시간</td>
    <td>200ms</td>
    </tr>
    </table>

## 다음 섹션

토글 밖 형제 문단이다. 토글 자식으로 빨려 들어가면 안 된다.
