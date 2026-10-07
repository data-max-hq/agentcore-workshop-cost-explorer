#!/usr/bin/env bash
# Builds the Spend Analysis Agent with the AWS CLI: setup guide Steps 2-9 in one go.
# Made for AWS CloudShell; works anywhere with AWS CLI v2 and python3.
#
#   cd <this repo> && bash scripts/setup_cloudshell.sh
#
# Optional settings, for example:  CHAT_USERS="anna ben carla" bash scripts/setup_cloudshell.sh
#   AWS_REGION   region to build in. CloudShell sets it to the console's region. Default us-east-1.
#   BUCKET       S3 bucket for the data. Default spend-agent-<account id>-<region>.
#   MODEL_ID     the agent's model. Default us.openai.gpt-5.5 (9/9 on the test questions). Claude needs an
#                AWS Marketplace subscription that workshop accounts can't make, and Amazon Nova Pro
#                breaks its tool calls ("Model produced invalid sequence as part of ToolUse").
#   CHAT_USERS   people who can sign in to the chat page. Default "anna ben".
#   POOL_NAME    Cognito user pool for the chat page. Default spend-agent-chat. An existing pool with this
#                name is reused, so set it to keep a pool you made with another name.
#   SKIP_CHAT=1  skip Step 9 (Cognito sign-in and the chat page).
#   SKIP_TEST=1  don't ask the agent a test question at the end.
#
# You can run it again: it reuses what already exists, including resources made in the console, and
# brings the code, policies, prompt and model up to date with this repo. It never deletes anything.

set -euo pipefail
export AWS_PAGER=""

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_QUESTION="Which department's spend grew the most last quarter?"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
none() { [ -z "$1" ] || [ "$1" = "None" ]; }
ctl() { aws bedrock-agentcore-control "$@"; }

# A policy file from the repo with the bucket name and region filled in.
policy() {
  sed -e "s/BUCKET_NAME/$BUCKET/g" \
      -e "s/arn:aws:\([a-z0-9-]*\):[a-z][a-z]-[a-z]*-[0-9]:/arn:aws:\1:$REGION:/g" "$REPO/$1"
}

# Runs a command, retrying for up to a minute while a new IAM role or policy spreads through AWS.
retry() {
  for _ in $(seq 12); do
    "$@" 2>"$WORK/err" && return 0
    grep -qiE "assume|role|permission|authoriz" "$WORK/err" || break
    sleep 5
  done
  cat "$WORK/err" >&2
  return 1
}

# Waits until a command prints READY. Returns 1 on a failed status.
wait_ready() {
  local what=$1 status=""
  shift
  for _ in $(seq 120); do
    status=$("$@")
    case $status in
      READY) return 0 ;;
      *FAILED*|*UNSUCCESSFUL*) return 1 ;;
    esac
    sleep 5
  done
  fail "$what is still $status after 10 minutes."
}

# --- IAM ---------------------------------------------------------------------

lambda_trust() {
  echo '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
}

# Trust policy for AgentCore. $1: the AgentCore resources that may use the role.
agentcore_trust() {
  cat <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock-agentcore.amazonaws.com"},
 "Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT_ID"},"ArnLike":{"aws:SourceArn":"$1"}}}]}
EOF
}

# Creates IAM role $1 with trust policy $2 unless it exists. Sets ROLE_ARN.
ensure_role() {
  if ROLE_ARN=$(aws iam get-role --role-name "$1" --query Role.Arn --output text 2>/dev/null); then
    return 0
  fi
  ROLE_ARN=$(aws iam create-role --role-name "$1" --assume-role-policy-document "$2" --query Role.Arn --output text)
  info "Created IAM role $1"
}

