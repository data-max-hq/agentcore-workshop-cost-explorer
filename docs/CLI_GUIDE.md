# Spend Analysis Agent — CLI Guide

The same Steps 2–9 as [`SETUP_GUIDE.md`](SETUP_GUIDE.md), as commands to paste into **AWS CloudShell**, one step at a time.
Paste each block as a whole and wait for the ✅ before the next step.

**Already did some steps in the console?** Do Step 0 with your bucket name filled in, then continue at the first step you haven't done.

## Step 0 — Get the files into CloudShell

1. On your computer, in the repo folder: `zip -r spend-agent.zip . -x '.git/*' '*.DS_Store'`
2. Sign in to the AWS Console, set the region to **US East (N. Virginia) us-east-1** and open **CloudShell** (top bar).
3. **Actions** → **Upload file** → choose `spend-agent.zip`.
4. If you already created a bucket in the console, put its name between the quotes in the first line. Otherwise leave it empty and a name is chosen for you.
5. Paste:

```bash
MY_BUCKET=""
cd ~ && rm -rf spend-agent && unzip -q spend-agent.zip -d spend-agent && cd spend-agent
aws bedrock-agentcore-control create-harness --generate-cli-skeleton >/dev/null 2>&1 || {
  curl -s https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscli.zip &&
  unzip -qo /tmp/awscli.zip -d /tmp && sudo /tmp/aws/install --update; }

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
cat > ~/spend-agent.env <<EOF
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
export ACCOUNT_ID=$ACCOUNT_ID
export BUCKET=${MY_BUCKET:-spend-agent-$ACCOUNT_ID-us-east-1}
export MODEL_ID=us.openai.gpt-5.5
EOF
cat >> ~/spend-agent.env <<'EOF'
ctl() { aws bedrock-agentcore-control "$@"; }

# Repeats a status command until it prints READY.
wait_ready() {
  for _ in $(seq 120); do
    s=$("$@"); echo "  $s"
    [ "$s" = READY ] && return 0
    [[ $s == *FAIL* ]] && return 1
    sleep 5
  done
  return 1
}

# Trust policy that lets AgentCore resources matching ARN $1 use a role.
agentcore_trust() {
  echo "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"bedrock-agentcore.amazonaws.com\"},\"Action\":\"sts:AssumeRole\",\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"$ACCOUNT_ID\"},\"ArnLike\":{\"aws:SourceArn\":\"$1\"}}}]}"
}

# Runs one Athena query, waits for it and prints its result rows.
athena_sql() {
  local id s
  id=$(aws athena start-query-execution --work-group spend-agent --query-string "$1" --query QueryExecutionId --output text)
  while s=$(aws athena get-query-execution --query-execution-id "$id" --query QueryExecution.Status.State --output text)
        [ "$s" = QUEUED ] || [ "$s" = RUNNING ]; do sleep 2; done
  if [ "$s" = SUCCEEDED ]; then
    aws athena get-query-results --query-execution-id "$id" --query 'ResultSet.Rows[1:].Data[].VarCharValue' --output text
  else
    aws athena get-query-execution --query-execution-id "$id" --query QueryExecution.Status.StateChangeReason --output text
  fi
}
EOF
source ~/spend-agent.env && echo "Account $ACCOUNT_ID, bucket $BUCKET"
```

✅ It prints your account and bucket name. Every block below starts by loading these settings again, so it still works after CloudShell reconnects.

## Step 2 — Create a bucket

```bash
source ~/spend-agent.env && cd ~/spend-agent
aws s3api create-bucket --bucket "$BUCKET"
aws s3 sync data/spend-data "s3://$BUCKET/spend-data/" --exclude "*.DS_Store"
aws s3api put-object --bucket "$BUCKET" --key athena-results/
```

✅ It lists three uploaded CSV files.

## Step 3 — Set up Athena

```bash
source ~/spend-agent.env && cd ~/spend-agent
aws athena create-work-group --name spend-agent \
  --configuration "{\"ResultConfiguration\":{\"OutputLocation\":\"s3://$BUCKET/athena-results/\"}}"
```

