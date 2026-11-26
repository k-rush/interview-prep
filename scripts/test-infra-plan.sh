set -euo pipefail
work=$(mktemp -d)
trap 'rm -f "$work/output" "$work/summary" "$work/applied"; rmdir "$work"' EXIT
export GITHUB_OUTPUT="$work/output" GITHUB_STEP_SUMMARY="$work/summary" APPLIED="$work/applied"
export PLANE=staging AZURE_RESOURCE_GROUP=fixture GITHUB_RUN_ID=123
export SCOPE=/subscriptions/fixture/resourceGroups/fixture
export PLAN='{"status":"Succeeded","changes":[{"resourceId":"x","changeType":"Modify","after":{"size":2}}]}'

az() {
  case "$1 $2 $3" in
    "group show --name") printf '%s\n' "$SCOPE" ;;
    "deployment group what-if") printf '%s\n' "$PLAN" ;;
    "deployment group create") printf '%s\n' "$*" > "$APPLIED" ;;
    *) return 1 ;;
  esac
}
export -f az
reject_apply() {
  if bash scripts/infra-plan.sh apply >/dev/null 2>&1 || [[ -e "$APPLIED" ]]; then
    echo "Unexpected infrastructure apply: $1" >&2; exit 1
  fi
}

bash scripts/infra-plan.sh preview
[[ ! -e "$APPLIED" ]]
APPROVED_PLAN=$(sed -n 's/^fingerprint=//p' "$GITHUB_OUTPUT")
export APPROVED_PLAN
[[ "$APPROVED_PLAN" =~ ^[a-f0-9]{64}$ ]]
PLAN='{"changes":[{"after":{"size":2},"changeType":"Modify","resourceId":"x"}],"status":"Succeeded"}' bash scripts/infra-plan.sh apply
[[ -s "$APPLIED" ]]
rm "$APPLIED"

APPROVED_PLAN='' reject_apply 'missing approval'
SCOPE=/subscriptions/other/resourceGroups/fixture reject_apply 'different subscription'
PLAN="${PLAN/\"size\":2/\"size\":3}" reject_apply 'same change count, different resource payload'
for invalid in '' '{}' '{"status":"Succeeded","changes":[]}' "${PLAN/Modify/Delete}" "${PLAN/Modify/Unsupported}"; do
  if PLAN="$invalid" bash scripts/infra-plan.sh preview >/dev/null 2>&1; then
    echo "Invalid what-if produced an approvable preview." >&2; exit 1
  fi
done
