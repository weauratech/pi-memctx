#!/usr/bin/env bash
# Run a local pi benchmark: same tasks WITHOUT memctx and WITH pi-memctx qmd-economy.
# Captures JSON-mode events so tool calls and provider token usage can be measured.
#
# Usage:
#   bash benchmark/setup.sh [base_dir]
#   bash benchmark/run.sh [base_dir]
#
# Optional env:
#   BENCH_PROFILES="baseline qmd-economy"  # default
#   BENCH_REPEATS=2                         # default
#   BENCH_PI_MODEL="provider/model"         # optional pass-through to pi --model
#   BENCH_TIMEOUT=180                       # seconds per task

set -euo pipefail

BASE_DIR="${1:-/tmp/pi-memctx-benchmark}"
RESULTS_DIR="$BASE_DIR/results"
EXTENSION_PATH="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_PROFILES="${BENCH_PROFILES:-baseline qmd-economy}"
BENCH_REPEATS="${BENCH_REPEATS:-2}"
BENCH_TIMEOUT="${BENCH_TIMEOUT:-180}"
BENCH_RUN_ID="$(date +%Y%m%d-%H%M%S)"
SUMMARY_JSONL="$RESULTS_DIR/summary-$BENCH_RUN_ID.jsonl"
SUMMARY_MD="$RESULTS_DIR/report-$BENCH_RUN_ID.md"

mkdir -p "$RESULTS_DIR"

if [ ! -d "$BASE_DIR/repos" ]; then
  echo "❌ Run setup first: bash benchmark/setup.sh $BASE_DIR"
  exit 1
fi

TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi

TASK_IDS=(
  "deploy"
  "database-pattern"
  "architecture"
  "terraform-module"
  "safe-commands"
)

TASKS=(
  "How do I deploy the gateway service to production?"
  "What database pattern does the transactions service use?"
  "What is the project architecture? What framework and language?"
  "How do I add a new Terraform module for SQS?"
  "What are the safe and dangerous commands for infrastructure?"
)

profile_config() {
  local profile="$1"
  local config_path="$2"
  case "$profile" in
    qmd-economy)
      cat > "$config_path" <<'JSON'
{
  "profile": "qmd-economy",
  "baseProfile": "qmd-economy",
  "strict": false,
  "retrieval": "fast",
  "retrievalLatencyBudgetMs": 250,
  "autosave": "off",
  "autosaveQueueLowConfidence": false,
  "llm": "off",
  "autoSwitch": "cwd",
  "autoBootstrap": "ask",
  "startupDoctor": "off",
  "toolFailureHints": false,
  "contextMode": "compact",
  "contextPipeline": "qmd-economy",
  "contextTokenBudget": 650,
  "contextMaxItems": 8,
  "contextStripMetadata": true
}
JSON
      ;;
    *) echo "Unknown profile for benchmark: $profile (supported: baseline qmd-economy)" >&2; return 1 ;;
  esac
}

run_pi_json() {
  local profile="$1"
  local prompt="$2"
  local json_file="$3"
  local config_file="$4"
  local cmd=(pi -p --mode json --no-session --no-extensions --no-prompt-templates --no-skills)

  if [ "$profile" != "baseline" ]; then
    cmd+=(-e "$EXTENSION_PATH")
  fi
  if [ -n "${BENCH_PI_MODEL:-}" ]; then
    cmd+=(--model "$BENCH_PI_MODEL")
  fi
  cmd+=("$prompt")

  cd "$BASE_DIR/repos/novapay-api"
  if [ "$profile" = "baseline" ]; then
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" "$BENCH_TIMEOUT" "${cmd[@]}" > "$json_file" 2>&1 || true
    else
      "${cmd[@]}" > "$json_file" 2>&1 || true
    fi
  else
    if [ -n "$TIMEOUT_BIN" ]; then
      MEMCTX_PACKS_PATH="$BASE_DIR/packs" MEMCTX_CONFIG_PATH="$config_file" \
        "$TIMEOUT_BIN" "$BENCH_TIMEOUT" "${cmd[@]}" > "$json_file" 2>&1 || true
    else
      MEMCTX_PACKS_PATH="$BASE_DIR/packs" MEMCTX_CONFIG_PATH="$config_file" \
        "${cmd[@]}" > "$json_file" 2>&1 || true
    fi
  fi
}

