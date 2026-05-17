#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s <repo-url> [--broad]\n' "${0##*/}" >&2
}

normalize_url() {
  local url="$1"

  case "$url" in
    http://github.com/*) url="https://${url#http://}" ;;
  esac

  case "$url" in
    https://github.com/*)
      url="${url%/}"
      case "$url" in
        *.git) ;;
        *) url="$url.git" ;;
      esac
      ;;
  esac

  printf '%s\n' "$url"
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

mode="${2:-}"
if [ -n "$mode" ] && [ "$mode" != "--broad" ]; then
  usage
  exit 2
fi

url="$(normalize_url "$1")"
ref="HEAD"
store_dir="$(mktemp -d)"
cli=(deno run --allow-net --allow-read --allow-write src/cli.ts --store-dir "$store_dir")

tmp="$(mktemp)"
seen="$(mktemp)"
tree_cache_dir="$store_dir/trees"
mkdir -p "$tree_cache_dir"
trap 'rm -f "$tmp" "$seen"; rm -rf "$store_dir"' EXIT

candidate_paths() {
  local names exts prefixes name ext prefix

  names=(CLAUDE AGENTS GEMINI llm agent agents prompt prompts instruction instructions)
  exts=("" .md .txt .mdc .yaml .yml .json .toml)
  prefixes=("" .github/ .cursor/rules/)

  for prefix in "${prefixes[@]}"; do
    for name in "${names[@]}"; do
      for ext in "${exts[@]}"; do
        printf '%s%s%s\n' "$prefix" "$name" "$ext"
      done
    done
  done

  printf '%s\n' \
    .mcp.json \
    mcp.json \
    .cursorrules \
    .windsurfrules \
    .clinerules \
    .roomodes \
    .github/copilot-instructions.md

  if [ "$mode" = "--broad" ]; then
    names=(README CONTRIBUTING COPILOT instructions instruction rules rule prompts prompt mcp memory llm agent agents)
    for prefix in "${prefixes[@]}"; do
      for name in "${names[@]}"; do
        for ext in "" .md .txt .mdc .yaml .yml .json .toml; do
          printf '%s%s%s\n' "$prefix" "$name" "$ext"
        done
      done
    done
  fi
}

root_tree_sha() {
  "${cli[@]}" --verbose cat-commit "$url" --ref "$ref" \
    | while IFS=' ' read -r key value; do
        if [ "$key" = tree ]; then
          printf '%s\n' "$value"
          break
        fi
      done
}

cat_tree_cached() {
  local tree_sha="$1"
  local cache_file="$tree_cache_dir/$tree_sha"
  if [ ! -f "$cache_file" ]; then
    "${cli[@]}" --verbose cat-tree "$url" --tree-sha "$tree_sha" >"$cache_file"
  fi
  printf '%s\n' "$(<"$cache_file")"
}

lookup_path() {
  local path="$1"
  local tree_sha="$2"
  local rest="$path"
  local component entry_mode entry_sha entry_name

  while :; do
    component="${rest%%/*}"
    if [ "$component" = "$rest" ]; then
      while IFS=' ' read -r entry_mode entry_sha entry_name; do
        if [ "$entry_name" = "$component" ] && [ "$entry_mode" != 40000 ]; then
          printf '%s\n' "$entry_sha"
          return 0
        fi
      done < <(cat_tree_cached "$tree_sha")
      return 1
    fi

    while IFS=' ' read -r entry_mode entry_sha entry_name; do
      if [ "$entry_name" = "$component" ] && [ "$entry_mode" = 40000 ]; then
        tree_sha="$entry_sha"
        rest="${rest#*/}"
        continue 2
      fi
    done < <(cat_tree_cached "$tree_sha")
    return 1
  done
}

root_tree="$(root_tree_sha)"
while IFS= read -r path; do
  if [ -z "$path" ] || grep -Fxq -- "$path" "$seen"; then
    continue
  fi
  printf '%s\n' "$path" >>"$seen"
  if sha="$(lookup_path "$path" "$root_tree")"; then
    printf '%s %s\n' "$sha" "$path" >>"$tmp"
  fi
done < <(candidate_paths)

if [ ! -s "$tmp" ]; then
  printf 'No matching predefined agent/LLM rule files found on %s\n' "$ref" >&2
  exit 0
fi

while IFS=' ' read -r sha path; do
  printf '\n===== %s:%s =====\n' "$ref" "$path"
  "${cli[@]}" --verbose cat-blob "$url" "$sha"
  printf '\n'
done <"$tmp"
