#!/usr/bin/env bash
#
# Test battery for the /hf endpoint's token budget behaviour.
#
# Reasoning models spend max_tokens on chain-of-thought before emitting any
# visible content, so a ceiling that is too low truncates mid-thought and
# returns finish_reason="length" with empty content — a total non-answer
# rather than a short one. These tests measure where that ceiling needs to be
# for a given prompt, and how much run-to-run variance there is around it.
#
# Start here — this one test confirms the mechanism and sizes the cap:
#   PROXY_URL=https://your-worker.workers.dev PAYLOAD=./real-request.json \
#     ./scripts/hf-max-tokens-test.sh
#
# The rest are follow-ups, only worth running if the first raises a question:
#   ./scripts/hf-max-tokens-test.sh clamp     # proxy cap + header behaviour
#   ./scripts/hf-max-tokens-test.sh sweep     # max_tokens sweep
#   ./scripts/hf-max-tokens-test.sh variance  # N runs at one cap -> distribution
#   ./scripts/hf-max-tokens-test.sh temp      # temperature 0 vs 0.6
#   ./scripts/hf-max-tokens-test.sh effort    # reasoning_effort low/medium/high
#
# Environment:
#   PROXY_URL   required, e.g. https://publicai-proxy.<subdomain>.workers.dev
#   MODEL       default openai/gpt-oss-20b
#   PAYLOAD     path to a JSON file with a .messages array — USE YOUR REAL
#               PROMPT. Reasoning length depends almost entirely on the actual
#               input; a toy prompt tells you nothing about your workload.
#   TEMP        default 0
#   REPEATS     default 8      (variance test)
#   VAR_TOKENS  default 16384  (variance test cap)
#   SLEEP       default 4      (proxy allows 20 req/min per IP)
#   OUTDIR      default ./hf-test-results — rows append across runs, but the
#               printed stats only ever cover the current invocation.

set -uo pipefail

PROXY_URL=${PROXY_URL:-}
MODEL=${MODEL:-openai/gpt-oss-20b}
PAYLOAD=${PAYLOAD:-}
TEMP=${TEMP:-0}
REPEATS=${REPEATS:-8}
VAR_TOKENS=${VAR_TOKENS:-16384}
SLEEP=${SLEEP:-4}
OUTDIR=${OUTDIR:-./hf-test-results}
CURL_TIMEOUT=${CURL_TIMEOUT:-120}

if [[ -z "$PROXY_URL" ]]; then
  echo "PROXY_URL is not set. Example:" >&2
  echo "  PROXY_URL=https://publicai-proxy.example.workers.dev $0 all" >&2
  exit 2
fi
for bin in curl jq; do
  command -v "$bin" >/dev/null || { echo "$bin is required but not installed" >&2; exit 2; }
done

mkdir -p "$OUTDIR"
TSV="$OUTDIR/results.tsv"
# Stamped on every row so a re-run's stats are never pooled with an earlier
# run's — pooling two different configs is exactly the error being measured.
RUN_ID=${RUN_ID:-$(date +%Y%m%dT%H%M%S)}
[[ -f "$TSV" ]] || printf 'test\tmodel\tfield\tmax_tokens\ttemp\teffort\thttp\tfinish\tcompletion_tok\tprompt_tok\treasoning_chars\tcontent_chars\tjson_ok\tsecs\tclamp_header\trun\n' > "$TSV"

# The default prompt is a stand-in only. Reasoning length is dominated by the
# real input, so pass PAYLOAD=<your file> to measure your actual workload.
if [[ -n "$PAYLOAD" ]]; then
  [[ -f "$PAYLOAD" ]] || { echo "PAYLOAD file not found: $PAYLOAD" >&2; exit 2; }
  MESSAGES=$(jq -c '.messages' "$PAYLOAD")
  [[ "$MESSAGES" == "null" ]] && { echo "PAYLOAD has no .messages array" >&2; exit 2; }
else
  echo "WARNING: no PAYLOAD set — using a small built-in prompt." >&2
  echo "         Results will NOT reflect your real 26k-token workload." >&2
  MESSAGES=$(jq -n '[
    {role:"system",content:"You verify whether a source supports a claim. Reply with JSON only: {\"confidence\":<0-100>,\"verdict\":\"SUPPORTED|PARTIALLY SUPPORTED|NOT SUPPORTED\",\"reason_type\":\"<string>\",\"comments\":\"<string>\"}"},
    {role:"user",content:"CLAIM: Agave plants are pollinated primarily by bats.\n\nSOURCE: The article describes nocturnal visitation of agave inflorescences by nectar-feeding bats in the Sonoran Desert, and notes that moths and hummingbirds also visit the flowers. It does not quantify the relative contribution of each visitor to seed set.\n\nDoes the source support the claim?"}
  ]')