✅ No output means it worked.

## Step 4 — Create the database and tables

```bash
source ~/spend-agent.env && cd ~/spend-agent
aws glue create-database --database-input Name=spend
athena_sql "CREATE EXTERNAL TABLE spend.department_spend (
  invoice_id string, invoice_date date, department string, category string,
  vendor string, amount_usd double)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
LOCATION 's3://$BUCKET/spend-data/department_spend/'
TBLPROPERTIES ('skip.header.line.count'='1')"
athena_sql "CREATE EXTERNAL TABLE spend.budgets (
  department string, fiscal_quarter string, budget_usd double)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
LOCATION 's3://$BUCKET/spend-data/budgets/'
TBLPROPERTIES ('skip.header.line.count'='1')"
athena_sql "CREATE EXTERNAL TABLE spend.aws_cost_export (
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
TBLPROPERTIES ('skip.header.line.count'='1')"
athena_sql "SELECT COUNT(*) FROM spend.aws_cost_export"
```

✅ The last line is **16882**.

## Step 5 — Create the agent's tools

```bash
source ~/spend-agent.env && cd ~/spend-agent
aws iam create-role --role-name spend-agent-tools-role --query Role.Arn --output text \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name spend-agent-tools-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name spend-agent-tools-role --policy-name spend-agent-tools \
  --policy-document "$(sed "s/BUCKET_NAME/$BUCKET/g" tools/lambda_policy.json)"
sleep 15  # a new role takes a few seconds to be usable
rm -f /tmp/tools.zip && python3 -m zipfile -c /tmp/tools.zip tools/lambda_function.py
aws lambda create-function --function-name spend-agent-tools --runtime python3.14 \
  --handler lambda_function.lambda_handler --timeout 60 --zip-file fileb:///tmp/tools.zip \
  --role "arn:aws:iam::$ACCOUNT_ID:role/spend-agent-tools-role" \
  --environment "Variables={BUCKET=$BUCKET}" --query FunctionArn --output text
aws lambda wait function-active-v2 --function-name spend-agent-tools
aws lambda invoke --function-name spend-agent-tools --cli-binary-format raw-in-base64-out \
  --payload '{"tool": "run_query", "sql": "SELECT department, SUM(amount_usd) AS total FROM department_spend GROUP BY department"}' \
  /tmp/tools-test.json >/dev/null && cat /tmp/tools-test.json; echo
```

✅ The result lists 6 departments with their totals. If `create-function` says the role can't be assumed, or the test shows `"error"`, wait a few seconds and run the last command(s) again.

## Step 6 — Connect the tools with a Gateway

```bash
source ~/spend-agent.env && cd ~/spend-agent
aws iam create-role --role-name spend-agent-gateway-role --query Role.Arn --output text \
  --assume-role-policy-document "$(agentcore_trust "arn:aws:bedrock-agentcore:us-east-1:$ACCOUNT_ID:gateway/spend-agent-gateway-*")"
aws iam put-role-policy --role-name spend-agent-gateway-role --policy-name invoke-spend-tools \
  --policy-document file://tools/gateway_policy.json
aws iam put-role-policy --role-name spend-agent-gateway-role --policy-name get-spend-gateway \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"bedrock-agentcore:GetGateway\",\"Resource\":\"arn:aws:bedrock-agentcore:us-east-1:$ACCOUNT_ID:gateway/spend-agent-gateway-*\"}]}"
sleep 15
GATEWAY_ID=$(ctl create-gateway --name spend-agent-gateway --protocol-type MCP --authorizer-type AWS_IAM \
  --role-arn "arn:aws:iam::$ACCOUNT_ID:role/spend-agent-gateway-role" --query gatewayId --output text)
wait_ready ctl get-gateway --gateway-identifier "$GATEWAY_ID" --query status --output text

TOOLS_ARN=$(aws lambda get-function --function-name spend-agent-tools --query Configuration.FunctionArn --output text)
jq -n --arg arn "$TOOLS_ARN" --slurpfile schemas tools/tool_schemas.json \
  '{mcp: {lambda: {lambdaArn: $arn, toolSchema: {inlinePayload: $schemas[0]}}}}' > /tmp/target.json
TARGET_ID=$(ctl create-gateway-target --gateway-identifier "$GATEWAY_ID" --name spend-tools \
  --target-configuration file:///tmp/target.json \
  --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' \
  --query targetId --output text)
wait_ready ctl get-gateway-target --gateway-identifier "$GATEWAY_ID" --target-id "$TARGET_ID" --query status --output text
```