# The role of Lambda function $1: its current role if the function exists, else new role $2.
# Adds inline policy $3 with the contents of repo file $4. Sets ROLE_ARN.
lambda_role() {
  if ! ROLE_ARN=$(aws lambda get-function-configuration --function-name "$1" --query Role --output text 2>/dev/null); then
    ensure_role "$2" "$(lambda_trust)"
    aws iam attach-role-policy --role-name "$2" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  fi
  aws iam put-role-policy --role-name "${ROLE_ARN##*/}" --policy-name "$3" --policy-document "$(policy "$4")"
}

# What the harness needs to run: the same permissions as the role the console's Quick create makes,
# without the browser, code interpreter and file system tools this agent doesn't use.
harness_execution_policy() {
  cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid": "InvokeModels", "Effect": "Allow",
     "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:$REGION:$ACCOUNT_ID:*"]},
    {"Sid": "MantleInference", "Effect": "Allow", "Action": "bedrock-mantle:CreateInference",
     "Resource": "arn:aws:bedrock-mantle:$REGION:$ACCOUNT_ID:*"},
    {"Sid": "MantleBearerToken", "Effect": "Allow", "Action": "bedrock-mantle:CallWithBearerToken", "Resource": "*"},
    {"Sid": "PullHarnessImage", "Effect": "Allow",
     "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
     "Resource": "arn:aws:ecr:$REGION:*:repository/harness-*"},
    {"Sid": "ImageTokens", "Effect": "Allow",
     "Action": ["ecr:GetAuthorizationToken", "ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
     "Resource": "*"},
    {"Sid": "Tracing", "Effect": "Allow",
     "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
     "Resource": "*"},
    {"Sid": "LogGroups", "Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
     "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*"},
    {"Sid": "DescribeLogGroups", "Effect": "Allow", "Action": "logs:DescribeLogGroups",
     "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:*"},
    {"Sid": "LogStreams", "Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
     "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"},
    {"Sid": "LogResourcePolicy", "Effect": "Allow", "Action": "logs:PutResourcePolicy",
     "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/harness_spend_agent-*"},
    {"Sid": "Metrics", "Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
     "Condition": {"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}}},
    {"Sid": "WorkloadIdentity", "Effect": "Allow",
     "Action": ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
     "Resource": ["arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/default",
                  "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:workload-identity-directory/default/workload-identity/harness_spend_agent-*"]},
    {"Sid": "Memory", "Effect": "Allow",
     "Action": ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:GetEvent",
                "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords"],
     "Resource": "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:memory/spend_agent-*"}
  ]
}
EOF
}

# --- Lambda and Athena -------------------------------------------------------

# Creates or updates Lambda function $1 from source file $2, with the given runtime, handler,
# timeout (seconds) and environment (JSON). A new function gets role ROLE_ARN.
deploy_lambda() {
  local name=$1 source=$2 runtime=$3 handler=$4 timeout=$5 env=$6
  rm -f "$WORK/$name.zip"
  python3 -m zipfile -c "$WORK/$name.zip" "$source"
  if aws lambda get-function --function-name "$name" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$name" --zip-file "fileb://$WORK/$name.zip" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$name"
    aws lambda update-function-configuration --function-name "$name" --runtime "$runtime" --handler "$handler" \
      --timeout "$timeout" --environment "$env" >/dev/null
    aws lambda wait function-updated-v2 --function-name "$name"
    info "Updated Lambda function $name"
  else
    retry aws lambda create-function --function-name "$name" --role "$ROLE_ARN" --runtime "$runtime" \
      --handler "$handler" --timeout "$timeout" --environment "$env" --zip-file "fileb://$WORK/$name.zip" >/dev/null
    aws lambda wait function-active-v2 --function-name "$name"
    info "Created Lambda function $name"
  fi
}

# Adds a statement to a Lambda function's resource policy, unless one with that ID is already there.
add_permission() {
  aws lambda add-permission "$@" >/dev/null 2>"$WORK/err" && return 0
  grep -q ResourceConflictException "$WORK/err" || { cat "$WORK/err" >&2; return 1; }
}

