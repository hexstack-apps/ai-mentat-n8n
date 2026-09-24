#!/bin/sh
# Mutation check: reintroduce each bug and assert the suite goes RED.
# A green suite proves nothing until a broken build fails it.
cd "$(dirname "$0")/.." || exit 1
PASS=0; FAIL=0

mutate() {
  desc=$1; file=$2; from=$3; to=$4
  cp "$file" "$file.bak"
  python3 - "$file" "$from" "$to" <<'PY'
import sys
p,f,t=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p).read()
if f not in s:
    print("MUTATION-NOOP"); sys.exit(9)
open(p,'w').write(s.replace(f,t,1))
PY
  if [ $? -eq 9 ]; then
    echo "  SKIP (pattern absent — mutation is a no-op): $desc"
    mv "$file.bak" "$file"; FAIL=$((FAIL+1)); return
  fi
  if node --test 'test/*.js' >/dev/null 2>&1; then
    echo "  NOT CAUGHT: $desc"; FAIL=$((FAIL+1))
  else
    echo "  caught:     $desc"; PASS=$((PASS+1))
  fi
  mv "$file.bak" "$file"
}

echo "Mutation testing (each must be CAUGHT):"

# ── lib/n8n.js ────────────────────────────────────────────────────────────

mutate "dangling bun symlink returned as a runnable script" lib/n8n.js \
  "    if (resolved && exists(resolved)) return resolved;" \
  "    if (resolved) return resolved;"

mutate "N8N_HOST no longer binds for the tunnel" lib/n8n.js \
  "    N8N_HOST: '0.0.0.0'," \
  "    N8N_HOST: 'localhost',"

mutate "public URL vars set even with no domain configured" lib/n8n.js \
  "  if (domain) {" \
  "  if (domain !== null) {"

mutate "readiness probe accepts any 200 (port squatter reads as n8n)" lib/n8n.js \
  "  return statusCode === 200 && typeof body === 'string' && body.includes('n8n');" \
  "  return statusCode === 200;"

mutate "restart decision compares raw fields (whitespace bounces the server)" lib/n8n.js \
  "  const a = render(previous);
  const b = render(next);" \
  "  const a = { N8N_EDITOR_BASE_URL: (previous || {}).publicDomain };
  const b = { N8N_EDITOR_BASE_URL: (next || {}).publicDomain };"

# ── lib/mcp.js ────────────────────────────────────────────────────────────

mutate "empty API key registered as a blank value" lib/mcp.js \
  "  if (apiKey) args.push('-e', \`N8N_API_KEY=\${apiKey}\`);" \
  "  args.push('-e', \`N8N_API_KEY=\${apiKey}\`);"

mutate "npx cleanup wipes caches that never held n8n-mcp" lib/mcp.js \
  "  if (!hasPackageDir) return false;" \
  "  if (!hasPackageDir) return true;"

# ── lib/encryption-key.js ─────────────────────────────────────────────────

mutate "an unreadable key file is silently overwritten" lib/encryption-key.js \
  "    throw new Error(" \
  "    return { key: generateKey(randomBytes), created: true }; throw new Error("

mutate "key length floor removed" lib/encryption-key.js \
  "  return typeof value === 'string' && value.trim().length >= 32 && !/\s/.test(value.trim());" \
  "  return typeof value === 'string';"

mutate "an existing key is regenerated on every launch" lib/encryption-key.js \
  "    if (isUsableKey(existing)) return { key: existing.trim(), created: false };" \
  "    ;"


echo
echo "caught $PASS / $((PASS+FAIL))"
[ "$FAIL" -eq 0 ] || exit 1