✅ Both waits end with **READY**. If the target fails, run `ctl update-gateway-target --gateway-identifier "$GATEWAY_ID" --target-id "$TARGET_ID" --name spend-tools --target-configuration file:///tmp/target.json --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]'`, then the last `wait_ready` line again.

## Step 7 — Create the agent

```bash
source ~/spend-agent.env && cd ~/spend-agent
aws iam create-role --role-name spend-agent-harness-role --query Role.Arn --output text \
  --assume-role-policy-document "$(agentcore_trust "arn:aws:bedrock-agentcore:us-east-1:$ACCOUNT_ID:*")"
aws iam put-role-policy --role-name spend-agent-harness-role --policy-name invoke-spend-gateway \
  --policy-document file://agent/harness_policy.json
aws iam put-role-policy --role-name spend-agent-harness-role --policy-name harness-execution --policy-document "$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
     "Resource": ["arn:aws:bedrock:*::foundation-model/*", "arn:aws:bedrock:us-east-1:$ACCOUNT_ID:*"]},
    {"Effect": "Allow", "Action": "bedrock-mantle:CreateInference", "Resource": "arn:aws:bedrock-mantle:us-east-1:$ACCOUNT_ID:*"},
    {"Effect": "Allow", "Action": "bedrock-mantle:CallWithBearerToken", "Resource": "*"},
    {"Effect": "Allow", "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"],
     "Resource": "arn:aws:ecr:us-east-1:*:repository/harness-*"},
    {"Effect": "Allow", "Action": ["ecr:GetAuthorizationToken", "ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"],
     "Resource": "*"},
    {"Effect": "Allow", "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
     "Resource": "*"},
    {"Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
     "Resource": "arn:aws:logs:us-east-1:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*"},
    {"Effect": "Allow", "Action": "logs:DescribeLogGroups", "Resource": "arn:aws:logs:us-east-1:$ACCOUNT_ID:log-group:*"},
    {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
     "Resource": "arn:aws:logs:us-east-1:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*"},
    {"Effect": "Allow", "Action": "logs:PutResourcePolicy",
     "Resource": "arn:aws:logs:us-east-1:$ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/harness_spend_agent-*"},
    {"Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
     "Condition": {"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}}},
    {"Effect": "Allow", "Action": ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
     "Resource": ["arn:aws:bedrock-agentcore:us-east-1:$ACCOUNT_ID:workload-identity-directory/default",
                  "arn:aws:bedrock-agentcore:us-east-1:$ACCOUNT_ID:workload-identity-directory/default/workload-identity/harness_spend_agent-*"]},
    {"Effect": "Allow", "Action": ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:DeleteEvent", "bedrock-agentcore:GetEvent",
                                   "bedrock-agentcore:ListEvents", "bedrock-agentcore:RetrieveMemoryRecords"],
     "Resource": "arn:aws:bedrock-agentcore:us-east-1:$ACCOUNT_ID:memory/spend_agent-*"}
  ]
}
EOF
)"
sleep 15
GATEWAY_ID=$(ctl list-gateways --query "items[?name=='spend-agent-gateway'].gatewayId | [0]" --output text)
GATEWAY_ARN=$(ctl get-gateway --gateway-identifier "$GATEWAY_ID" --query gatewayArn --output text)
jq -n --rawfile prompt agent/system_prompt.md '[{text: $prompt}]' > /tmp/prompt.json
HARNESS_ID=$(ctl create-harness --harness-name spend_agent \
  --execution-role-arn "arn:aws:iam::$ACCOUNT_ID:role/spend-agent-harness-role" \
  --model "{\"bedrockModelConfig\":{\"modelId\":\"$MODEL_ID\",\"apiFormat\":\"converse_stream\"}}" \
  --system-prompt file:///tmp/prompt.json \
  --tools "[{\"type\":\"agentcore_gateway\",\"name\":\"$GATEWAY_ID\",\"config\":{\"agentCoreGateway\":{\"gatewayArn\":\"$GATEWAY_ARN\",\"outboundAuth\":{\"awsIam\":{}}}}}]" \
  --memory '{"managedMemoryConfiguration":{"strategies":["SEMANTIC","SUMMARIZATION"],"eventExpiryDuration":30}}' \
  --query harness.harnessId --output text)
wait_ready ctl get-harness --harness-id "$HARNESS_ID" --query harness.status --output text
ctl get-harness --harness-id "$HARNESS_ID" --query harness.arn --output text
```