# Runs one Athena query in the spend-agent workgroup, waits for it and prints its ID.
run_athena() {
  local id state
  id=$(aws athena start-query-execution --work-group spend-agent --query-string "$1" \
    --query QueryExecutionId --output text)
  while :; do
    state=$(aws athena get-query-execution --query-execution-id "$id" --query QueryExecution.Status.State --output text)
    case $state in
      SUCCEEDED) echo "$id"; return 0 ;;
      FAILED|CANCELLED)
        fail "Athena query failed: $(aws athena get-query-execution --query-execution-id "$id" \
          --query QueryExecution.Status.StateChangeReason --output text)" ;;
    esac
    sleep 2
  done
}

# --- The steps ---------------------------------------------------------------

check_setup() {
  step "Checking the setup"
  [ -f "$REPO/tools/lambda_function.py" ] && [ -d "$REPO/data/spend-data" ] \
    || fail "$REPO is not a copy of the repo (no tools/ or data/ folder)."
  aws bedrock-agentcore-control create-harness --generate-cli-skeleton >/dev/null 2>&1 || fail "This AWS CLI is too old \
for AgentCore harnesses. Update it, then run this script again:
  curl -s https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip && unzip -qo /tmp/awscli.zip -d /tmp && sudo /tmp/aws/install --update"
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  BUCKET=${BUCKET:-spend-agent-$ACCOUNT_ID-$REGION}
  info "Account $ACCOUNT_ID, region $REGION"
  info "Bucket $BUCKET, model $MODEL_ID"
  aws bedrock-runtime converse --model-id "$MODEL_ID" --messages '[{"role":"user","content":[{"text":"Say OK"}]}]' \
    --inference-config maxTokens=200 >/dev/null 2>"$WORK/err" \
    || fail "This account can't use model $MODEL_ID: $(tail -1 "$WORK/err")
Set MODEL_ID to a model it can use, for example: MODEL_ID=us.openai.gpt-5.5 bash $0"
}

step2_bucket() {
  step "Step 2: bucket $BUCKET with the spend data"
  if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    if [ "$REGION" = us-east-1 ]; then
      aws s3api create-bucket --bucket "$BUCKET" >/dev/null
    else
      aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
    info "Created the bucket"
  fi
  aws s3 sync "$REPO/data/spend-data" "s3://$BUCKET/spend-data/" --exclude "*.DS_Store" --only-show-errors
  aws s3api put-object --bucket "$BUCKET" --key athena-results/ >/dev/null
  info "Uploaded data/spend-data to s3://$BUCKET/spend-data/"
}

step3_athena() {
  step "Step 3: Athena workgroup spend-agent"
  local results="{\"OutputLocation\":\"s3://$BUCKET/athena-results/\"}"
  if aws athena get-work-group --work-group spend-agent >/dev/null 2>&1; then
    aws athena update-work-group --work-group spend-agent \
      --configuration-updates "{\"ResultConfigurationUpdates\":$results}"
    info "Workgroup exists; results go to s3://$BUCKET/athena-results/"
  else
    aws athena create-work-group --name spend-agent --configuration "{\"ResultConfiguration\":$results}"
    info "Created the workgroup"
  fi
}

