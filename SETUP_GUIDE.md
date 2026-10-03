# Spend Analysis Agent — Setup Guide

In this workshop you build an AI agent on **AWS Bedrock AgentCore** that answers questions about a company's spending, for example *"Which department's spend grew the most last quarter?"* or *"What's driving our AWS costs?"*

The company's spend data (department invoices, budgets and AWS costs) is stored in S3. The agent uses tools to query and analyze it, remembers each user, and can create a PDF report of its findings. Everything is set up in the AWS Console, with no coding required.

## Step 1 — Open your AWS account

1. Sign in to the [AWS Console](https://console.aws.amazon.com/) with the provided credentials.
2. Set the region (top right) to **Europe (Ireland) eu-west-1**.

## Step 2 — Create a bucket

1. Open **S3** → **Create bucket**.
2. Name it `spend-agent-<your-name>-<numbers>` (lowercase) and note the name.
3. Click **Create bucket**.
4. Open the bucket → **Upload** → **Add folder** → select `data/spend-data` → **Upload**.
5. **Create folder** → `athena-results`.

## Step 3 — Set up Athena

1. Open **Athena** → **Workgroups** (left menu) → **Create workgroup**.
2. Name it `spend-agent`.
3. Under **Query result configuration**, choose **Customer managed** → **Browse S3** → click your bucket → select the `athena-results` folder → **Choose**.
   The location should now read `s3://BUCKET_NAME/athena-results/`.
4. Click **Create workgroup**.

## Step 4 — Create the database and tables

1. Open **AWS Glue** → **Databases** (left menu, under Data Catalog) → **Add database**.
2. Name it `spend` → **Create database**.
3. Open **Athena** → **Query editor** (left menu), select the workgroup **spend-agent** (top right) and the database **spend** (left panel).
4. Run the three queries below one at a time (paste → **Run**).
   Replace `BUCKET_NAME` with your bucket name from Step 2.

```sql
CREATE EXTERNAL TABLE spend.department_spend (
  invoice_id string, invoice_date date, department string, category string,
  vendor string, amount_usd double)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
LOCATION 's3://BUCKET_NAME/spend-data/department_spend/'
TBLPROPERTIES ('skip.header.line.count'='1');
```

```sql
CREATE EXTERNAL TABLE spend.budgets (
  department string, fiscal_quarter string, budget_usd double)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
LOCATION 's3://BUCKET_NAME/spend-data/budgets/'
TBLPROPERTIES ('skip.header.line.count'='1');
```

```sql
CREATE EXTERNAL TABLE spend.aws_cost_export (
  bill_billing_period_start_date date, line_item_usage_start_date date,
  line_item_usage_account_id string, line_item_usage_account_name string,
  line_item_product_code string, line_item_usage_type string,
  line_item_operation string, line_item_line_item_type string,
  line_item_usage_amount double, pricing_unit string,
  line_item_unblended_rate double, line_item_unblended_cost double,
  line_item_currency_code string, product_region_code string,
  resource_tags_user_department string, resource_tags_user_environment string)
ROW FORMAT DELIMITED FIELDS TERMINATED BY ','
LOCATION 's3://BUCKET_NAME/spend-data/aws_cost_export/'
TBLPROPERTIES ('skip.header.line.count'='1');
```

5. Check that it worked. This should return **16882**:

```sql
SELECT COUNT(*) FROM spend.aws_cost_export;
```

## Step 5 — Create the agent's tools

The agent's tools (query the data, describe the tables, create a PDF report) run in one Lambda function.

1. Open **Lambda** → **Create function** → **Author from scratch**.
2. Name it `spend-agent-tools`, choose runtime **Python 3.14** → **Create function**.
3. In the **Code** tab, replace everything in `lambda_function.py` with the contents of [`tools/lambda_function.py`](tools/lambda_function.py) → **Deploy**.
4. **Configuration** → **General configuration** → **Edit** → set **Timeout** to **1 min** → **Save**.
5. **Configuration** → **Environment variables** → **Edit** → **Add environment variable**: key `BUCKET`, value = your bucket name → **Save**.
6. Give the function access to the data:
   - **Configuration** → **Permissions** → click the role name (opens IAM) → **Add permissions** → **Create inline policy** → **JSON**.
   - Delete the example content and paste the contents of [`tools/lambda_policy.json`](tools/lambda_policy.json).
   - ⚠️ Replace `BUCKET_NAME` with the name of your bucket.
   - **Next** → name it `spend-agent-tools` → **Create policy**.
7. Test the function:
   - Go back to the Lambda browser tab and open the **Test** tab (next to **Code**).
   - Choose **Create new event** and name it `run-query`.
   - In **Event JSON**, delete the example content and paste:

     ```json
     {"tool": "run_query", "sql": "SELECT department, SUM(amount_usd) AS total FROM department_spend GROUP BY department"}
     ```

   - Click **Save**, then **Test**.
   - A green box **Executing function: succeeded** appears. Click **Details** to see the result.

✅ The result lists 6 departments with their totals. If it shows `"error"`, check the timeout (4), the `BUCKET` variable (5) and the policy (6).

## Step 6 — Connect the tools with a Gateway

The Gateway makes the Lambda's tools available to the agent.

1. In Lambda, copy the **Function ARN** of `spend-agent-tools` (top right of the function page).
2. Open **Amazon Bedrock AgentCore** → **Gateways** (left menu) → **Create gateway**.
3. **Define gateway details:**
   - Name: `spend-agent-gateway`
   - **Permissions:** **Create default role**
   - Click **Next**.
4. **Configure Inbound Identity:**
   - Choose **AWS IAM**.
   - Click **Next**.
5. **Add targets:**
   - Target protocol: **MCP target**
   - Target name: `spend-tools`
   - Passthrough: leave **Do not use passthrough – default aggregated**
   - Target type: **Lambda ARN** → paste the Function ARN from step 1.
   - Tool schema: **inline** → paste the contents of [`tools/tool_schemas.json`](tools/tool_schemas.json).
   - Outbound Auth configurations: **IAM Role**
   - Click **Next**.
6. **Review and create** → **Create gateway**.
   The gateway is created, but the target fails with *"Gateway execution role lacks permission to invoke Lambda function"*. This is expected; the next two steps fix it.
7. Allow the gateway to call the Lambda:
   - Open the gateway → **Edit** → under **Permissions**, click **View role details in IAM** → **Add permissions** → **Create inline policy** → **JSON**.
   - Delete the example content and paste the contents of [`tools/gateway_policy.json`](tools/gateway_policy.json).
   - **Next** → name it `invoke-spend-tools` → **Create policy**.
8. Back in the gateway: **Targets** → **Add target** → fill it in exactly as in step 5 → **Add target**.

✅ The gateway shows one target, `spend-tools`.

## Step 7 — Create the agent

The agent is an AgentCore **harness**: you choose the model, instructions, tools and memory, and AgentCore runs it.

1. Open **Amazon Bedrock AgentCore** → **Harness** (left menu) → **Quick create harness**.
2. Name it `spend_agent` → **Create**.
3. Open the harness → **Edit**:
   - **Model:** **Claude Haiku 4.5**
   - **System prompt:** paste the contents of [`agent/system_prompt.md`](agent/system_prompt.md).
   - **Tools:** enable **Gateway** → select `spend-agent-gateway`.
   - **Memory:** leave it enabled.
   - **Save**.
4. Allow the agent to use the gateway:
   - In **Harness details**, click the **IAM role** (opens IAM) → **Add permissions** → **Create inline policy** → **JSON**.
   - Delete the example content and paste the contents of [`agent/harness_policy.json`](agent/harness_policy.json).
   - **Next** → name it `invoke-spend-gateway` → **Create policy**.

## Step 8 — Chat with the agent

1. Open the harness → **Test Harness** (opens the playground).
2. Under **Memory**, set **Actor ID** to your name (e.g. `anna`). Each user's conversations and memories are stored under their own Actor ID.
3. Ask these questions one at a time:

| Question | The agent should find |
|---|---|
| *Which department's spend grew the most last quarter?* | Marketing, about +49%, driven by advertising |
| *Is any department over budget in Q3 2026?* | Sales, about 24% over, driven by travel |
| *What's driving our AWS costs?* | Costs up about 59%: new untagged GPU instances (g5.12xlarge) in the data-platform account, plus a NAT Gateway spike in August |
| *Create a PDF report of these findings.* | A download link to the PDF |