extract_json_metrics() {
  local json_file="$1"
  local text_file="$2"
  local metrics_tmp="$3"
  python3 - "$json_file" "$text_file" "$metrics_tmp" <<'PY'
import json, sys
json_file, text_file, metrics_file = sys.argv[1:4]
events=[]
for line in open(json_file, errors='ignore'):
    line=line.strip()
    if not line or not line.startswith('{'):
        continue
    try:
        events.append(json.loads(line))
    except Exception:
        pass
assistant_text=""
usage={"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0,"cost":{"total":0}}
for e in events:
    msg=e.get('message')
    if isinstance(msg, dict) and msg.get('role')=='assistant':
        parts=[]
        for c in msg.get('content') or []:
            if isinstance(c, dict) and c.get('type')=='text':
                parts.append(c.get('text') or '')
        if parts:
            assistant_text='\n'.join(parts)
        if isinstance(msg.get('usage'), dict):
            usage=msg['usage']
# Count actual tool executions. Assistant message updates repeat accumulated content,
# so only tool_execution_start is used to avoid duplicate counts.
tool_starts=0
tool_names=[]
failed_tools=0
for e in events:
    t=e.get('type','')
    if t == 'tool_execution_start':
        tool_starts += 1
        tool_names.append(e.get('toolName') or e.get('tool_name') or e.get('name') or 'tool')
    if t in ('tool_execution_end','tool_result') and (e.get('isError') or e.get('error')):
        failed_tools += 1
open(text_file,'w').write(assistant_text)
metrics={
  'json_events': len(events),
  'tool_calls_observed': tool_starts,
  'tool_names': tool_names,
  'failed_tool_calls_observed': failed_tools,
  'usage_input_tokens': int(usage.get('input') or 0),
  'usage_output_tokens': int(usage.get('output') or 0),
  'usage_cache_read_tokens': int(usage.get('cacheRead') or 0),
  'usage_cache_write_tokens': int(usage.get('cacheWrite') or 0),
  'usage_total_tokens': int(usage.get('totalTokens') or 0),
  'usage_cost_total': (usage.get('cost') or {}).get('total') or 0,
  'assistant_text_chars': len(assistant_text),
}
open(metrics_file,'w').write(json.dumps(metrics))
PY
}

score_quality() {
  local task_id="$1"
  local output_file="$2"
  local score=0
  local max_score=0
  case "$task_id" in
    deploy)
      max_score=5
      grep -qi "argocd\|argo" "$output_file" && ((score++)) || true
      grep -qi "github.actions\|ci/cd\|ci.cd" "$output_file" && ((score++)) || true
      grep -qi "ecr\|docker" "$output_file" && ((score++)) || true
      grep -qi "manual\|approval" "$output_file" && ((score++)) || true
      grep -qi "helm" "$output_file" && ((score++)) || true
      ;;
    database-pattern)
      max_score=4
      grep -qi "double.entry\|double-entry" "$output_file" && ((score++)) || true
      grep -qi "immutable\|append.only" "$output_file" && ((score++)) || true
      grep -qi "cents\|integer" "$output_file" && ((score++)) || true
      grep -qi "debit.*credit\|credit.*debit" "$output_file" && ((score++)) || true
      ;;
    architecture)
      max_score=5
      grep -qi "hexagonal\|ports.*adapters\|adapters.*ports" "$output_file" && ((score++)) || true
      grep -qi "go.*1\.24\|golang" "$output_file" && ((score++)) || true
      grep -qi "chi\|chi.router" "$output_file" && ((score++)) || true
      grep -qi "next\.js\|next.js\|nextjs" "$output_file" && ((score++)) || true
      grep -qi "postgresql\|postgres\|pgx" "$output_file" && ((score++)) || true
      ;;
    terraform-module)
      max_score=4
      grep -qi "modules/" "$output_file" && ((score++)) || true
      grep -qi "main\.tf\|variables\.tf" "$output_file" && ((score++)) || true
      grep -qi "terragrunt" "$output_file" && ((score++)) || true
      grep -qi "live/" "$output_file" && ((score++)) || true
      ;;
    safe-commands)
      max_score=4
      grep -qi "terragrunt plan" "$output_file" && ((score++)) || true
      grep -qi "terragrunt validate" "$output_file" && ((score++)) || true
      grep -qi "destroy" "$output_file" && ((score++)) || true
      grep -qi "dangerous\|caution\|never\|careful" "$output_file" && ((score++)) || true
      ;;
  esac
  echo "$score $max_score"
}

