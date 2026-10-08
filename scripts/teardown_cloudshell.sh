#!/usr/bin/env bash
# Deletes everything scripts/setup_cloudshell.sh (or the setup guide) creates, in reverse order.
# Only touches resources with the workshop's names, and their IAM roles when nothing else uses them.
#
#   bash scripts/teardown_cloudshell.sh          # asks before deleting
#   bash scripts/teardown_cloudshell.sh --yes    # doesn't ask
#
# Uses the same settings as the setup script: AWS_REGION, BUCKET and POOL_NAME.
# You can run it again: anything already gone is skipped.

set -euo pipefail
export AWS_PAGER=""

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
none() { [ -z "$1" ] || [ "$1" = "None" ]; }
ctl() { aws bedrock-agentcore-control "$@"; }

# Waits until a command fails (the resource is gone), for up to 10 minutes.
wait_gone() {
  local _
  for _ in $(seq 120); do
    "$@" >/dev/null 2>&1 || return 0
    sleep 5
  done
  info "Still there after 10 minutes: $*"
}

# True when a Lambda function, gateway or harness in this region still uses IAM role $1, or when
# that can't be checked, so a role that something else needs is never deleted.
role_in_use() {
  local roles ids id
  roles=$(aws lambda list-functions --query 'Functions[].Role' --output text) || return 0
  ids=$(ctl list-gateways --query 'items[].gatewayId' --output text) || return 0
  for id in $ids; do
    roles+=" $(ctl get-gateway --gateway-identifier "$id" --query roleArn --output text)" || return 0
  done
  ids=$(ctl list-harnesses --query 'harnesses[].harnessId' --output text) || return 0
  for id in $ids; do
    roles+=" $(ctl get-harness --harness-id "$id" --query harness.executionRoleArn --output text)" || return 0
  done
  for id in $roles; do
    [ "${id##*/}" = "$1" ] && return 0
  done
  return 1
}

# Deletes IAM role $1 with its policies, including customer managed policies nothing else uses
# (the console makes some for each role).
delete_role() {
  local name=$1 policy version
  none "$name" && return 0
  aws iam get-role --role-name "$name" >/dev/null 2>&1 || return 0
  if role_in_use "$name"; then
    info "Kept IAM role $name: something else uses it"
    return 0
  fi
  for policy in $(aws iam list-role-policies --role-name "$name" --query PolicyNames --output text); do
    aws iam delete-role-policy --role-name "$name" --policy-name "$policy"
  done
  for policy in $(aws iam list-attached-role-policies --role-name "$name" --query 'AttachedPolicies[].PolicyArn' --output text); do
    aws iam detach-role-policy --role-name "$name" --policy-arn "$policy"
    case $policy in arn:aws:iam::aws:*) continue ;; esac
    [ "$(aws iam get-policy --policy-arn "$policy" --query Policy.AttachmentCount --output text)" = 0 ] || continue
    for version in $(aws iam list-policy-versions --policy-arn "$policy" --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
      aws iam delete-policy-version --policy-arn "$policy" --version-id "$version"
    done
    aws iam delete-policy --policy-arn "$policy"
  done
  aws iam delete-role --role-name "$name"
  info "Deleted IAM role $name"
}

# Deletes Lambda function $1, its log group and its role.
delete_lambda() {
  local role
  if ! role=$(aws lambda get-function-configuration --function-name "$1" --query Role --output text 2>/dev/null); then
    info "No Lambda function $1"
    return 0
  fi
  aws lambda delete-function-url-config --function-name "$1" 2>/dev/null || true
  aws lambda delete-function --function-name "$1"
  aws logs delete-log-group --log-group-name "/aws/lambda/$1" 2>/dev/null || true
  info "Deleted Lambda function $1"
  delete_role "${role##*/}"
}

delete_chat() {
  step "Step 9: chat page and sign-in"
  delete_lambda spend-agent-chat
  local pool
  pool=$(aws cognito-idp list-user-pools --max-results 60 --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)
  if none "$pool"; then
    info "No user pool $POOL_NAME"
  else
    aws cognito-idp delete-user-pool --user-pool-id "$pool"
    info "Deleted user pool $POOL_NAME ($pool) and its users"
  fi
}

delete_harness() {
  step "Step 7: harness spend_agent"
  local id role group
  id=$(ctl list-harnesses --query "harnesses[?harnessName=='spend_agent'].harnessId | [0]" --output text)
  if none "$id"; then
    info "No harness spend_agent"
  else
    role=$(ctl get-harness --harness-id "$id" --query harness.executionRoleArn --output text)
    ctl delete-harness --harness-id "$id" --delete-managed-memory >/dev/null
    info "Deleting harness $id and its memory..."
    wait_gone ctl get-harness --harness-id "$id"
    info "Deleted harness $id"
    delete_role "${role##*/}"
  fi
  for group in $(aws logs describe-log-groups --log-group-name-prefix /aws/bedrock-agentcore/runtimes/harness_spend_agent \
      --query 'logGroups[].logGroupName' --output text); do
    aws logs delete-log-group --log-group-name "$group"
  done
}

delete_gateway() {
  step "Step 6: gateway spend-agent-gateway"
  local id role target
  id=$(ctl list-gateways --query "items[?name=='spend-agent-gateway'].gatewayId | [0]" --output text)
  if none "$id"; then
    info "No gateway spend-agent-gateway"
    return 0
  fi
  role=$(ctl get-gateway --gateway-identifier "$id" --query roleArn --output text)
  for target in $(ctl list-gateway-targets --gateway-identifier "$id" --query 'items[].targetId' --output text); do
    ctl delete-gateway-target --gateway-identifier "$id" --target-id "$target" >/dev/null
    wait_gone ctl get-gateway-target --gateway-identifier "$id" --target-id "$target"
  done
  ctl delete-gateway --gateway-identifier "$id" >/dev/null
  wait_gone ctl get-gateway --gateway-identifier "$id"
  info "Deleted gateway $id and its targets"
  delete_role "${role##*/}"
}

delete_data() {
  step "Steps 2-4: tables, Athena workgroup and bucket"
  if aws glue get-database --name spend >/dev/null 2>&1; then
    aws glue delete-database --name spend
    info "Deleted database spend and its tables"
  fi
  if aws athena get-work-group --work-group spend-agent >/dev/null 2>&1; then
    aws athena delete-work-group --work-group spend-agent --recursive-delete-option
    info "Deleted workgroup spend-agent"
  fi
  if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    aws s3 rb "s3://$BUCKET" --force >/dev/null
    info "Deleted bucket $BUCKET and everything in it"
  else
    info "No bucket $BUCKET"
  fi
}

main() {
  REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
  export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  BUCKET=${BUCKET:-spend-agent-$ACCOUNT_ID-$REGION}
  POOL_NAME=${POOL_NAME:-spend-agent-chat}

  echo "This deletes the Spend Analysis Agent from account $ACCOUNT_ID, region $REGION:"
  echo "  Lambda spend-agent-chat, user pool $POOL_NAME, harness spend_agent with its memory,"
  echo "  gateway spend-agent-gateway, Lambda spend-agent-tools, their IAM roles,"
  echo "  database spend, workgroup spend-agent and bucket $BUCKET with all its data."
  if [ "${1:-}" != "--yes" ]; then
    read -r -p "Type delete to go on: " answer
    [ "$answer" = delete ] || { echo "Nothing deleted."; exit 1; }
  fi

  delete_chat
  delete_harness
  delete_gateway
  step "Step 5: Lambda spend-agent-tools"
  delete_lambda spend-agent-tools
  delete_data
  step "Done"
}

main "$@"
