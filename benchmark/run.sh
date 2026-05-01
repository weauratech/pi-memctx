#!/usr/bin/env bash
# Run a local pi benchmark: same tasks WITHOUT memctx and WITH pi-memctx profile:full.
#
# This intentionally does not add any extension slash commands. It runs Pi in print
# mode and isolates the extension/config with environment variables.
#
# Usage:
#   bash benchmark/setup.sh [base_dir]
#   bash benchmark/run.sh [base_dir]
#
# Optional env:
#   BENCH_PROFILES="baseline full"   # default
#   BENCH_REPEATS=1                  # default
#   BENCH_PI_MODEL="provider/model"  # optional pass-through to pi --model
#   BENCH_TIMEOUT=180                # seconds per task

set -euo pipefail

BASE_DIR="${1:-/tmp/pi-memctx-benchmark}"
RESULTS_DIR="$BASE_DIR/results"
EXTENSION_PATH="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_PROFILES="${BENCH_PROFILES:-baseline full}"
BENCH_REPEATS="${BENCH_REPEATS:-1}"
BENCH_TIMEOUT="${BENCH_TIMEOUT:-180}"
BENCH_RUN_ID="$(date +%Y%m%d-%H%M%S)"
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
fi
SUMMARY_JSONL="$RESULTS_DIR/summary-$BENCH_RUN_ID.jsonl"
SUMMARY_MD="$RESULTS_DIR/report-$BENCH_RUN_ID.md"

mkdir -p "$RESULTS_DIR"

if [ ! -d "$BASE_DIR/repos" ]; then
  echo "❌ Run setup first: bash benchmark/setup.sh $BASE_DIR"
  exit 1
fi

add_model_args() {
  if [ -n "${BENCH_PI_MODEL:-}" ]; then
    printf '%s\0%s\0' --model "$BENCH_PI_MODEL"
  fi
}

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
    full)
      cat > "$config_path" <<'JSON'
{
  "profile": "full",
  "baseProfile": "full",
  "strict": true,
  "retrieval": "strict",
  "retrievalLatencyBudgetMs": 3000,
  "autosave": "auto",
  "autosaveQueueLowConfidence": false,
  "llm": "first",
  "autoSwitch": "all",
  "autoBootstrap": "ask",
  "startupDoctor": "full",
  "toolFailureHints": true
}
JSON
      ;;
    auto)
      cat > "$config_path" <<'JSON'
{
  "profile": "auto",
  "baseProfile": "auto",
  "strict": true,
  "retrieval": "auto",
  "retrievalLatencyBudgetMs": 1000,
  "autosave": "auto",
  "autosaveQueueLowConfidence": false,
  "llm": "assist",
  "autoSwitch": "all",
  "autoBootstrap": "ask",
  "startupDoctor": "light",
  "toolFailureHints": true
}
JSON
      ;;
    low)
      cat > "$config_path" <<'JSON'
{
  "profile": "low",
  "baseProfile": "low",
  "strict": false,
  "retrieval": "fast",
  "retrievalLatencyBudgetMs": 300,
  "autosave": "off",
  "autosaveQueueLowConfidence": false,
  "llm": "off",
  "autoSwitch": "cwd",
  "autoBootstrap": "ask",
  "startupDoctor": "off",
  "toolFailureHints": false
}
JSON
      ;;
    balanced)
      cat > "$config_path" <<'JSON'
{
  "profile": "balanced",
  "baseProfile": "balanced",
  "strict": true,
  "retrieval": "balanced",
  "retrievalLatencyBudgetMs": 1000,
  "autosave": "suggest",
  "autosaveQueueLowConfidence": false,
  "llm": "assist",
  "autoSwitch": "all",
  "autoBootstrap": "ask",
  "startupDoctor": "light",
  "toolFailureHints": true
}
JSON
      ;;
    *)
      echo "Unknown profile: $profile" >&2
      return 1
      ;;
  esac
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

count_tool_calls() {
  local output_file="$1"
  grep -Eic 'tool[_ -]?call|running tool|\$ |read\(|bash\(|edit\(|write\(' "$output_file" 2>/dev/null || true
}