run_one() {
  local profile="$1"
  local repeat="$2"
  local task_id="$3"
  local prompt="$4"
  local label="${profile}_r${repeat}"
  local json_file="$RESULTS_DIR/${task_id}_${label}.jsonl"
  local text_file="$RESULTS_DIR/${task_id}_${label}.txt"
  local metrics_file="$RESULTS_DIR/${task_id}_${label}_metrics.json"
  local extracted_metrics="$RESULTS_DIR/${task_id}_${label}_events.json"
  local config_file="$RESULTS_DIR/memctx-config-${profile}-${repeat}.json"

  echo "  ⏱  $task_id [$profile repeat=$repeat]"
  if [ "$profile" != "baseline" ]; then profile_config "$profile" "$config_file"; fi

  local start_ns end_ns duration_ms
  start_ns=$(date +%s%N)
  run_pi_json "$profile" "$prompt" "$json_file" "$config_file"
  end_ns=$(date +%s%N)
  duration_ms=$(( (end_ns - start_ns) / 1000000 ))

  extract_json_metrics "$json_file" "$text_file" "$extracted_metrics"
  read -r score max_score < <(score_quality "$task_id" "$text_file")

  python3 - "$extracted_metrics" "$metrics_file" <<PY
import json, sys
extra=json.load(open(sys.argv[1]))
row={
  "run_id": "$BENCH_RUN_ID",
  "task": "$task_id",
  "profile": "$profile",
  "repeat": $repeat,
  "duration_ms": $duration_ms,
  "prompt_chars": ${#prompt},
  "quality_score": $score,
  "quality_max": $max_score,
  "output_file": "$text_file",
  "json_file": "$json_file",
}
row.update(extra)
row["approx_visible_tokens"]=(row["prompt_chars"] + row["assistant_text_chars"] + 3)//4
open(sys.argv[2],'w').write(json.dumps(row, indent=2)+"\n")
print(json.dumps(row, separators=(',', ':')))
PY
  tail -1 "$metrics_file" 2>/dev/null >/dev/null || true
  python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(',', ':')))" "$metrics_file" >> "$SUMMARY_JSONL"

  local total_tokens input_tokens output_tokens cache_read cache_write tool_calls failed_tools visible_tokens
  total_tokens=$(python3 -c "import json;print(json.load(open('$metrics_file'))['usage_total_tokens'])")
  input_tokens=$(python3 -c "import json;print(json.load(open('$metrics_file'))['usage_input_tokens'])")
  output_tokens=$(python3 -c "import json;print(json.load(open('$metrics_file'))['usage_output_tokens'])")
  cache_read=$(python3 -c "import json;print(json.load(open('$metrics_file'))['usage_cache_read_tokens'])")
  cache_write=$(python3 -c "import json;print(json.load(open('$metrics_file'))['usage_cache_write_tokens'])")
  tool_calls=$(python3 -c "import json;print(json.load(open('$metrics_file'))['tool_calls_observed'])")
  failed_tools=$(python3 -c "import json;print(json.load(open('$metrics_file'))['failed_tool_calls_observed'])")
  visible_tokens=$(python3 -c "import json;print(json.load(open('$metrics_file'))['approx_visible_tokens'])")

  echo "     ✅ ${duration_ms}ms | provider tokens:${total_tokens} (in:${input_tokens} out:${output_tokens} cacheR:${cache_read} cacheW:${cache_write}) | visible~${visible_tokens} | tools:${tool_calls}/${failed_tools} failed | quality:${score}/${max_score}"
}

