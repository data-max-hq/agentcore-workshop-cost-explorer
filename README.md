# Spend Analysis Agent — AgentCore Workshop

In this workshop, people build an AI agent on **Amazon Bedrock AgentCore** that answers plain-language questions about a company's spending, such as *"Which department's spend grew the most last quarter?"* or *"What's driving our AWS costs?"*. The spend data (department invoices, budgets and an AWS cost export) is stored in S3. The agent queries it with tools, explains what it finds, and creates PDF reports with tables and charts.

Everything is set up by hand in the AWS Console, with no coding, on an empty AWS account in **US East (N. Virginia) us-east-1**. The code and policies in this repo are pasted into the console as they are; there is no build step.

## Architecture

```
User → Harness (GPT-5.5, memory) → Gateway → Lambda tools → Athena → CSV data in S3

Optional (Step 9):
User → chat page with Cognito sign-in → chat Lambda → Harness
```

## Where to start

| You are | Read |
|---|---|
| A workshop attendee | [`docs/SETUP_GUIDE.md`](docs/SETUP_GUIDE.md): Steps 1–8, and Step 9 for the optional chat page |
| An instructor or maintainer | [`data/answer_key.md`](data/answer_key.md) for the correct answers, and `eval/run_eval.py` to test the agent |

## Repository

| Path | What | Used in |
|---|---|---|
| `docs/SETUP_GUIDE.md` | Step-by-step console setup | Attendees |
| `data/spend-data/` | CSV data, one folder per table, uploaded to S3 as it is | Steps 2–4 |
| `data/answer_key.md` | Correct answers for the test questions | Step 8, instructors |
| `tools/lambda_function.py` | Lambda code for the agent's three tools: list the tables, run a SQL query, create a PDF report | Step 5 |
| `tools/lambda_policy.json` | Permissions for the tools Lambda | Step 5 |
| `tools/tool_schemas.json` | Tool definitions for the gateway target | Step 6 |
| `tools/gateway_policy.json` | Lets the gateway call the tools Lambda | Step 6 |
| `agent/system_prompt.md` | The agent's instructions | Step 7 |
| `agent/harness_policy.json` | Lets the harness call the gateway | Step 7 |
| `chat/index.mjs` | Chat page with sign-in, a live view of the agent's work, and chat history | Step 9 |
| `chat/lambda_policy.json` | Lets the chat Lambda call the agent and read past chats | Step 9 |
| `eval/` | Answer quality test against the answer key, with its own [README](eval/README.md) (not a workshop step) | Maintainers |
| `scripts/setup_cloudshell.sh` | Builds guide Steps 2–9 with the AWS CLI in one go (not a workshop step) | Instructors, maintainers |

## Building everything with a script

`scripts/setup_cloudshell.sh` does guide Steps 2–9 with the AWS CLI, for example to prepare an instructor's account or to check an attendee's setup. You can run it again: it reuses what exists, including resources made in the console, and brings the code, policies, prompt and model up to date with this repo. It never deletes anything.

1. On your computer, zip the repo: `zip -r spend-agent.zip . -x '.git/*' '*.dmg' '*.DS_Store'`
2. Open AWS CloudShell in the workshop region → **Actions** → **Upload file** → choose `spend-agent.zip`.
3. Run:

   ```
   unzip -q spend-agent.zip -d spend-agent && cd spend-agent
   bash scripts/setup_cloudshell.sh
   ```

The agent's model defaults to OpenAI GPT-5.5 (`us.openai.gpt-5.5`), because workshop accounts can't subscribe to Claude through AWS Marketplace. The settings are listed at the top of the script, for example `MODEL_ID`, `CHAT_USERS="anna ben carla"` or `SKIP_CHAT=1`.

## Testing answer quality

`eval/run_eval.py` asks the agent the test questions from the guide and checks its answers against the answer key. See [`eval/README.md`](eval/README.md) for the details. Run it on your computer or in AWS CloudShell, with credentials for the workshop account and boto3 1.42 or newer:

```
python3 eval/run_eval.py --memory          # the agent as it is deployed
python3 eval/run_eval.py --prompt both     # also try agent/system_prompt.md without deploying it
```
