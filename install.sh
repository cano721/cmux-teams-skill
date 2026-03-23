#!/bin/bash
set -e

SKILL_DIR="$HOME/.claude/skills/cmux-teams"
REPO="https://raw.githubusercontent.com/cano721/cmux-teams-skill/main"

echo "📦 cmux-teams 스킬 설치 중..."

# 디렉토리 생성
mkdir -p "$SKILL_DIR"

# 필수 파일 다운로드
for f in SKILL.md cmux-teams-start.mjs watchdog.mjs; do
  curl -sL "$REPO/$f" -o "$SKILL_DIR/$f"
  echo "  ✓ $f"
done

echo ""
echo "✅ cmux-teams 스킬 설치 완료!"
echo ""
echo "사용법:"
echo "  /cmux-teams 2 \"task description\""
echo "  /cmux-teams status"
echo "  /cmux-teams cleanup"
echo ""
echo "📌 전제조건: cmux 앱이 실행 중이어야 합니다."
echo ""

# MCP 서버 설치 (선택)
read -p "MCP 서버도 설치할까요? (워커가 도구로 직접 API 호출 가능) [y/N] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
  curl -sL "$REPO/mcp-server.cjs" -o "$SKILL_DIR/mcp-server.cjs"
  cd "$SKILL_DIR"
  npm init -y > /dev/null 2>&1
  npm install @modelcontextprotocol/sdk > /dev/null 2>&1
  claude mcp add cmux-teams -s user -- node "$SKILL_DIR/mcp-server.cjs" 2>/dev/null
  echo "  ✓ MCP 서버 설치 + 등록 완료"
fi
