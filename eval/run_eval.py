"""Ask the spend agent the test questions from the setup guide and check its answers.

The expected numbers come from data/answer_key.md. Run it on your computer or in AWS CloudShell,
with credentials for the workshop account:

    python3 eval/run_eval.py                  # the system prompt the harness has now
    python3 eval/run_eval.py --prompt repo    # agent/system_prompt.md from this repo
    python3 eval/run_eval.py --prompt both    # both, side by side
    python3 eval/run_eval.py --memory         # also check that numbers don't come from memory

--prompt repo tries a prompt without changing the harness: it is sent along with each request.
Tool descriptions still come from the gateway as it is deployed. Needs boto3 1.42 or newer.
"""

import argparse
import json
import re
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3
from botocore.config import Config

REPO = Path(__file__).resolve().parent.parent

# Each check is a list of groups. An answer passes when every group has a pattern that matches.
# Answers are lower-cased and thousands separators removed first, so 842,712 becomes 842712.
# The main questions run in order in one conversation: the last one asks for a report of the others.
MAIN = [
    ("Which department's spend grew the most last quarter?", [["marketing"], [r"\b(48\.9|49(\.\d)?)\s?%"]]),
    ("Is any department over budget in Q3 2026?", [["sales"], [r"\b2[34](\.\d)?\s?%", r"72278"]]),
    ("What's driving our AWS costs?", [[r"\b5[89](\.\d)?\s?%"], [r"g5\.12xlarge", r"gpu"], [r"\bnat\b"]]),
    ("Create a PDF report of these findings.", [[r"https://\S+\.pdf"]]),
]
# Each bonus question gets a conversation of its own.
BONUS = [
    ("Which vendors drove marketing's increase?", [["socialboost"], ["searchads pro"]]),
    ("How much did our Bedrock costs grow last quarter?", [[r"\b10[34](\.\d)?\s?%", r"doubl"]]),
    ("How much of our AWS spend was untagged last quarter?", [[r"31615", r"31\.6"], [r"\b2[12](\.\d)?\s?%"]]),
    ("Has any department ever gone over budget?", [["sales"], [r"q3 2026", r"2026-q3"]]),
    ("How does Q3 2026 compare with the same quarter last year?",
     [[r"\b30(\.\d)?\s?%"], ["marketing", "advertising"]]),  # +30%, with a breakdown by department or category
]
# With --memory: tell the agent this, wait until long-term memory has saved it, then ask MAIN[0] in a new
# conversation. The answer must still come from a query: the user leads sales, but marketing grew most.
MEMORY_FACT = "Please remember that I'm the head of the sales department."


def find_harness(region, name):
    control = boto3.client("bedrock-agentcore-control", region_name=region)
    for harness in control.list_harnesses()["harnesses"]:
        if harness["harnessName"] == name:
            return harness["arn"]
    sys.exit(f"No harness named {name} in {region}.")


def ask(client, harness_arn, session_id, actor_id, question, prompt):
    """Send one question and return the final answer, the number of tool calls and of failed queries."""
    request = {
        "harnessArn": harness_arn,
        "runtimeSessionId": session_id,
        "actorId": actor_id,
        "messages": [{"role": "user", "content": [{"text": question}]}],
    }
    if prompt:
        request["systemPrompt"] = [{"text": prompt}]
    texts, role, tool_calls, failed = [], None, 0, 0
    for event in client.invoke_harness(**request)["stream"]:
        if "messageStart" in event:
            role = event["messageStart"]["role"]
            if role == "assistant":
                texts.append("")
        elif "contentBlockStart" in event:
            tool_calls += "toolUse" in event["contentBlockStart"].get("start", {})
        elif "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if role == "assistant":
                texts[-1] += delta.get("text", "")
            failed += sum('"error"' in part.get("text", "") for part in delta.get("toolResult", []))
        for error in ("validationException", "internalServerException", "runtimeClientError"):
            if error in event:
                raise RuntimeError(f"{error}: {event[error].get('message')}")
    answer = next((text.strip() for text in reversed(texts) if text.strip()), "")
    return answer, tool_calls, failed


def check(answer, groups):
    """Return the groups that no pattern matched."""
    text = re.sub(r"(?<=\d),(?=\d{3})", "", answer.lower())
    return [group for group in groups if not any(re.search(pattern, text) for pattern in group)]


