# Project Status — Spend Analysis Agent Workshop

A quick overview of what is done and what is left. The step-by-step setup instructions are in [`SETUP_GUIDE.md`](SETUP_GUIDE.md).

> ⚠️ **Region: everything is built for Europe (Ireland) `eu-west-1`.**
> The setup guide and all policies in this repo (`tools/lambda_policy.json`, `tools/gateway_policy.json`, `agent/harness_policy.json`, `chat/lambda_policy.json`) use `eu-west-1`. Make sure the AWS Console is set to this region whenever you work on the project.

## Goal

A demo agent on **AWS Bedrock AgentCore** that answers plain-language questions about a company's spend data stored in S3 (department invoices, budgets, AWS costs) and creates PDF reports. Non-technical attendees set it up in the AWS Console by following the guide, on empty AWS accounts.

## Architecture

```
User → Harness (agent, Claude Haiku 4.5, memory) → Gateway → Lambda tools → Athena → CSV data in S3

Optional (guide Step 9):
User → chat page (Cognito sign-in) → Lambda spend-agent-chat → Harness (Actor ID = the signed-in user)
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
- [x] **Better PDF reports** (`create_pdf_report`): tables with a shaded header row, right-aligned numbers and the header repeated on each page; bar charts (written as ```` ```chart ```` blocks); page numbers; symbols the PDF fonts can't show (→, −, emoji) are converted or dropped. Still standard library only, so the code can still be pasted into the console.
- [x] **Prompt and tool descriptions tuned** against mistakes found by running queries in Athena: names are lowercase, untagged AWS costs are `''` (not NULL), dates need `DATE '...'` literals, how to join spend to budgets, round money in SQL.
- [x] **Five bonus test questions** in guide Step 8, with answers in `data/answer_key.md`.
- [x] **Separate memory per user with Cognito sign-in** (optional guide Step 9). A Lambda `spend-agent-chat` with a public function URL serves a chat page; people sign in with a Cognito user pool, and the Lambda checks the token and calls the harness with the user's Cognito ID as Actor ID. The harness keeps IAM auth, so the playground still works. Why not JWT auth on the harness itself: a harness accepts IAM or JWT, not both (the playground would stop working), and callers can send any `actorId` with each request, so JWT alone would not stop someone using another person's memory. Tested in the workshop account: sign-in with first-time password change, tampered tokens rejected, and one user's memory not visible to another.
- [x] **Chat page shows the agent's work live**, like Claude: while the agent works, each query appears as it runs with its row count or error, along with the agent's short notes, and the answer is written out as it comes. When done, the steps fold into one line ("Worked for 18s, 3 queries (1 failed)") that opens to show the SQL. This needs response streaming, which Lambda only supports on Node.js, so the chat Lambda is `chat/index.mjs` (Node.js 24.x) with function URL invoke mode RESPONSE_STREAM (guide Step 9).
- [x] **Chat history** (guide Step 9): a **History** button lists the signed-in user's past chats (newest 20, labeled by their first question); opening one redraws it with its steps, and the user can keep asking in it. Chats come from the AgentCore Memory the harness already keeps (30 days), so there is no extra database. The chat Lambda finds the memory through the harness and only reads chats stored under the signed-in user's ID; opening or continuing anyone else's chat returns "not found" (tested). Needs the updated `chat/lambda_policy.json` (read sessions and events, look up the harness).
- [x] **Answer quality test** (`eval/run_eval.py`, for maintainers, not a workshop step): asks the 9 test questions and checks the answers against `data/answer_key.md`, and counts failed queries. `--prompt repo` sends `agent/system_prompt.md` with each request, so a new prompt can be tried without changing the harness. `--memory` adds a check that the agent queries numbers instead of answering from memory. Run with credentials for the workshop account, on a computer or in AWS CloudShell: `python3 eval/run_eval.py --prompt both --memory`.
- [x] **Prompt fixes for answer quality** (in `agent/system_prompt.md`, not yet live): a "Questions about change" section with a 3-step recipe (totals for both periods, one comparison query with the AWS query to use, answer with the total change first and the breakdown included), a rule to always query numbers and never let memory change the answer, the list of available quarters, and correct units. Results with `--prompt repo --memory` (3 runs): 9/10, 10/10 and 10/10 correct with 1 to 2 failed queries per run, against 5/9 to 7/10 and 7 to 16 failed queries with the live prompt.
- [x] **Exact SQL in the chat** (not yet live): `run_query` now returns the SQL it ran, and the chat page shows that instead of the SQL rebuilt from the agent's event stream, which once missed a piece of text.

- [x] **Rolled out on 2026-10-04**: the tools Lambda (new PDF writer, SQL in `run_query` results), the gateway tool schema (chart format), the harness prompt (now harness version 4) and the chat Lambda. Live results with `python3 eval/run_eval.py --memory`: 10/10 and 10/10 correct with 0 and 1 failed queries (before: 5/9 to 7/10 with 7 to 16 failed queries). A report from the live agent has aligned tables and two bar charts. Rollback: tools Lambda version 1 holds the old code, harness version 2 the old prompt, and git commit 2a661b8 has the old files.

## Left to do

- [ ] Walk through guide Step 9 in the console once: the user pool, test users and chat Lambda were created with the AWS CLI, so the console click path (especially the Cognito screens) is not yet checked.

## Repository

The file map is in [`README.md`](../README.md).
