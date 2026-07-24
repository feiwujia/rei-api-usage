#!/usr/bin/env bash
set -euo pipefail

: "${REI_API_KEY:?Set REI_API_KEY first}"
repo=${1:?Usage: rei-usage-sync.sh /path/to/gitea-repo}
api_url=${REI_USAGE_URL:?Set REI_USAGE_URL}

for cmd in curl python3 git; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }
done
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl --fail --silent --show-error \
  --header "authorization: Bearer $REI_API_KEY" \
  "$api_url" >"$tmp"

files=(README.md usage-latest.json usage-history.jsonl)
if [[ -f "$repo/usage-latest.json" ]] &&
  python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1], encoding="utf-8-sig")) != json.load(open(sys.argv[2], encoding="utf-8-sig")))' "$tmp" "$repo/usage-latest.json" &&
  [[ -z "$(git -C "$repo" status --porcelain -- "${files[@]}")" ]]; then
  git -C "$repo" push
  exit 0
fi

python3 -m json.tool "$tmp" >"$repo/usage-latest.json.tmp"
mv "$repo/usage-latest.json.tmp" "$repo/usage-latest.json"
python3 - "$tmp" >"$repo/README.md.tmp" <<'PY'
import datetime, json, sys

with open(sys.argv[1], encoding="utf-8-sig") as f:
    data = json.load(f)

def text(value):
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, float):
        return f"{value:,.8f}".rstrip("0").rstrip(".")
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value).replace("|", "\\|").replace("\n", "<br>")

def render(title, value, level=2):
    print(f"\n{'#' * level} {title.replace('_', ' ').title()}\n")
    if isinstance(value, dict):
        scalars = [(k, v) for k, v in value.items() if not isinstance(v, (dict, list))]
        if scalars:
            print("| Field | Value |\n|---|---:|")
            for key, item in scalars:
                print(f"| {key} | {text(item)} |")
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                render(key, item, level + 1)
    elif isinstance(value, list) and value and all(isinstance(row, dict) for row in value):
        columns = list(dict.fromkeys(key for row in value for key in row))
        print("| " + " | ".join(columns) + " |")
        print("|" + "---|" * len(columns))
        for row in value:
            print("| " + " | ".join(text(row.get(column)) for column in columns) + " |")
    elif isinstance(value, list):
        for item in value:
            print(f"- {text(item)}")
    else:
        print(text(value))

print("# REI API Usage")
print(f"\nUpdated: `{datetime.datetime.now(datetime.timezone.utc).isoformat()}`")
print("\n[Latest JSON](./usage-latest.json) | [Usage history](./usage-history.jsonl)")
render("Overview", data)
PY
mv "$repo/README.md.tmp" "$repo/README.md"
python3 - "$tmp" >>"$repo/usage-history.jsonl" <<'PY'
import datetime, json, sys
with open(sys.argv[1], encoding="utf-8-sig") as f:
    data = json.load(f)
print(json.dumps({"fetched_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "data": data}, separators=(",", ":")))
PY

git -C "$repo" add -- "${files[@]}"
if ! git -C "$repo" diff --cached --quiet -- "${files[@]}"; then
  git -C "$repo" commit -m "Update API usage $(date -u +%FT%TZ)" -- "${files[@]}"
fi
git -C "$repo" push
