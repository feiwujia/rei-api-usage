#!/usr/bin/env bash
set -euo pipefail
export TZ=Asia/Shanghai

: "${REI_API_KEY:?Set REI_API_KEY first}"
repo=${1:?Usage: rei-usage-sync.sh /path/to/gitea-repo}
api_url=${REI_USAGE_URL:?Set REI_USAGE_URL}

for cmd in curl python3 git; do
  command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }
done
git -C "$repo" rev-parse --is-inside-work-tree >/dev/null
data_dir="$repo/data"
mkdir -p "$data_dir"
for name in usage-latest.json usage-history.jsonl; do
  if [[ -f "$repo/$name" && ! -f "$data_dir/$name" ]]; then
    mv "$repo/$name" "$data_dir/$name"
  else
    rm -f "$repo/$name"
  fi
done

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl --fail --silent --show-error \
  --header "authorization: Bearer $REI_API_KEY" \
  "$api_url" >"$tmp"
fetched_at=$(date --iso-8601=seconds)

files=(README.md data usage-latest.json usage-history.jsonl)
data_changed=1
if [[ -f "$data_dir/usage-latest.json" ]] &&
  python3 -c 'import json,sys; sys.exit(json.load(open(sys.argv[1], encoding="utf-8-sig")) != json.load(open(sys.argv[2], encoding="utf-8-sig")))' "$tmp" "$data_dir/usage-latest.json"; then
  data_changed=0
fi

if (( data_changed )); then
  python3 -m json.tool "$tmp" >"$data_dir/usage-latest.json.tmp"
  mv "$data_dir/usage-latest.json.tmp" "$data_dir/usage-latest.json"
fi
python3 - "$tmp" "$fetched_at" >"$repo/README.md.tmp" <<'PY'
import json, sys

with open(sys.argv[1], encoding="utf-8-sig") as f:
    data = json.load(f)

if isinstance(data.get("daily_usage"), list):
    data["daily_usage"] = sorted(data["daily_usage"], key=lambda row: row.get("date", ""), reverse=True)
rate_limits = data.pop("rate_limits", None)

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
print(f"\nUpdated: `{sys.argv[2]}`")
print("\n[Latest JSON](./data/usage-latest.json) | [Usage history](./data/usage-history.jsonl)")
if rate_limits is not None:
    render("Rate Limits", rate_limits)
render("Overview", data)
PY
mv "$repo/README.md.tmp" "$repo/README.md"
if (( data_changed )); then
  python3 - "$tmp" "$fetched_at" >>"$data_dir/usage-history.jsonl" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8-sig") as f:
    data = json.load(f)
print(json.dumps({"fetched_at": sys.argv[2], "data": data}, separators=(",", ":")))
PY
fi

git -C "$repo" add -A -- "${files[@]}"
if ! git -C "$repo" diff --cached --quiet -- "${files[@]}"; then
  git -C "$repo" commit -m "Update API usage $fetched_at" -- "${files[@]}"
fi
git -C "$repo" push