step4_tables() {
  step "Step 4: database spend and its tables"
  if ! aws glue get-database --name spend >/dev/null 2>&1; then
    aws glue create-database --database-input Name=spend
    info "Created database spend"
  fi
  run_athena "CREATE EXTERNAL TABLE IF NOT EXISTS spend.department_spend (
    invoice_id string, invoice_date date, department string, category string,
    vendor string, amount_usd double)
  ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
  LOCATION 's3://$BUCKET/spend-data/department_spend/'
  TBLPROPERTIES ('skip.header.line.count'='1')" >/dev/null
  run_athena "CREATE EXTERNAL TABLE IF NOT EXISTS spend.budgets (
    department string, fiscal_quarter string, budget_usd double)
  ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
  LOCATION 's3://$BUCKET/spend-data/budgets/'
  TBLPROPERTIES ('skip.header.line.count'='1')" >/dev/null
  run_athena "CREATE EXTERNAL TABLE IF NOT EXISTS spend.aws_cost_export (
    bill_billing_period_start_date date, line_item_usage_start_date date,
    line_item_usage_account_id string, line_item_usage_account_name string,
    line_item_product_code string, line_item_usage_type string,
    line_item_operation string, line_item_line_item_type string,
    line_item_usage_amount double, pricing_unit string,
    line_item_unblended_rate double, line_item_unblended_cost double,
    line_item_currency_code string, product_region_code string,
    resource_tags_user_department string, resource_tags_user_environment string)
  ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
  LOCATION 's3://$BUCKET/spend-data/aws_cost_export/'
  TBLPROPERTIES ('skip.header.line.count'='1')" >/dev/null
  local id count
  id=$(run_athena "SELECT COUNT(*) FROM spend.aws_cost_export")
  count=$(aws athena get-query-results --query-execution-id "$id" \
    --query 'ResultSet.Rows[1].Data[0].VarCharValue' --output text)
  [ "$count" = 16882 ] || fail "spend.aws_cost_export has $count rows, not 16882. Check that its location \
in AWS Glue is s3://$BUCKET/spend-data/aws_cost_export/ (a table made earlier may point elsewhere)."
  info "Tables are ready: spend.aws_cost_export has 16882 rows"
}

step5_tools() {
  step "Step 5: Lambda spend-agent-tools"
  lambda_role spend-agent-tools "spend-agent-tools-role-$REGION" spend-agent-tools tools/lambda_policy.json
  deploy_lambda spend-agent-tools "$REPO/tools/lambda_function.py" python3.14 lambda_function.lambda_handler 60 \
    "{\"Variables\":{\"BUCKET\":\"$BUCKET\"}}"
  TOOLS_ARN=$(aws lambda get-function --function-name spend-agent-tools --query Configuration.FunctionArn --output text)
  for _ in $(seq 12); do  # a new inline policy can take a few seconds to apply
    aws lambda invoke --function-name spend-agent-tools --cli-binary-format raw-in-base64-out \
      --payload '{"tool": "run_query", "sql": "SELECT department, SUM(amount_usd) AS total FROM department_spend GROUP BY department"}' \
      "$WORK/tools-test.json" >/dev/null
    grep -q '"error"' "$WORK/tools-test.json" || break
    sleep 5
  done
  grep -q '"error"' "$WORK/tools-test.json" && fail "The tools Lambda test failed: $(cat "$WORK/tools-test.json")"
  info "Test query OK: $(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["rows"]))' \
    "$WORK/tools-test.json") departments"
}

