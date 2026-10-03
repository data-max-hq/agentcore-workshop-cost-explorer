# Project Status — Spend Analysis Agent Workshop

A quick overview of what is done and what is left. The step-by-step setup instructions are in [`SETUP_GUIDE.md`](SETUP_GUIDE.md).

> ⚠️ **Region: everything is built for Europe (Ireland) `eu-west-1`.**
> The setup guide and all policies in this repo (`tools/lambda_policy.json`, `tools/gateway_policy.json`, `agent/harness_policy.json`) use `eu-west-1`. Make sure the AWS Console is set to this region whenever you work on the project.

## Goal

A demo agent on **AWS Bedrock AgentCore** that answers plain-language questions about a company's spend data stored in S3 (department invoices, budgets, AWS costs) and creates PDF reports. Non-technical attendees set it up in the AWS Console by following the guide, on empty AWS accounts.

## Architecture

```
User → Harness (agent, Claude Haiku 4.5, memory) → Gateway → Lambda tools → Athena → CSV data in S3
```

## Done ✅

- [x] **Synthetic dataset** (`data/spend-data/`): department invoices, budgets and a daily AWS cost export (CUR 2.0-like format), Oct 2024 – Sep 2026, with planted patterns. Known answers are in `data/answer_key.md`.
- [x] **S3 bucket** with the data and an `athena-results/` folder (guide Step 2).
- [x] **Athena workgroup** `spend-agent` (guide Step 3).
- [x] **Glue database** `spend` with 3 tables over the CSV files (guide Step 4).
- [x] **Lambda tools** `spend-agent-tools` (guide Step 5, code in `tools/lambda_function.py`), with three tools:
  - `describe_tables`: lists tables and columns
  - `run_query`: read-only SQL through Athena
  - `create_pdf_report`: PDF saved to S3 with a download link
- [x] **AgentCore Gateway** `spend-agent-gateway` with the Lambda as its target (guide Step 6).
- [x] **AgentCore Harness** `spend_agent` (guide Step 7, system prompt in `agent/system_prompt.md`). Tested in the playground: the agent calls the Gateway and the Lambda tools end to end.
- [x] **Setup guide**, Steps 1–8, written while building in the console.

## Left to do

### Improve the tools for better agent results
- [ ] **PDF generation**: the current `create_pdf_report` is a minimal, standard-library-only PDF writer (text, headings, bullets, simple monospace tables). Possible improvements: proper table layout, charts, styling and branding, page numbers. Charts and nicer layouts would need a PDF library (Lambda layer or zip) or AgentCore Code Interpreter.
- [ ] Tune `agent/system_prompt.md` and the tool descriptions in `tools/tool_schemas.json` based on the answers from the test questions.

### Separate memory and sessions per user
- [ ] Decide how users are kept apart. Right now the user identity is the **Actor ID** typed into the Harness Playground. Memory and conversations are stored per Actor ID, but the ID is not verified: anyone can type someone else's ID.
- [ ] **Suggested option: Amazon Cognito.** Users log in, and the user ID comes from the login token (JWT), so it can't be faked. Needs:
  - a Cognito user pool
  - JWT inbound auth on the harness
  - a small client (script or web page) to log in and chat, because the console Playground signs in with IAM, not with a user login

## Repository

| Path | What |
|---|---|
| `SETUP_GUIDE.md` | Step-by-step console setup for attendees |
| `data/spend-data/` | CSV data, one folder per table (uploaded to S3) |
| `data/answer_key.md` | Correct answers for the test questions |
| `tools/lambda_function.py` | Lambda code for the three tools |
| `tools/lambda_policy.json` | Permissions for the Lambda role |
| `tools/tool_schemas.json` | Tool definitions for the Gateway target |
| `tools/gateway_policy.json` | Lets the Gateway role invoke the Lambda |
| `agent/system_prompt.md` | Agent instructions for the harness |
| `agent/harness_policy.json` | Lets the harness role call the Gateway |
