#!/usr/bin/env bash
# Run pi-memctx benchmark: same tasks with and without the extension.
# Measures token usage, tool calls, and response quality.
#
# Usage: bash benchmark/run.sh [base_dir]
#
# Prerequisites:
#   - pi installed
#   - bash benchmark/setup.sh already ran

set -euo pipefail

BASE_DIR="${1:-/tmp/pi-memctx-benchmark}"
RESULTS_DIR="$BASE_DIR/results"
EXTENSION_PATH="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p "$RESULTS_DIR"

if [ ! -d "$BASE_DIR/repos" ]; then
  echo "❌ Run setup first: bash benchmark/setup.sh"
  exit 1
fi

# ─────────────────────────────────────────────────────────
# Tasks to benchmark
# ─────────────────────────────────────────────────────────

TASKS=(
  "How do I deploy the gateway service to production?"
  "What database pattern does the transactions service use?"
  "What is the project architecture? What framework and language?"
  "How do I add a new Terraform module for SQS?"
  "What are the safe and dangerous commands for infrastructure?"
)

TASK_IDS=(
  "deploy"
  "database-pattern"
  "architecture"
  "terraform-module"
  "safe-commands"
)

# ─────────────────────────────────────────────────────────
# Run a single task and capture metrics
# ─────────────────────────────────────────────────────────

run_task() {
  local label="$1"    # "baseline" or "memctx"
  local task_id="$2"
  local prompt="$3"
  local extra_flags="${4:-}"

  local output_file="$RESULTS_DIR/${task_id}_${label}.txt"
  local metrics_file="$RESULTS_DIR/${task_id}_${label}_metrics.json"

  echo "  ⏱  Running: $task_id ($label)"

  local start_time
  start_time=$(date +%s%N)

  # Run pi in print mode with the task
  cd "$BASE_DIR/repos/novapay-api"
  timeout 120 pi -p $extra_flags "$prompt" > "$output_file" 2>&1 || true

  local end_time
  end_time=$(date +%s%N)
  local duration_ms=$(( (end_time - start_time) / 1000000 ))

  # Extract metrics from output
  local total_chars
  total_chars=$(wc -c < "$output_file" | tr -d ' ')

  local tool_calls
  tool_calls=$(grep -c '^ *\$ \|^bash\|^ *read ' "$output_file" 2>/dev/null || echo "0")

  local read_calls
  read_calls=$(grep -c '^ *read \|Reading:' "$output_file" 2>/dev/null || echo "0")

  local bash_calls
  bash_calls=$(grep -c '^ *\$ ' "$output_file" 2>/dev/null || echo "0")

  # Check for key facts in response (quality scoring)
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

  # Write metrics JSON
  cat > "$metrics_file" << METRICS_EOF
{
  "task": "$task_id",
  "mode": "$label",
  "duration_ms": $duration_ms,
  "output_chars": $total_chars,
  "tool_calls": $tool_calls,
  "bash_calls": $bash_calls,
  "read_calls": $read_calls,
  "quality_score": $score,
  "quality_max": $max_score
}
METRICS_EOF

  echo "     ✅ ${duration_ms}ms | ${tool_calls} tools | quality: ${score}/${max_score}"
}

# ─────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════"
echo "  pi-memctx Benchmark"
echo "═══════════════════════════════════════════════════"
echo ""
echo "Base dir:  $BASE_DIR"
echo "Extension: $EXTENSION_PATH"
echo "Tasks:     ${#TASKS[@]}"
echo ""

# --- Baseline (no extension) ---
echo "── Phase 1: Baseline (no pi-memctx) ──"
echo ""
for i in "${!TASKS[@]}"; do
  run_task "baseline" "${TASK_IDS[$i]}" "${TASKS[$i]}"
done

echo ""

# --- With pi-memctx ---
echo "── Phase 2: With pi-memctx ──"
echo ""