run_one() {
  local profile="$1"
  local repeat="$2"
  local task_id="$3"
  local prompt="$4"

  local label="${profile}_r${repeat}"
  local output_file="$RESULTS_DIR/${task_id}_${label}.txt"
  local metrics_file="$RESULTS_DIR/${task_id}_${label}_metrics.json"
  local config_file="$RESULTS_DIR/memctx-config-${profile}-${repeat}.json"
  local session_dir="$RESULTS_DIR/sessions-${profile}-${repeat}-${task_id}"
  mkdir -p "$session_dir"

  echo "  ⏱  $task_id [$profile repeat=$repeat]"
  local start_ns end_ns duration_ms
  start_ns=$(date +%s%N)

  cd "$BASE_DIR/repos/novapay-api"
  if [ "$profile" = "baseline" ]; then
    cmd=(pi -p --no-session --no-extensions --no-prompt-templates --no-skills)
    if [ -n "${BENCH_PI_MODEL:-}" ]; then cmd+=(--model "$BENCH_PI_MODEL"); fi
    cmd+=("$prompt")
    if [ -n "$TIMEOUT_BIN" ]; then
      "$TIMEOUT_BIN" "$BENCH_TIMEOUT" "${cmd[@]}" > "$output_file" 2>&1 || true
    else
      "${cmd[@]}" > "$output_file" 2>&1 || true
    fi
  else
    profile_config "$profile" "$config_file"
    cmd=(pi -p --no-session --no-extensions --no-prompt-templates --no-skills -e "$EXTENSION_PATH")
    if [ -n "${BENCH_PI_MODEL:-}" ]; then cmd+=(--model "$BENCH_PI_MODEL"); fi
    cmd+=("$prompt")
    if [ -n "$TIMEOUT_BIN" ]; then
      MEMCTX_PACKS_PATH="$BASE_DIR/packs" \
      MEMCTX_CONFIG_PATH="$config_file" \
      "$TIMEOUT_BIN" "$BENCH_TIMEOUT" "${cmd[@]}" > "$output_file" 2>&1 || true
    else
      MEMCTX_PACKS_PATH="$BASE_DIR/packs" \
      MEMCTX_CONFIG_PATH="$config_file" \
      "${cmd[@]}" > "$output_file" 2>&1 || true
    fi
  fi

  end_ns=$(date +%s%N)
  duration_ms=$(( (end_ns - start_ns) / 1000000 ))

  local output_chars prompt_chars approx_output_tokens approx_prompt_tokens approx_visible_tokens tool_calls score max_score
  output_chars=$(wc -c < "$output_file" | tr -d ' ')
  prompt_chars=${#prompt}
  approx_output_tokens=$(( (output_chars + 3) / 4 ))
  approx_prompt_tokens=$(( (prompt_chars + 3) / 4 ))
  approx_visible_tokens=$(( approx_output_tokens + approx_prompt_tokens ))
  tool_calls=$(count_tool_calls "$output_file")
  read -r score max_score < <(score_quality "$task_id" "$output_file")

  cat > "$metrics_file" <<JSON
{
  "run_id": "$BENCH_RUN_ID",
  "task": "$task_id",
  "profile": "$profile",
  "repeat": $repeat,
  "duration_ms": $duration_ms,
  "prompt_chars": $prompt_chars,
  "output_chars": $output_chars,
  "approx_prompt_tokens": $approx_prompt_tokens,
  "approx_output_tokens": $approx_output_tokens,
  "approx_visible_tokens": $approx_visible_tokens,
  "tool_calls_observed": $tool_calls,
  "quality_score": $score,
  "quality_max": $max_score,
  "output_file": "$output_file"
}
JSON
  python3 -c "import json,sys; print(json.dumps(json.load(open(sys.argv[1])), separators=(',', ':')))" "$metrics_file" >> "$SUMMARY_JSONL"
  echo "     ✅ ${duration_ms}ms | ~${approx_visible_tokens} visible tokens | tools:${tool_calls} | quality:${score}/${max_score}"
}

write_report() {
  python3 - "$SUMMARY_JSONL" "$SUMMARY_MD" <<'PY'
import json, sys, collections, statistics
jsonl, md = sys.argv[1], sys.argv[2]
rows = [json.loads(line) for line in open(jsonl) if line.strip()]
by = collections.defaultdict(list)
for r in rows:
    by[r["profile"]].append(r)

def avg(xs): return sum(xs) / len(xs) if xs else 0
lines = []
lines.append("# pi-memctx local benchmark report\n")
lines.append("\n| Profile | Runs | Avg ms | Avg visible tokens* | Avg tools | Quality |\n|---|---:|---:|---:|---:|---:|\n")
for profile in sorted(by.keys()):
    rs = by[profile]
    q = sum(r['quality_score'] for r in rs)
    qm = sum(r['quality_max'] for r in rs)
    lines.append(f"| {profile} | {len(rs)} | {avg([r['duration_ms'] for r in rs]):.0f} | {avg([r['approx_visible_tokens'] for r in rs]):.0f} | {avg([r['tool_calls_observed'] for r in rs]):.1f} | {q}/{qm} |\n")
lines.append("\n*Visible tokens are approximated from prompt+output chars/4. Provider-side hidden/system/context tokens require provider/Pi usage instrumentation and are not included.\n")
if 'baseline' in by:
    b = by['baseline']
    for profile in sorted(k for k in by if k != 'baseline'):
        rs = by[profile]
        lines.append(f"\n## {profile} vs baseline\n")
        lines.append(f"- Δ avg ms: {avg([r['duration_ms'] for r in rs]) - avg([r['duration_ms'] for r in b]):+.0f}\n")
        lines.append(f"- Δ avg visible tokens: {avg([r['approx_visible_tokens'] for r in rs]) - avg([r['approx_visible_tokens'] for r in b]):+.0f}\n")
        lines.append(f"- Δ avg tools: {avg([r['tool_calls_observed'] for r in rs]) - avg([r['tool_calls_observed'] for r in b]):+.1f}\n")
        lines.append(f"- Δ quality: {sum(r['quality_score'] for r in rs) - sum(r['quality_score'] for r in b):+d}\n")
open(md, 'w').write(''.join(lines))
print('Report:', md)
PY
}

cat <<HEADER

═══════════════════════════════════════════════════
  pi-memctx Local Benchmark: baseline vs profiles
═══════════════════════════════════════════════════

Base dir:     $BASE_DIR
Extension:    $EXTENSION_PATH
Profiles:     $BENCH_PROFILES
Repeats:      $BENCH_REPEATS
Results dir:  $RESULTS_DIR
Run id:       $BENCH_RUN_ID

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
echo "Raw outputs:   $RESULTS_DIR/*_{baseline,full}_r*.txt"
echo ""
cat "$SUMMARY_MD"