step6_gateway() {
  step "Step 6: gateway spend-agent-gateway"
  GATEWAY_ID=$(ctl list-gateways --query "items[?name=='spend-agent-gateway'].gatewayId | [0]" --output text)
  if none "$GATEWAY_ID"; then
    ensure_role "spend-agent-gateway-role-$REGION" \
      "$(agentcore_trust "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:gateway/spend-agent-gateway-*")"
  else
    ROLE_ARN=$(ctl get-gateway --gateway-identifier "$GATEWAY_ID" --query roleArn --output text)
  fi
  aws iam put-role-policy --role-name "${ROLE_ARN##*/}" --policy-name invoke-spend-tools \
    --policy-document "$(policy tools/gateway_policy.json)"
  aws iam put-role-policy --role-name "${ROLE_ARN##*/}" --policy-name get-spend-gateway --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"bedrock-agentcore:GetGateway\",\"Resource\":\"arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:gateway/spend-agent-gateway-*\"}]}"
  if none "$GATEWAY_ID"; then
    GATEWAY_ID=$(retry ctl create-gateway --name spend-agent-gateway --role-arn "$ROLE_ARN" --protocol-type MCP \
      --authorizer-type AWS_IAM --exception-level DEBUG --query gatewayId --output text)
    info "Created gateway $GATEWAY_ID"
  fi
  wait_ready gateway ctl get-gateway --gateway-identifier "$GATEWAY_ID" --query status --output text \
    || fail "The gateway failed: $(ctl get-gateway --gateway-identifier "$GATEWAY_ID" --query statusReasons --output text)"
  GATEWAY_ARN=$(ctl get-gateway --gateway-identifier "$GATEWAY_ID" --query gatewayArn --output text)

  python3 - "$TOOLS_ARN" "$REPO/tools/tool_schemas.json" >"$WORK/target.json" <<'EOF'
import json, sys
schemas = json.load(open(sys.argv[2]))
print(json.dumps({"mcp": {"lambda": {"lambdaArn": sys.argv[1], "toolSchema": {"inlinePayload": schemas}}}}))
EOF
  local creds='[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' target
  target=$(ctl list-gateway-targets --gateway-identifier "$GATEWAY_ID" \
    --query "items[?name=='spend-tools'].targetId | [0]" --output text)
  if none "$target"; then
    target=$(ctl create-gateway-target --gateway-identifier "$GATEWAY_ID" --name spend-tools \
      --target-configuration "file://$WORK/target.json" --credential-provider-configurations "$creds" \
      --query targetId --output text)
    info "Created target spend-tools"
  else
    ctl update-gateway-target --gateway-identifier "$GATEWAY_ID" --target-id "$target" --name spend-tools \
      --target-configuration "file://$WORK/target.json" --credential-provider-configurations "$creds" >/dev/null
    info "Updated target spend-tools"
  fi
  # A target made right after its permission was added can fail once; try it again, as in guide step 6.8.
  for _ in 1 2 3; do
    wait_ready "gateway target" ctl get-gateway-target --gateway-identifier "$GATEWAY_ID" --target-id "$target" \
      --query status --output text && return 0
    info "Target not ready yet: $(ctl get-gateway-target --gateway-identifier "$GATEWAY_ID" --target-id "$target" \
      --query statusReasons --output text). Trying again."
    sleep 15
    ctl update-gateway-target --gateway-identifier "$GATEWAY_ID" --target-id "$target" --name spend-tools \
      --target-configuration "file://$WORK/target.json" --credential-provider-configurations "$creds" >/dev/null
  done
  fail "The gateway target spend-tools didn't become ready."
}

