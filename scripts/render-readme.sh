#!/usr/bin/env bash
# README.md 를 GitHub Markdown API 로 렌더링해 site/readme.html 로 저장.
#
# 동작:
#   1. README.md 를 jq 로 JSON 페이로드로 감싸 /markdown API 호출 (GFM 모드)
#   2. 상대링크(.md 파일, 디렉토리 경로)를 GitHub blob 절대 URL 로 치환
#   3. site/readme-template.html 의 {{CONTENT}} 자리에 끼워넣어 site/readme.html 생성
#
# 사용처:
#   - 로컬 미리보기:   bash scripts/render-readme.sh
#   - CI(Jekyll 워크플로우)에서 사이트 빌드 직전 자동 호출
#
# 요구사항: gh CLI, jq, GH_TOKEN 또는 인증된 gh

set -euo pipefail

cd "$(dirname "$0")/.."

REPO="project-hh-org/turtle-alert"
BLOB_BASE="https://github.com/${REPO}/blob/main"
README="README.md"
TEMPLATE="site/readme-template.html"
OUT="site/readme.html"

if [[ ! -f "$README" ]]; then
  echo "ERROR: $README 가 없습니다." >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: $TEMPLATE 가 없습니다." >&2
  exit 1
fi

echo "==> GitHub Markdown API 로 README 렌더링"
RENDERED=$(jq -Rs --arg ctx "$REPO" '{text: ., mode: "gfm", context: $ctx}' "$README" \
  | gh api -X POST /markdown --input -)

echo "==> 상대링크를 GitHub blob 절대 URL 로 치환"
# href="./FOO.md" 또는 href="FOO.md" → blob/main/FOO.md
# href="./docs/" 같은 디렉토리 링크도 동일하게 처리
RENDERED=$(printf '%s' "$RENDERED" | python3 -c "
import re, sys
html = sys.stdin.read()
blob = '${BLOB_BASE}'

# 1) href=\"./xxx\" 또는 href=\"xxx\" 형태 중, 절대 URL이나 앵커(#)나 mailto: 등이 아닌 것만 치환
def fix_href(m):
    quote = m.group(1)
    url = m.group(2)
    # 절대 URL, 앵커, 프로토콜은 그대로
    if url.startswith(('http://', 'https://', '#', 'mailto:', '/')):
        return m.group(0)
    # ./ 접두사 제거
    url_norm = url[2:] if url.startswith('./') else url
    return f'href={quote}{blob}/{url_norm}{quote}'

html = re.sub(r'href=([\"\\'])([^\"\\'#][^\"\\']*)\\1', fix_href, html)
sys.stdout.write(html)
")

echo "==> $OUT 작성"
# 템플릿의 {{CONTENT}} 자리에 렌더링 결과 삽입
python3 -c "
import sys, pathlib
tpl = pathlib.Path('${TEMPLATE}').read_text()
content = sys.stdin.read()
out = tpl.replace('{{CONTENT}}', content)
pathlib.Path('${OUT}').write_text(out)
" <<<"$RENDERED"

BYTES=$(wc -c < "$OUT" | tr -d ' ')
echo "==> 완료: $OUT (${BYTES} bytes)"