def run_conversation(client, harness_arn, actor_id, questions, prompt):
    session_id = f"eval-{uuid.uuid4()}"
    results = []
    for question, groups in questions:
        start = time.time()
        try:
            answer, tool_calls, failed = ask(client, harness_arn, session_id, actor_id, question, prompt)
        except Exception as e:
            answer, tool_calls, failed = f"ERROR: {e}", 0, 0
        results.append({"question": question, "answer": answer, "missing": check(answer, groups),
                        "tool_calls": tool_calls, "failed_queries": failed, "seconds": round(time.time() - start)})
    return results


def run_memory_check(client, harness_arn, actor_id, prompt, wait):
    run_conversation(client, harness_arn, actor_id, [(MEMORY_FACT, [])], prompt)
    time.sleep(wait)  # long-term memory is saved in the background
    question, groups = MAIN[0]
    [result] = run_conversation(client, harness_arn, actor_id, [(question, groups)], prompt)
    result["question"] = f"(after '{MEMORY_FACT}') {question}"
    if not result["tool_calls"]:
        result["missing"].append(["(answered from memory without querying the data)"])
    return [result]


def run(client, harness_arn, variant, prompt, workers, memory_wait):
    # A new actor ID per run, so memories from earlier runs can't help or hurt.
    actor_id = f"eval-{time.strftime('%Y%m%d-%H%M%S')}-{variant}"
    jobs = [lambda: run_conversation(client, harness_arn, actor_id, MAIN, prompt)]
    jobs += [lambda q=q: run_conversation(client, harness_arn, actor_id, [q], prompt) for q in BONUS]
    if memory_wait:
        jobs.append(lambda: run_memory_check(client, harness_arn, actor_id + "-memory", prompt, memory_wait))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return [result for results in pool.map(lambda job: job(), jobs) for result in results]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prompt", choices=["current", "repo", "both"], default="current")
    parser.add_argument("--region", default="eu-west-1")
    parser.add_argument("--harness", default="spend_agent", help="harness name (default: spend_agent)")
    parser.add_argument("--workers", type=int, default=7, help="conversations to run at the same time")
    parser.add_argument("--memory", type=int, nargs="?", const=90, default=0, metavar="SECONDS",
                        help="also check that numbers come from queries, not from memory; waits SECONDS "
                             "(default 90) for long-term memory to be saved")
    parser.add_argument("--out", help="save all questions and answers to this JSON file")
    args = parser.parse_args()

    harness_arn = find_harness(args.region, args.harness)
    # No retries: a retried call would run the agent a second time.
    client = boto3.client("bedrock-agentcore", region_name=args.region,
                          config=Config(read_timeout=300, retries={"total_max_attempts": 1},
                                        max_pool_connections=max(10, args.workers * 2)))
    if not hasattr(client, "invoke_harness"):
        sys.exit("This boto3 is too old to call a harness. Run: pip install --upgrade boto3")

    repo_prompt = (REPO / "agent" / "system_prompt.md").read_text()
    variants = {"current": None, "repo": repo_prompt}
    names = ["current", "repo"] if args.prompt == "both" else [args.prompt]
    count = len(MAIN) + len(BONUS) + bool(args.memory)
    print(f"Asking {count} questions with prompt: {', '.join(names)} ...", flush=True)
    run_variant = lambda name: run(client, harness_arn, name, variants[name], args.workers, args.memory)
    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        results = dict(zip(names, pool.map(run_variant, names)))

    for name in names:
        rows = results[name]
        passed = sum(not row["missing"] for row in rows)
        failed = sum(row["failed_queries"] for row in rows)
        print(f"\n=== prompt: {name}: {passed}/{len(rows)} answers correct, {failed} failed queries ===")
        for row in rows:
            status = "PASS" if not row["missing"] else "FAIL"
            print(f"{status}  {row['seconds']:>3}s  {row['tool_calls']:>2} tool calls  {row['failed_queries']} failed  "
                  f"{row['question']}")
            if row["missing"]:
                print(f"      expected one of: {' / '.join('|'.join(group) for group in row['missing'])}")
                print(f"      answer: {' '.join(row['answer'].split())[:400]}")

    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=2))
        print(f"\nAll answers saved to {args.out}")


if __name__ == "__main__":
    main()