fi

# ---------------------------------------------------------------------------

# run_once <label> <token_field> <token_value> <temp> <effort>
# Emits one aligned console line and one TSV row.
run_once() {
  local label=$1 field=$2 value=$3 temp=$4 effort=$5
  local body hdr resp http secs
  local finish ctok ptok reasoning content json_ok clamp

  body=$(jq -n \
    --arg model "$MODEL" \
    --argjson messages "$MESSAGES" \
    --arg field "$field" \
    --argjson value "$value" \
    --argjson temp "$temp" \
    --arg effort "$effort" \
    '{model:$model, messages:$messages, temperature:$temp}
     + {($field): $value}
     + (if $effort == "" then {} else {reasoning_effort:$effort} end)')

  hdr=$(mktemp)
  local start=$SECONDS
  resp=$(curl -sS -m "$CURL_TIMEOUT" -D "$hdr" -w '\n%{http_code}' \
    -X POST "$PROXY_URL/hf" \
    -H 'Content-Type: application/json' \
    -d "$body" 2>"$hdr.err")
  secs=$(( SECONDS - start ))

  http=$(printf '%s' "$resp" | tail -n1)
  local payload
  payload=$(printf '%s' "$resp" | sed '$d')

  # Set by the proxy when it reduced the requested budget. Its absence on an
  # over-cap request means the deployed worker predates the clamp fix.
  clamp=$(grep -i '^x-proxy-max-tokens-clamped:' "$hdr" | sed 's/^[^:]*: *//' | tr -d '\r')
  [[ -z "$clamp" ]] && clamp="-"

  if [[ -z "$http" || "$http" == "000" ]]; then
    http="ERR"; finish="-"; ctok=0; ptok=0; reasoning=0; content=0; json_ok="-"
    printf '  %-22s %-6s HTTP %-4s %s\n' "$label" "$value" "$http" "$(head -c 120 "$hdr.err")"
  else
    finish=$(jq -r '.choices[0].finish_reason // "-"' <<<"$payload" 2>/dev/null || echo "-")
    ctok=$(jq -r '.usage.completion_tokens // 0' <<<"$payload" 2>/dev/null || echo 0)
    ptok=$(jq -r '.usage.prompt_tokens // 0' <<<"$payload" 2>/dev/null || echo 0)

    local content_str reasoning_str
    content_str=$(jq -r '.choices[0].message.content // ""' <<<"$payload" 2>/dev/null || echo "")
    # Providers differ: gpt-oss uses .reasoning, some vLLM builds use
    # .reasoning_content, Qwen may inline <think>…</think> in content instead.
    reasoning_str=$(jq -r '.choices[0].message.reasoning // .choices[0].message.reasoning_content // ""' <<<"$payload" 2>/dev/null || echo "")
    if [[ -z "$reasoning_str" && "$content_str" == *"<think>"* ]]; then
      reasoning_str=$(sed -n 's/.*<think>\(.*\)<\/think>.*/\1/p' <<<"$content_str")
      content_str=$(perl -0pe 's/<think>.*?<\/think>//gs' <<<"$content_str" 2>/dev/null || echo "$content_str")
    fi
    reasoning=${#reasoning_str}
    content=${#content_str}

    # The real question for a JSON-output workload is not "did it stop" but
    # "did I get parseable output" — track that directly.
    if [[ -n "$content_str" ]] && jq -e . >/dev/null 2>&1 <<<"$content_str"; then
      json_ok="yes"
    else
      json_ok="no"
    fi

    printf '  %-22s %-6s HTTP %-4s finish=%-9s ctok=%-6s reason=%-7s content=%-6s json=%-4s %ss%s\n' \
      "$label" "$value" "$http" "$finish" "$ctok" "$reasoning" "$content" "$json_ok" "$secs" \
      "$([[ "$clamp" != "-" ]] && echo "  [clamped: $clamp]")"
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$MODEL" "$field" "$value" "$temp" "${effort:--}" "$http" "$finish" \
    "$ctok" "$ptok" "$reasoning" "$content" "$json_ok" "$secs" "$clamp" "$RUN_ID" >> "$TSV"

  rm -f "$hdr" "$hdr.err"
  sleep "$SLEEP"
}

hr() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------

# The focused test: repeat one identical request at a deliberately high cap.
#
# The claim under test is that max_tokens is a pure truncation point — it is
# never shown to the model, so it cannot change how long the model thinks. It
# only decides which draws from a fixed, high-variance distribution survive.
#
# Two falsifiable predictions:
#   1. Truncated runs report completion_tokens EXACTLY equal to the cap.
#      Hard truncation looks like that; a model choosing to stop does not.
#   2. Untruncated runs vary widely at a fixed cap, and that spread straddles
#      the old 4096 line — which is what made 4096-vs-8192 look causal when it
#      was really the same distribution sampled twice.
test_confirm() {
  hr "Mechanism check — $REPEATS identical runs at max_tokens=$VAR_TOKENS, temp=$TEMP"
  echo "   Identical request every time. Any spread below is the model, not the cap."
  for i in $(seq 1 "$REPEATS"); do
    run_once "variance-$i" max_tokens "$VAR_TOKENS" "$TEMP" ""
  done
  summarize_variance
  verdict_variance
}

# Reports whether the observed data matches the truncation model above.
verdict_variance() {
  local rows exact_cap n_trunc n straddle_lo straddle_hi slowest
  rows=$(awk -F'\t' -v r="$RUN_ID" '$1 ~ /^variance-/ && $16==r' "$TSV")
  n=$(wc -l <<<"$rows" | tr -d ' ')
  n_trunc=$(awk -F'\t' '$8=="length"' <<<"$rows" | wc -l | tr -d ' ')
  exact_cap=$(awk -F'\t' -v c="$VAR_TOKENS" '$8=="length" && $9==c' <<<"$rows" | wc -l | tr -d ' ')
  straddle_lo=$(awk -F'\t' '$8=="stop" && $9<4096' <<<"$rows" | wc -l | tr -d ' ')
  straddle_hi=$(awk -F'\t' '$9>4096' <<<"$rows" | wc -l | tr -d ' ')
  slowest=$(awk -F'\t' '{print $14}' <<<"$rows" | sort -n | tail -n1)

  printf '\n  \033[1mReading the result\033[0m\n'
  if [[ "$n_trunc" -gt 0 && "$exact_cap" == "$n_trunc" ]]; then
    echo "  [OK] All $n_trunc truncated run(s) stopped at exactly $VAR_TOKENS tokens."
    echo "       That is hard truncation, not the model deciding to stop."
  elif [[ "$n_trunc" -gt 0 ]]; then
    echo "  [??] $n_trunc truncated but only $exact_cap landed exactly on the cap."
    echo "       Worth a look — that is not what plain truncation produces."
  else
    echo "  [--] No run truncated at $VAR_TOKENS. This cap clears this prompt."
  fi

  if [[ "$straddle_lo" -gt 0 && "$straddle_hi" -gt 0 ]]; then
    echo "  [OK] $straddle_lo run(s) finished under 4096 and $straddle_hi went over it."
    echo "       Same request, same settings — so a 4096 cap was passing or failing"
    echo "       identical inputs at random. That is the coincidence you suspected."
  elif [[ "$straddle_hi" == 0 ]]; then
    echo "  [--] Every run stayed under 4096, so this prompt was not the one hitting"
    echo "       the old cap. Retry with your real PAYLOAD if you have not."
  else
    echo "  [--] Every run exceeded 4096 — this prompt failed at the old cap"
    echo "       essentially always, rather than intermittently."
  fi

  printf '\n  \033[1mPicking parameters\033[0m\n'
  echo "  Set the cap above the largest run you observe, with real margin — the"
  echo "  tail is long and $n runs only sketch it. Then handle finish_reason"
  echo "  =\"length\" in the client regardless: no cap makes truncation impossible."
  if [[ -n "$slowest" && "$slowest" -gt 45 ]]; then
    echo "  NOTE: slowest run took ${slowest}s. The worker aborts upstream at 60s"
    echo "        (HF_UPSTREAM_TIMEOUT_MS), so a high cap can turn a truncation"
    echo "        into a 504 instead. Raise that timeout if you raise the cap."
  fi
}

test_clamp() {
  hr "1. Clamp behaviour — is the proxy shortening my budget?"
  echo "   Expect X-Proxy-Max-Tokens-Clamped on the two over-cap requests."
  echo "   If it is absent there, the deployed worker predates the clamp fix."
  run_once "under-cap"        max_tokens            8192  "$TEMP" ""
  run_once "over-cap"         max_tokens           32768  "$TEMP" ""
  run_once "over-cap-altfield" max_completion_tokens 32768 "$TEMP" ""
}

test_sweep() {
  hr "2. Budget sweep — where does this prompt stop truncating?"
  echo "   finish=length with content=0 means the cap cut it off mid-reasoning."
  for mt in 1024 2048 4096 8192 16384; do
    run_once "sweep" max_tokens "$mt" "$TEMP" ""
  done
}

test_variance() {
  hr "3. Variance — $REPEATS identical runs at max_tokens=$VAR_TOKENS, temp=$TEMP"
  echo "   Same request every time. Spread in ctok is your real risk measure."
  for i in $(seq 1 "$REPEATS"); do
    run_once "variance-$i" max_tokens "$VAR_TOKENS" "$TEMP" ""
  done
  summarize_variance
}

summarize_variance() {
  # Sort externally rather than in awk: asort() is a gawk extension and is
  # absent from mawk and BSD awk (macOS).
  local sorted
  sorted=$(awk -F'\t' -v r="$RUN_ID" '$1 ~ /^variance-/ && $16==r {print $9}' "$TSV" | sort -n)
  if [[ -z "$sorted" ]]; then echo "  (no rows)"; return; fi

  local n min med max trunc ok
  n=$(wc -l <<<"$sorted" | tr -d ' ')
  min=$(head -n1 <<<"$sorted")
  max=$(tail -n1 <<<"$sorted")
  med=$(awk -v n="$n" 'NR==int((n+1)/2){print; exit}' <<<"$sorted")
  trunc=$(awk -F'\t' -v r="$RUN_ID" '$1 ~ /^variance-/ && $16==r && $8=="length"' "$TSV" | wc -l | tr -d ' ')
  ok=$(awk -F'\t' -v r="$RUN_ID" '$1 ~ /^variance-/ && $16==r && $13=="yes"' "$TSV" | wc -l | tr -d ' ')

  printf '\n  runs=%s  min=%s  median=%s  max=%s\n' "$n" "$min" "$med" "$max"
  printf '  truncated (finish=length): %s/%s\n' "$trunc" "$n"
  printf '  parseable JSON returned:   %s/%s\n' "$ok" "$n"
  awk -v cap="$VAR_TOKENS" -v mx="$max" -v mn="$min" 'BEGIN{
    printf "  spread: max is %.1fx the min\n", (mn>0 ? mx/mn : 0)
    if (mx >= cap) print "  WARNING: at least one run hit the cap — it is still too low for this prompt."
    else printf "  headroom: cap %d is %.1fx the largest observed run\n", cap, (mx>0 ? cap/mx : 0)
  }'
}

test_temp() {
  hr "4. Temperature — greedy decoding is not automatically safer"
  echo "   Qwen3 warns that greedy decoding in thinking mode can cause endless"
  echo "   repetition; that failure looks exactly like an undersized cap."
  for t in 0 0.6; do
    for i in 1 2 3; do
      run_once "temp-$t-$i" max_tokens "$VAR_TOKENS" "$t" ""
    done
  done
  awk -F'\t' -v RUN="$RUN_ID" '
    $16==RUN && $1 ~ /^temp-/ { split($1,p,"-"); t=p[2]; n[t]++; s[t]+=$9; if($9>mx[t]) mx[t]=$9; if($8=="length") tr[t]++ }
    END { print ""; for (t in n) printf "  temp=%-4s runs=%d  mean_ctok=%d  max_ctok=%d  truncated=%d\n", t, n[t], s[t]/n[t], mx[t], tr[t]+0 }
  ' "$TSV"
}

test_effort() {
  hr "5. reasoning_effort — the cheap lever when a run truncates"
  echo "   Unlike max_tokens, this actually changes how much the model thinks."
  for e in low medium high; do
    run_once "effort-$e" max_tokens "$VAR_TOKENS" "$TEMP" "$e"
  done
}

# ---------------------------------------------------------------------------

echo "proxy:   $PROXY_URL/hf"
echo "model:   $MODEL"
echo "payload: ${PAYLOAD:-<built-in sample>}"
echo "results: $TSV"

case "${1:-confirm}" in
  confirm)  test_confirm ;;
  clamp)    test_clamp ;;
  sweep)    test_sweep ;;
  variance) test_variance ;;
  temp)     test_temp ;;
  effort)   test_effort ;;
  all)      test_clamp; test_sweep; test_variance; test_temp; test_effort ;;
  *)        echo "unknown test: $1 (confirm|clamp|sweep|variance|temp|effort|all)" >&2; exit 2 ;;
esac

hr "Done. Full results: $TSV"
echo "Columns: test model field max_tokens temp effort http finish completion_tok"
echo "         prompt_tok reasoning_chars content_chars json_ok secs clamp_header run"
