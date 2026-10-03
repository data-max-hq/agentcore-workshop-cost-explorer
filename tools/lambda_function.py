"""Tools for the spend analysis agent, called through AgentCore Gateway.

Paste this file into the Lambda console editor. Needs one environment variable:
  BUCKET - the S3 bucket from Step 2 (PDF reports are saved to reports/ in it)
"""

import os
import re
import textwrap
import time
from datetime import datetime, timezone

import boto3
from botocore.config import Config

BUCKET = os.environ["BUCKET"]
DATABASE = os.environ.get("DATABASE", "spend")
WORKGROUP = os.environ.get("WORKGROUP", "spend-agent")
REGION = os.environ.get("AWS_REGION", "eu-west-1")
MAX_ROWS = 200

athena = boto3.client("athena")
glue = boto3.client("glue")
s3 = boto3.client("s3", region_name=REGION, endpoint_url=f"https://s3.{REGION}.amazonaws.com",
                  config=Config(signature_version="s3v4"))


# --- tools -------------------------------------------------------------------

def describe_tables(event):
    """List every table in the database with its columns."""
    tables = glue.get_tables(DatabaseName=DATABASE)["TableList"]
    return {
        t["Name"]: [f'{c["Name"]} ({c["Type"]})' for c in t["StorageDescriptor"]["Columns"]]
        for t in tables
    }


FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|drop|create|alter|truncate|grant|revoke|msck|unload|call)\b",
    re.IGNORECASE)


def run_query(event):
    """Run a read-only SQL query in Athena and return up to MAX_ROWS rows."""
    sql = event["sql"].strip().rstrip(";")
    if not re.match(r"^(select|with)\b", sql, re.IGNORECASE) or ";" in sql or FORBIDDEN.search(sql):
        return {"error": "Only a single read-only SELECT query is allowed."}

    query_id = athena.start_query_execution(
        QueryString=sql,
        QueryExecutionContext={"Database": DATABASE},
        WorkGroup=WORKGROUP,
    )["QueryExecutionId"]

    deadline = time.time() + 50
    while True:
        status = athena.get_query_execution(QueryExecutionId=query_id)["QueryExecution"]["Status"]
        if status["State"] == "SUCCEEDED":
            break
        if status["State"] in ("FAILED", "CANCELLED"):
            return {"error": status.get("StateChangeReason", status["State"])}
        if time.time() > deadline:
            athena.stop_query_execution(QueryExecutionId=query_id)
            return {"error": "The query took too long and was stopped."}
        time.sleep(1)

    result = athena.get_query_results(QueryExecutionId=query_id, MaxResults=MAX_ROWS + 1)
    rows = [[col.get("VarCharValue") for col in row["Data"]] for row in result["ResultSet"]["Rows"]]
    return {"columns": rows[0], "rows": rows[1:], "truncated": "NextToken" in result}


def create_pdf_report(event):
    """Turn a title and markdown-style text into a PDF in S3 and return a download link."""
    title = event.get("title", "Spend report")
    pdf = build_pdf(title, event["content"])

    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "report"
    key = f"reports/{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{slug}.pdf"
    s3.put_object(Bucket=BUCKET, Key=key, Body=pdf, ContentType="application/pdf")
    url = s3.generate_presigned_url("get_object", Params={"Bucket": BUCKET, "Key": key}, ExpiresIn=3600)
    return {"download_url": url, "s3_location": f"s3://{BUCKET}/{key}", "link_valid_minutes": 60}


TOOLS = {
    "describe_tables": describe_tables,
    "run_query": run_query,
    "create_pdf_report": create_pdf_report,
}


def lambda_handler(event, context):
    # Gateway sends the tool name as "<target>___<tool>"; a console test can pass {"tool": ...}.
    custom = getattr(getattr(context, "client_context", None), "custom", None) or {}
    tool = custom.get("bedrockAgentCoreToolName", event.get("tool", "")).split("___")[-1]
    if tool not in TOOLS:
        return {"error": f"Unknown tool: {tool}"}
    try:
        return TOOLS[tool](event)
    except Exception as e:
        return {"error": str(e)}


# --- minimal PDF writer (standard library only) ------------------------------

PAGE_W, PAGE_H, MARGIN = 595, 842, 50  # A4 in points

# style -> (font, size, line height, characters per line)
STYLES = {
    "title": ("F2", 18, 28, 50),
    "heading": ("F2", 13, 22, 70),
    "text": ("F1", 10, 14, 95),
    "table": ("F3", 8, 11, 115),
}


def parse_markdown(title, content):
    """Yield (style, text) lines from a small markdown subset: #, -, |, plain text."""
    yield "title", title
    yield "text", f"Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC"
    yield "blank", ""
    for raw in content.splitlines():
        line = raw.strip().replace("**", "").replace("`", "")
        if not line:
            yield "blank", ""
        elif line.startswith("#"):
            yield "heading", line.lstrip("# ")
        elif line.startswith("|"):
            if not re.fullmatch(r"[|\-: ]+", line):  # skip |---|---| separator rows
                yield "table", line
        elif line[:2] in ("- ", "* "):
            yield "text", "- " + line[2:]
        else:
            yield "text", line


def pdf_escape(text):
    text = text.encode("cp1252", "replace").decode("cp1252")
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(title, content):
    pages, ops, y = [], [], PAGE_H - MARGIN
    for style, text in parse_markdown(title, content):
        if style == "blank":
            y -= 8
            continue
        font, size, height, width = STYLES[style]
        for part in textwrap.wrap(text, width) or [""]:
            if y < MARGIN + height:
                pages.append(ops)
                ops, y = [], PAGE_H - MARGIN
            y -= height
            ops.append(f"BT /{font} {size} Tf {MARGIN} {y} Td ({pdf_escape(part)}) Tj ET")
    pages.append(ops)

    fonts = "/F1 3 0 R /F2 4 0 R /F3 5 0 R"
    kids = " ".join(f"{6 + 2 * i} 0 R" for i in range(len(pages)))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    ]
    for i, page_ops in enumerate(pages):
        stream = "\n".join(page_ops).encode("cp1252")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
            f"/Resources << /Font << {fonts} >> >> /Contents {7 + 2 * i} 0 R >>".encode())
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)
