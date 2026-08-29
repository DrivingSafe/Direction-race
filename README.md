# 목적지 레이스 (방향키 버전)

150명이 QR로 접속해 방향키로 목적지까지 이동하는 개인전 레이스.
호스트 화면: `/host.html` (대형 스크린에 띄움)
참가자 화면: `/player.html` (각자 폰, QR로 접속)

## 로컬 테스트

```
npm install
npm start
```

브라우저에서 `http://localhost:3000/host.html` (대형화면용) 과
`http://localhost:3000/player.html` (참가자용, 여러 탭으로 테스트)을 각각 열어보세요.

## 실전 배포 (Render.com 기준, 무료)

1. 이 폴더 전체를 GitHub 저장소에 push
2. https://render.com 가입 → New → Web Service → 해당 저장소 선택
3. Build Command: `npm install`, Start Command: `npm start`
4. 배포 완료 후 나오는 URL (예: `https://xxx.onrender.com`)로 접속
   - 대형화면: `https://xxx.onrender.com/host.html`
   - 참가자: 호스트 화면에 자동으로 뜨는 QR을 그대로 스캔하면 됨 (URL 따로 안 적어도 됨)

## 행사 당일 체크리스트

- 무료 플랜은 오래 방치하면 서버가 잠들어서 첫 접속이 느릴 수 있음 → 행사 10분 전에 호스트 화면 미리 열어서 깨워두기, 또는 유료 플랜(월 7천원 내외)으로 올려서 리스크 제거
- 사내 와이파이가 150명 동시 접속을 버틸 수 있는지 사전 확인 (IT팀 문의)
- 참가자 데이터 전송량은 매우 작음(버튼 누름 여부만 전송) — 대부분의 지연은 와이파이 자체 이슈일 가능성이 큼

## 커스터마이징 포인트 (server.js 상단)

- `GOAL`: 목적지 위치/크기
- `OBSTACLES`: 벽(wall)과 슬로우존(slow) 배치, 개수/위치 자유롭게 조정
- `BASE_SPEED`: 이동 속도