export MEMCTX_PACKS_PATH="$BASE_DIR/packs"

for i in "${!TASKS[@]}"; do
  run_task "memctx" "${TASK_IDS[$i]}" "${TASKS[$i]}" "-e $EXTENSION_PATH"
done

echo ""

# ─────────────────────────────────────────────────────────
# Results
# ─────────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════"
echo "  Results"
echo "═══════════════════════════════════════════════════"
echo ""

printf "%-20s │ %8s %8s │ %8s %8s │ %6s %6s │ %7s %7s\n" \
  "Task" "ms(base)" "ms(ctx)" "tools(b)" "tools(c)" "q(base)" "q(ctx)" "Δtools" "Δqual"
printf "%-20s─┼─%8s─%8s─┼─%8s─%8s─┼─%6s─%6s─┼─%7s─%7s\n" \
  "────────────────────" "────────" "────────" "────────" "────────" "──────" "──────" "───────" "───────"

total_base_tools=0
total_ctx_tools=0
total_base_quality=0
total_ctx_quality=0
total_base_ms=0
total_ctx_ms=0

for task_id in "${TASK_IDS[@]}"; do
  base="$RESULTS_DIR/${task_id}_baseline_metrics.json"
  ctx="$RESULTS_DIR/${task_id}_memctx_metrics.json"

  if [ ! -f "$base" ] || [ ! -f "$ctx" ]; then
    continue
  fi

  b_ms=$(python3 -c "import json; print(json.load(open('$base'))['duration_ms'])")
  c_ms=$(python3 -c "import json; print(json.load(open('$ctx'))['duration_ms'])")
  b_tools=$(python3 -c "import json; print(json.load(open('$base'))['tool_calls'])")
  c_tools=$(python3 -c "import json; print(json.load(open('$ctx'))['tool_calls'])")
  b_qual=$(python3 -c "import json; d=json.load(open('$base')); print(f\"{d['quality_score']}/{d['quality_max']}\")")
  c_qual=$(python3 -c "import json; d=json.load(open('$ctx')); print(f\"{d['quality_score']}/{d['quality_max']}\")")
  b_q=$(python3 -c "import json; print(json.load(open('$base'))['quality_score'])")
  c_q=$(python3 -c "import json; print(json.load(open('$ctx'))['quality_score'])")

  d_tools=$((c_tools - b_tools))
  d_qual=$((c_q - b_q))

  d_tools_str="${d_tools}"
  [ "$d_tools" -le 0 ] && d_tools_str="${d_tools}" || d_tools_str="+${d_tools}"
  d_qual_str="${d_qual}"
  [ "$d_qual" -le 0 ] && d_qual_str="${d_qual}" || d_qual_str="+${d_qual}"

  printf "%-20s │ %8s %8s │ %8s %8s │ %6s %6s │ %7s %7s\n" \
    "$task_id" "$b_ms" "$c_ms" "$b_tools" "$c_tools" "$b_qual" "$c_qual" "$d_tools_str" "$d_qual_str"

  total_base_tools=$((total_base_tools + b_tools))
  total_ctx_tools=$((total_ctx_tools + c_tools))
  total_base_quality=$((total_base_quality + b_q))
  total_ctx_quality=$((total_ctx_quality + c_q))
  total_base_ms=$((total_base_ms + b_ms))
  total_ctx_ms=$((total_ctx_ms + c_ms))
done

echo ""
echo "── Summary ──"
echo ""
echo "  Total tool calls:  baseline=$total_base_tools  memctx=$total_ctx_tools  (Δ=$((total_ctx_tools - total_base_tools)))"
echo "  Total quality:     baseline=$total_base_quality  memctx=$total_ctx_quality  (Δ=+$((total_ctx_quality - total_base_quality)))"
echo "  Total time (ms):   baseline=$total_base_ms  memctx=$total_ctx_ms"
echo ""
echo "  Results saved to: $RESULTS_DIR/"
echo ""
