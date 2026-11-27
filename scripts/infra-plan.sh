set -euo pipefail
case "${1:-}" in
  preview) ;;
  apply) [[ "${APPROVED_PLAN:-}" =~ ^[a-f0-9]{64}$ ]] || { echo "Missing approved preview." >&2; exit 1; } ;;
  *) echo "Expected preview or apply." >&2; exit 1 ;;
esac
case "$PLANE" in staging|production) ;; *) exit 1 ;; esac
[[ "$CONTROLLER_DIGEST" =~ ^sha256:[a-f0-9]{64}$ && -n "$SHARED_RESOURCE_GROUP" ]]
plan=$(mktemp)
trap 'rm -f "$plan"' EXIT
scope=$(az group show --name "$AZURE_RESOURCE_GROUP" --query id --only-show-errors -o tsv)
[[ "${scope,,}" =~ ^/subscriptions/[^/]+/resourcegroups/[^/]+$ ]]
target=(--resource-group "$AZURE_RESOURCE_GROUP" --name "infra-$GITHUB_RUN_ID" --mode Incremental
  --template-file infra/bicep/main.bicep --parameters "@infra/bicep/parameters/$PLANE.json"
  "sharedResourceGroup=$SHARED_RESOURCE_GROUP" "controllerDigest=$CONTROLLER_DIGEST")
az deployment group what-if "${target[@]}" --validation-level ProviderNoRbac \
  --result-format FullResourcePayloads --no-pretty-print --only-show-errors -o json > "$plan"
jq -es 'length == 1 and (.[0] | .status == "Succeeded" and .error == null
  and (.changes | type == "array" and length > 0)
  and any(.changes[]; .changeType != "Ignore")
  and all(.changes[]; (.resourceId | type == "string" and length > 0)
    and (.changeType | IN("Create", "Modify", "NoChange", "Ignore"))))' "$plan" > /dev/null ||
  { echo "Missing, destructive, or unsupported what-if result." >&2; exit 1; }
fingerprint=$(jq -cS --arg scope "${scope,,}" --arg plane "$PLANE" \
  '{scope: $scope, plane: $plane, changes: (.changes | sort_by(.resourceId))}' "$plan" | sha256sum | cut -d' ' -f1)
printf 'fingerprint=%s\n' "$fingerprint" >> "$GITHUB_OUTPUT"
printf 'Plane: `%s`. Preview: `%s`. Change counts (no resource payloads):\n' "$PLANE" "$fingerprint" >> "$GITHUB_STEP_SUMMARY"
jq -r '.changes | group_by(.changeType)[] | "- \(.[0].changeType): \(length)"' "$plan" >> "$GITHUB_STEP_SUMMARY"
if [[ "$1" == apply ]]; then
  [[ "$fingerprint" == "$APPROVED_PLAN" ]] || { echo "Target or plan changed. Start a new preview." >&2; exit 1; }
  az deployment group create "${target[@]}" --only-show-errors -o none
fi