✅ The wait ends with **READY** and prints the harness ARN. If `create-harness` says the role can't be assumed, wait a few seconds and run it again from the `HARNESS_ID=` line.

## Step 8 — Chat with the agent

Open **Amazon Bedrock AgentCore** → **Harness** → `spend_agent` → **Test Harness** and ask the questions from [Step 8 of the setup guide](SETUP_GUIDE.md#step-8--chat-with-the-agent).

## Step 9 (optional) — Sign-in and chat page

Change `anna ben` in the first line to the people who should sign in.

```bash
source ~/spend-agent.env && cd ~/spend-agent
CHAT_USERS="anna ben"
HARNESS_ID=$(ctl list-harnesses --query "harnesses[?harnessName=='spend_agent'].harnessId | [0]" --output text)
HARNESS_ARN=$(ctl get-harness --harness-id "$HARNESS_ID" --query harness.arn --output text)
POOL_ID=$(aws cognito-idp create-user-pool --pool-name spend-agent-chat \
  --admin-create-user-config AllowAdminCreateUserOnly=true --query UserPool.Id --output text)
CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name spend-agent-chat \
  --no-generate-secret --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --prevent-user-existence-errors ENABLED --enable-token-revocation --query UserPoolClient.ClientId --output text)
for user in $CHAT_USERS; do
  password="Spend-$(openssl rand -hex 4)-7a"
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username "$user" \
    --temporary-password "$password" --message-action SUPPRESS >/dev/null
  echo "$user  $password" >> ~/spend-agent-users.txt
done

aws iam create-role --role-name spend-agent-chat-role --query Role.Arn --output text \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
aws iam attach-role-policy --role-name spend-agent-chat-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam put-role-policy --role-name spend-agent-chat-role --policy-name spend-agent-chat \
  --policy-document file://chat/lambda_policy.json
sleep 15
rm -f /tmp/chat.zip && python3 -m zipfile -c /tmp/chat.zip chat/index.mjs
aws lambda create-function --function-name spend-agent-chat --runtime nodejs24.x --handler index.handler \
  --timeout 300 --zip-file fileb:///tmp/chat.zip --role "arn:aws:iam::$ACCOUNT_ID:role/spend-agent-chat-role" \
  --environment "Variables={HARNESS_ARN=$HARNESS_ARN,USER_POOL_ID=$POOL_ID,CLIENT_ID=$CLIENT_ID}" \
  --query FunctionArn --output text
aws lambda wait function-active-v2 --function-name spend-agent-chat
aws lambda add-permission --function-name spend-agent-chat --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
aws lambda add-permission --function-name spend-agent-chat --statement-id FunctionURLInvokeAllowPublicAccess \
  --action lambda:InvokeFunction --principal '*' --invoked-via-function-url >/dev/null
CHAT_URL=$(aws lambda create-function-url-config --function-name spend-agent-chat --auth-type NONE \
  --invoke-mode RESPONSE_STREAM --query FunctionUrl --output text)
echo "Chat page: $CHAT_URL" && echo "Users and temporary passwords:" && cat ~/spend-agent-users.txt
```

✅ It prints the chat page address and each user's temporary password (also saved in `~/spend-agent-users.txt`). Try it as in [Step 9 → Try it](SETUP_GUIDE.md#try-it).