step7_harness() {
  step "Step 7: harness spend_agent"
  python3 - "$REPO/agent/system_prompt.md" >"$WORK/prompt.json" <<'EOF'
import json, sys
print(json.dumps([{"text": open(sys.argv[1]).read()}]))
EOF
  local model tools memory
  model="{\"bedrockModelConfig\":{\"modelId\":\"$MODEL_ID\",\"apiFormat\":\"converse_stream\"}}"
  tools="[{\"type\":\"agentcore_gateway\",\"name\":\"$GATEWAY_ID\",\"config\":{\"agentCoreGateway\":{\"gatewayArn\":\"$GATEWAY_ARN\",\"outboundAuth\":{\"awsIam\":{}}}}}]"
  HARNESS_ID=$(ctl list-harnesses --query "harnesses[?harnessName=='spend_agent'].harnessId | [0]" --output text)
  if none "$HARNESS_ID"; then
    ensure_role "spend-agent-harness-role-$REGION" "$(agentcore_trust "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:*")"
    aws iam put-role-policy --role-name "${ROLE_ARN##*/}" --policy-name harness-execution \
      --policy-document "$(harness_execution_policy)"
    aws iam put-role-policy --role-name "${ROLE_ARN##*/}" --policy-name invoke-spend-gateway \
      --policy-document "$(policy agent/harness_policy.json)"
    HARNESS_ID=$(retry ctl create-harness --harness-name spend_agent --execution-role-arn "$ROLE_ARN" \
      --model "$model" --system-prompt "file://$WORK/prompt.json" --tools "$tools" \
      --memory '{"managedMemoryConfiguration":{"strategies":["SEMANTIC","SUMMARIZATION"],"eventExpiryDuration":30}}' \
      --query harness.harnessId --output text)
    info "Created harness $HARNESS_ID"
  else
    ROLE_ARN=$(ctl get-harness --harness-id "$HARNESS_ID" --query harness.executionRoleArn --output text)
    aws iam put-role-policy --role-name "${ROLE_ARN##*/}" --policy-name invoke-spend-gateway \
      --policy-document "$(policy agent/harness_policy.json)"
    ctl update-harness --harness-id "$HARNESS_ID" --model "$model" --system-prompt "file://$WORK/prompt.json" \
      --tools "$tools" >/dev/null
    info "Updated harness $HARNESS_ID: model, prompt and gateway"
  fi
  wait_ready harness ctl get-harness --harness-id "$HARNESS_ID" --query harness.status --output text \
    || fail "The harness failed: $(ctl get-harness --harness-id "$HARNESS_ID" --output json)"
  HARNESS_ARN=$(ctl get-harness --harness-id "$HARNESS_ID" --query harness.arn --output text)
  # shellcheck disable=SC2016  # backticks are a JMESPath literal, not a shell command
  memory=$(ctl get-harness --harness-id "$HARNESS_ID" --query 'keys(harness.memory || `{}`) | [0]' --output text)
  if none "$memory" || [ "$memory" = disabled ]; then
    info "Warning: the harness has no memory. Turn it on in the console (Step 7)."
  fi
}

step9_chat() {
  step "Step 9: sign-in and chat page"
  POOL_ID=$(aws cognito-idp list-user-pools --max-results 60 \
    --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text)
  if none "$POOL_ID"; then
    POOL_ID=$(aws cognito-idp create-user-pool --pool-name "$POOL_NAME" \
      --admin-create-user-config AllowAdminCreateUserOnly=true --query UserPool.Id --output text)
    info "Created user pool $POOL_ID"
  fi
  local required
  required=$(aws cognito-idp describe-user-pool --user-pool-id "$POOL_ID" \
    --query "UserPool.SchemaAttributes[?Required && Name!='sub'].Name" --output text)
  none "$required" || info "Warning: user pool $POOL_NAME requires: $required. The first sign-in will fail \
until each user has these set (see the guide, Step 9)."

  CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" \
    --query "UserPoolClients[?ClientName=='spend-agent-chat'].ClientId | [0]" --output text)
  if none "$CLIENT_ID"; then
    CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name spend-agent-chat \
      --no-generate-secret --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
      --prevent-user-existence-errors ENABLED --enable-token-revocation --query UserPoolClient.ClientId --output text)
    info "Created app client $CLIENT_ID"
  fi

  NEW_USERS=""
  local user password
  for user in $CHAT_USERS; do
    if aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username "$user" >/dev/null 2>&1; then
      info "User $user already exists"
      continue
    fi
    password=$(python3 -c 'import secrets, string; print("Spend-" + "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8)) + "7a!")')
    aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$user" \
      --temporary-password "$password" --message-action SUPPRESS >/dev/null
    NEW_USERS+="    $user   $password"$'\n'
    info "Created user $user"
  done

  lambda_role spend-agent-chat "spend-agent-chat-role-$REGION" spend-agent-chat chat/lambda_policy.json
  deploy_lambda spend-agent-chat "$REPO/chat/index.mjs" nodejs24.x index.handler 300 \
    "{\"Variables\":{\"HARNESS_ARN\":\"$HARNESS_ARN\",\"USER_POOL_ID\":\"$POOL_ID\",\"CLIENT_ID\":\"$CLIENT_ID\"}}"
  if CHAT_URL=$(aws lambda get-function-url-config --function-name spend-agent-chat --query FunctionUrl --output text 2>/dev/null); then
    aws lambda update-function-url-config --function-name spend-agent-chat --auth-type NONE \
      --invoke-mode RESPONSE_STREAM >/dev/null
  else
    CHAT_URL=$(aws lambda create-function-url-config --function-name spend-agent-chat --auth-type NONE \
      --invoke-mode RESPONSE_STREAM --query FunctionUrl --output text)
  fi
  add_permission --function-name spend-agent-chat --statement-id FunctionURLAllowPublicAccess \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE
  add_permission --function-name spend-agent-chat --statement-id FunctionURLInvokeAllowPublicAccess \
    --action lambda:InvokeFunction --principal '*' --invoked-via-function-url
  info "Chat page: $CHAT_URL"
}