write_report() {
  python3 - "$SUMMARY_JSONL" "$SUMMARY_MD" <<'PY'
import json, sys, collections
jsonl, md = sys.argv[1], sys.argv[2]
rows=[json.loads(line) for line in open(jsonl) if line.strip()]
by=collections.defaultdict(list)
for r in rows: by[r['profile']].append(r)
def avg(rs,k): return sum(r.get(k,0) for r in rs)/len(rs) if rs else 0
def total(rs,k): return sum(r.get(k,0) for r in rs)
lines=[]
lines.append('# pi-memctx local benchmark report\n')
lines.append('\n| Profile | Runs | Avg ms | Provider tokens | In | Out | Cache R/W | Visible* | Tools | Failed | Quality |\n')
lines.append('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n')
for p in sorted(by):
    rs=by[p]
    lines.append(f"| {p} | {len(rs)} | {avg(rs,'duration_ms'):.0f} | {avg(rs,'usage_total_tokens'):.0f} | {avg(rs,'usage_input_tokens'):.0f} | {avg(rs,'usage_output_tokens'):.0f} | {avg(rs,'usage_cache_read_tokens'):.0f}/{avg(rs,'usage_cache_write_tokens'):.0f} | {avg(rs,'approx_visible_tokens'):.0f} | {avg(rs,'tool_calls_observed'):.1f} | {avg(rs,'failed_tool_calls_observed'):.1f} | {total(rs,'quality_score')}/{total(rs,'quality_max')} |\n")
lines.append('\n*Visible tokens are approximated from prompt+assistant text chars/4. Provider tokens come from Pi JSON usage events.\n')
if 'baseline' in by:
    b=by['baseline']
    for p in sorted(k for k in by if k!='baseline'):
        rs=by[p]
        lines.append(f"\n## {p} vs baseline\n")
        for label,key in [('avg ms','duration_ms'),('provider tokens','usage_total_tokens'),('input tokens','usage_input_tokens'),('output tokens','usage_output_tokens'),('cache read','usage_cache_read_tokens'),('cache write','usage_cache_write_tokens'),('visible tokens','approx_visible_tokens'),('tools','tool_calls_observed'),('failed tools','failed_tool_calls_observed')]:
            lines.append(f"- Δ {label}: {avg(rs,key)-avg(b,key):+.1f}\n")
        lines.append(f"- Δ quality facts: {total(rs,'quality_score')-total(b,'quality_score'):+d}\n")
open(md,'w').write(''.join(lines))
print('Report:', md)
PY
}

cat <<HEADER

═══════════════════════════════════════════════════
  pi-memctx Local Benchmark: baseline vs qmd-economy
═══════════════════════════════════════════════════

Base dir:     $BASE_DIR
Extension:    $EXTENSION_PATH
Profiles:     $BENCH_PROFILES
Repeats:      $BENCH_REPEATS
Results dir:  $RESULTS_DIR
Run id:       $BENCH_RUN_ID
JSON mode:    enabled

HEADER

for repeat in $(seq 1 "$BENCH_REPEATS"); do
  echo "── Repeat $repeat/$BENCH_REPEATS ──"
  for profile in $BENCH_PROFILES; do
    echo "Profile: $profile"
    for i in "${!TASKS[@]}"; do
      run_one "$profile" "$repeat" "${TASK_IDS[$i]}" "${TASKS[$i]}"
    done
    echo ""
  done
done

write_report

echo ""
echo "Results JSONL: $SUMMARY_JSONL"
echo "Report:       $SUMMARY_MD"
echo "Raw JSONL:     $RESULTS_DIR/*_r*.jsonl"
echo "Raw text:      $RESULTS_DIR/*_r*.txt"
echo ""
cat "$SUMMARY_MD"
