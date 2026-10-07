# Answer quality test

`run_eval.py` asks the deployed agent the test questions from Step 8 of the [setup guide](../docs/SETUP_GUIDE.md) and checks its answers against the [answer key](../data/answer_key.md). Use it after changing the prompt, the tools or the data. It is a tool for maintainers, not a workshop step.

## What you need

- Python 3.9 or newer with boto3 1.42 or newer (`pip install --upgrade boto3`). AWS CloudShell works too.
- Credentials for the workshop account, for example `export AWS_PROFILE=<your profile>`. The region defaults to us-east-1.

## Run it

```
python3 eval/run_eval.py                  # the agent as it is deployed
python3 eval/run_eval.py --memory         # also check that numbers come from queries, not from memory
python3 eval/run_eval.py --prompt repo    # try agent/system_prompt.md without deploying it
python3 eval/run_eval.py --prompt both    # the deployed prompt and the repo prompt, side by side
```

`--prompt repo` sends the prompt from this repo along with each question, so nothing in AWS changes. Other options: `--out results.json` saves every question and answer, `--harness` and `--region` pick another harness, and `--workers` sets how many conversations run at the same time.

A run takes 1 to 2 minutes, or about 3 with `--memory`, which waits for the agent's memory to be saved.

## Reading the results

```
=== prompt: current: 10/10 answers correct, 1 failed queries ===
PASS   12s   2 tool calls  0 failed  Which department's spend grew the most last quarter?
FAIL    8s   1 tool calls  0 failed  What's driving our AWS costs?
      expected one of: \b5[89](\.\d)?\s?%
      answer: ...
```

- **PASS / FAIL**: whether the answer contains the expected numbers and names. For a FAIL, the line below shows what was missing and the start of the answer.
- **tool calls**: how many times the agent used a tool, such as a SQL query.
- **failed**: queries that returned an error before the agent fixed them. Fewer is better: each one costs time.

The agent doesn't answer the same way every time, so run the test two or three times before drawing conclusions.

## Good to know

- The expected answers are the `MAIN` and `BONUS` lists at the top of `run_eval.py`. If the data or the questions change, update them together with the answer key.
- Each run uses new memory IDs starting with `eval-`, so earlier runs don't affect it. These test conversations stay in the agent's memory for 30 days, and the report question saves a PDF in the bucket's `reports/` folder.
