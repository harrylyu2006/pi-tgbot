#!/bin/bash
# describe.sh — describe an image via OpenRouter Gemma 4 26B (free).
# Usage: describe.sh <image-path> [custom question]
set -euo pipefail

IMG="${1:?用法: describe.sh <图片路径> [问题]}"
QUESTION="${2:-详细描述这张图，用中文。读出关键文字、数字、界面元素、表格数据。}"
[ ! -f "$IMG" ] && { echo "❌ 文件不存在: $IMG" >&2; exit 1; }

# Locate agent auth.json or read environment variable
KEY="${OPENROUTER_API_KEY:-}"

if [ -z "$KEY" ]; then
  AUTH_PATHS=(
    "${PI_AGENT_DIR:-}/auth.json"
    "$HOME/.pi/agent/auth.json"
    "/var/lib/pi-tg/agent/auth.json"
  )
  for auth_file in "${AUTH_PATHS[@]}"; do
    if [ -n "$auth_file" ] && [ -f "$auth_file" ]; then
      KEY=$(python3 -c "
import json
try:
    d = json.load(open('$auth_file'))
    entry = d.get('openrouter', {})
    if isinstance(entry, dict):
        print(entry.get('key') or entry.get('apiKey') or '')
    elif isinstance(entry, str):
        print(entry)
except Exception:
    pass
" 2>/dev/null || true)
      if [ -n "$KEY" ]; then
        break
      fi
    fi
  done
fi

if [ -z "$KEY" ]; then
  echo "❌ 读不到 OpenRouter API key (请设置 OPENROUTER_API_KEY 环境变量或在 agentDir/auth.json 配置 openrouter.key)" >&2
  exit 2
fi

SIZE=$(stat -c %s "$IMG")
EXT="${IMG##*.}"
case "$EXT" in
  jpg|JPG|jpeg|JPEG) MIME="image/jpeg";;
  png|PNG) MIME="image/png";;
  gif|GIF) MIME="image/gif";;
  webp|WEBP) MIME="image/webp";;
  bmp|BMP) MIME="image/bmp";;
  *) MIME="image/jpeg";;
esac
echo "📷 读图: $IMG ($SIZE bytes, $MIME)" >&2

# Build the request JSON with python reading base64 from stdin (avoids
# ARG_MAX on large images — base64 of a 1MB image is ~1.4MB of arg text).
QUESTION="$QUESTION" KEY="$KEY" MIME="$MIME" IMG="$IMG" python3 <<'PYEOF'
import base64, json, os, sys, urllib.request, urllib.error

with open(os.environ["IMG"], "rb") as f:
    b64 = base64.b64encode(f.read()).decode()

payload = json.dumps({
    "model": "google/gemma-4-26b-a4b-it:free",
    "stream": False,
    "messages": [{"role": "user", "content": [
        {"type": "text", "text": os.environ["QUESTION"]},
        {"type": "image_url", "image_url": {"url": f'data:{os.environ["MIME"]};base64,{b64}'}}
    ]}],
    "max_tokens": 800
}).encode()

req = urllib.request.Request(
    "https://openrouter.ai/api/v1/chat/completions",
    data=payload,
    headers={
        "Authorization": f'Bearer {os.environ["KEY"]}',
        "Content-Type": "application/json"
    }
)
try:
    raw = urllib.request.urlopen(req, timeout=90).read().decode()
    d = json.loads(raw)
    if "error" in d:
        print("❌ OpenRouter 错误: " + json.dumps(d["error"], ensure_ascii=False)[:300], file=sys.stderr)
        sys.exit(3)
    print(d["choices"][0]["message"]["content"])
except urllib.error.HTTPError as e:
    body = e.read().decode()[:200]
    print(f"❌ HTTP {e.code}: {body}", file=sys.stderr)
    if e.code == 429:
        print("⏳ 免费层限流，等几秒重试", file=sys.stderr)
    sys.exit(4)
except Exception as e:
    print(f"❌ 请求失败: {e}", file=sys.stderr)
    sys.exit(5)
PYEOF