step8_test() {
  step "Step 8: asking the agent \"$TEST_QUESTION\""
  if ! python3 -c 'import boto3, sys; sys.exit(not hasattr(boto3.client("bedrock-agentcore", region_name="us-east-1"), "invoke_harness"))' 2>/dev/null; then
    info "Updating boto3 to call the harness..."
    python3 -m pip install --user --quiet --upgrade boto3 || { info "Couldn't update boto3; skipping the test."; return 0; }
  fi
  python3 - "$HARNESS_ARN" "$REGION" "$TEST_QUESTION" <<'EOF' || info "The test question failed; try it in the harness playground."
import sys, uuid
import boto3
from botocore.config import Config
arn, region, question = sys.argv[1:]
client = boto3.client("bedrock-agentcore", region_name=region,
                      config=Config(read_timeout=300, retries={"total_max_attempts": 1}))
response = client.invoke_harness(harnessArn=arn, runtimeSessionId=f"setup-check-{uuid.uuid4()}", actorId="setup-check",
                                 messages=[{"role": "user", "content": [{"text": question}]}])
answer, role = [], None
for event in response["stream"]:
    if "messageStart" in event:
        role = event["messageStart"]["role"]
        answer.append("")
    elif "contentBlockDelta" in event and role == "assistant":
        answer[-1] += event["contentBlockDelta"]["delta"].get("text", "")
    for error in ("validationException", "internalServerException", "runtimeClientError"):
        if error in event:
            sys.exit(f"  {error}: {event[error].get('message')}")
final = next((text.strip() for text in reversed(answer) if text.strip()), "(no answer)")
print("\n".join("  | " + line for line in final.splitlines()))
print("  Expected: marketing, about +49%.")
EOF
}

summary() {
  step "Done"
  info "Bucket:   s3://$BUCKET"
  info "Gateway:  $GATEWAY_ID"
  info "Harness:  $HARNESS_ARN (model $MODEL_ID)"
  info "Try it:   AgentCore console > Harness > spend_agent > Test Harness (guide Step 8)"
  if [ "${SKIP_CHAT:-}" != 1 ]; then
    info "Chat:     $CHAT_URL"
    if [ -n "$NEW_USERS" ]; then
      info "New users and their temporary passwords (each sets a new one at the first sign-in):"
      printf '%s' "$NEW_USERS"
    fi
  fi
}

main() {
  REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
  export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION
  MODEL_ID=${MODEL_ID:-us.openai.gpt-5.5}
  CHAT_USERS=${CHAT_USERS:-anna ben}
  POOL_NAME=${POOL_NAME:-spend-agent-chat}
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT

  check_setup
  step2_bucket
  step3_athena
  step4_tables
  step5_tools
  step6_gateway
  step7_harness
  [ "${SKIP_CHAT:-}" = 1 ] || step9_chat
  [ "${SKIP_TEST:-}" = 1 ] || step8_test
  summary
}

# Run only when executed, so the functions can be loaded with "source" for testing.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
