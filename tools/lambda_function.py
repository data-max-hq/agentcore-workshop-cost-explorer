"""Tools for the spend analysis agent, called through AgentCore Gateway.

Paste this file into the Lambda console editor. Needs one environment variable:
  BUCKET - the S3 bucket from Step 2 (PDF reports are saved to reports/ in it)
"""

import itertools
import os
import re
import time
from datetime import datetime, timezone

import boto3
from botocore.config import Config

BUCKET = os.environ["BUCKET"]
DATABASE = os.environ.get("DATABASE", "spend")
WORKGROUP = os.environ.get("WORKGROUP", "spend-agent")
REGION = os.environ.get("AWS_REGION", "us-east-1")
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
    """Run a read-only SQL query and return its rows or error, plus the SQL itself so the chat page
    can show exactly what ran."""
    sql = event["sql"].strip().rstrip(";")
    return {"sql": sql, **query_athena(sql)}


def query_athena(sql):
    """Run a read-only SQL query in Athena and return up to MAX_ROWS rows."""
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


# --- PDF report writer (standard library only) -------------------------------
#
# Understands a small markdown subset: '#' headings, '- ' and '1. ' list items,
# plain paragraphs, '---' rules, '|' tables (the first row is the header), and
# bar charts written as a fenced block with one 'label: value' line per bar:
#
#   ```chart
#   title: Q3 2026 spend by department (USD)
#   marketing: 842,712
#   sales: 378,078
#   ```

PAGE_W, PAGE_H, MARGIN = 595, 842, 50  # A4 in points
WIDTH = PAGE_W - 2 * MARGIN

# RGB colors, 0-1
INK = (0.04, 0.04, 0.04)
SECONDARY = (0.32, 0.32, 0.31)
MUTED = (0.54, 0.53, 0.51)
GRID = (0.88, 0.88, 0.85)
AXIS = (0.76, 0.76, 0.72)
HEADER_FILL = (0.94, 0.94, 0.93)
BAR = (0.16, 0.47, 0.84)

# Widths of characters 32-126 in 1/1000 of the font size, from the standard
# Helvetica font metrics. Used to wrap lines and align table columns.
HELVETICA = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]
HELVETICA_BOLD = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
]
OTHER_WIDTHS = {"•": 350, "—": 1000, "…": 1000}  # any other character counts as 556

# Characters the built-in PDF fonts can't show, and what to print instead.
# Anything else outside the Windows-1252 character set (e.g. emoji) is dropped.
SYMBOLS = {
    "→": "->", "←": "<-", "↑": "up", "↓": "down", "≈": "~", "≥": ">=", "≤": "<=", "≠": "!=",
    "−": "-", "✓": "yes", "✔": "yes", "✅": "yes", "✗": "no", "✘": "no", "❌": "no",
    "\u00a0": " ", "\u2009": " ", "\u202f": " ",  # non-breaking and thin spaces
}

NUMBER = re.compile(r"[-+(]?[$€£]?\s?\d[\d,.]*\s?(%|[kKMB]|USD|EUR)?\)?")


def clean(text):
    """Remove markdown emphasis and swap characters the PDF fonts can't show."""
    text = text.replace("**", "").replace("`", "")
    for symbol, plain in SYMBOLS.items():
        text = text.replace(symbol, plain)
    return text.encode("cp1252", "ignore").decode("cp1252").strip()


def text_width(text, font, size):
    """Width of text in points. F1 is Helvetica, F2 Helvetica-Bold, F3 Courier."""
    if font == "F3":
        return 0.6 * size * len(text)
    widths = HELVETICA_BOLD if font == "F2" else HELVETICA
    return size / 1000 * sum(widths[ord(c) - 32] if " " <= c <= "~" else OTHER_WIDTHS.get(c, 556) for c in text)


def wrap(text, font, size, width):
    """Split text into lines that fit in `width` points, breaking words longer than a line."""
    width += 0.01  # allow for floating point rounding
    lines, line = [], ""
    for word in text.split():
        if text_width(f"{line} {word}".strip(), font, size) <= width:
            line = f"{line} {word}".strip()
            continue
        if line:
            lines.append(line)
        while len(word) > 1 and text_width(word, font, size) > width:
            cut = next((i for i in range(len(word) - 1, 1, -1) if text_width(word[:i], font, size) <= width), 1)
            lines.append(word[:cut])
            word = word[cut:]
        line = word
    if line or not lines:
        lines.append(line)
    return lines


def truncate(text, font, size, width):
    """Shorten text with '...' so it fits in `width` points."""
    if text_width(text, font, size) <= width:
        return text
    while text and text_width(text + "...", font, size) > width:
        text = text[:-1]
    return text.rstrip() + "..."


def fit_columns(natural, width):
    """Column widths for a table at most `width` wide. Columns narrower than an equal
    share keep their natural width; the others split the remaining space and wrap."""
    wide, room = set(range(len(natural))), width
    while wide:
        share = room / len(wide)
        narrow = {c for c in wide if natural[c] <= share}
        if not narrow:
            break
        wide -= narrow
        room -= sum(natural[c] for c in narrow)
    return [room / len(wide) if c in wide else natural[c] for c in range(len(natural))]


def rgb(color):
    return " ".join(f"{c:.3f}" for c in color)


def pdf_escape(text):
    text = text.encode("cp1252", "ignore").decode("cp1252")
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def parse_markdown(content):
    """Yield (kind, *args) blocks; each kind is drawn by the Report method of the same name."""
    lines, table = iter(content.splitlines()), []
    for raw in lines:
        line = raw.strip()
        if table and not line.startswith("|"):
            yield "table", table
            table = []
        if line.startswith("```"):
            body = list(itertools.takewhile(lambda l: not l.strip().startswith("```"), lines))
            if line[3:].strip().lower() == "chart":
                yield ("chart", *parse_chart(body))
            else:
                for code in body:
                    yield "code", clean(code)
        elif line.startswith("|"):
            if not re.fullmatch(r"[|\-:\s]+", line):  # skip |---|---| separator rows
                table.append([clean(cell) for cell in line.strip("|").split("|")])
        elif not line:
            yield ("blank",)
        elif re.fullmatch(r"[-*_]{3,}", line):
            yield ("rule",)
        elif line.startswith("#"):
            yield "heading", len(line) - len(line.lstrip("#")), clean(line.lstrip("#"))
        elif item := re.match(r"([-*+]|\d+[.)])\s+(.*)", line):
            yield "item", ("•" if item[1] in "-*+" else item[1]), clean(item[2])
        else:
            yield "text", clean(line)
    if table:
        yield "table", table


def parse_chart(lines):
    """Read 'title: ...' and 'label: value' lines into a title and (label, number, value text) bars."""
    title, bars = "", []
    for line in map(clean, lines):
        if line.lower().startswith("title:"):
            title = line[6:].strip()
            continue
        label, _, value = line.rpartition(":")
        label, value = re.sub(r"^[-*•]\s+", "", label.strip()), value.strip()
        number = re.search(r"-?\d[\d,]*(\.\d+)?", value)
        if label and number:
            amount = float(number[0].replace(",", ""))
            if re.fullmatch(r"-?\d+(\.\d+)?", value) and abs(amount) >= 1000:
                value = f"{amount:,.0f}"  # add thousands separators to bare numbers
            bars.append((label, amount, value))
    return title, bars


class Report:
    """Lays out blocks top to bottom and starts a new page when one is full."""

    def __init__(self):
        self.pages = []
        self.new_page()

    def new_page(self):
        self.page = []
        self.pages.append(self.page)
        self.y = PAGE_H - MARGIN

    def need(self, height):
        """Start a new page unless `height` more points fit on this one."""
        if self.y - height < MARGIN:
            self.new_page()

    def draw_text(self, x, y, text, font="F1", size=10, color=INK):
        self.page.append(f"{rgb(color)} rg BT /{font} {size:g} Tf {x:.1f} {y:.1f} Td ({pdf_escape(text)}) Tj ET")

    def draw_rect(self, x, y, w, h, color):
        self.page.append(f"{rgb(color)} rg {x:.1f} {y:.1f} {w:.1f} {h:.1f} re f")

    def draw_line(self, x0, y0, x1, y1, color):
        self.page.append(f"{rgb(color)} RG 0.6 w {x0:.1f} {y0:.1f} m {x1:.1f} {y1:.1f} l S")

    def draw_bar(self, x0, x1, y, height, color):
        """A bar from the baseline x0 to x1, with rounded corners at the x1 end."""
        r = min(2.5, height / 2, abs(x1 - x0))
        d = 1 if x1 >= x0 else -1
        e, k = x1 - d * r, 0.552 * r  # where the rounding starts; bezier handle length
        self.page.append(
            f"{rgb(color)} rg {x0:.1f} {y:.1f} m {e:.1f} {y:.1f} l "
            f"{e + d * k:.1f} {y:.1f} {x1:.1f} {y + r - k:.1f} {x1:.1f} {y + r:.1f} c {x1:.1f} {y + height - r:.1f} l "
            f"{x1:.1f} {y + height - r + k:.1f} {e + d * k:.1f} {y + height:.1f} {e:.1f} {y + height:.1f} c "
            f"{x0:.1f} {y + height:.1f} l h f")

    def paragraph(self, text, font="F1", size=10, color=INK, indent=0, marker=""):
        leading = size * 1.45
        for i, line in enumerate(wrap(text, font, size, WIDTH - indent)):
            self.need(leading)
            self.y -= leading
            if i == 0 and marker:
                self.draw_text(MARGIN + indent - 5 - text_width(marker, font, size), self.y, marker, font, size, color)
            self.draw_text(MARGIN + indent, self.y, line, font, size, color)

    def title(self, text):
        self.paragraph(text, "F2", 20)
        self.y -= 2
        self.paragraph(f"Generated {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC", size=9, color=MUTED)
        self.y -= 10
        self.draw_line(MARGIN, self.y, MARGIN + WIDTH, self.y, AXIS)
        self.y -= 4

    # --- one method per markdown block kind ---

    def heading(self, level, text):
        size = {1: 15, 2: 13}.get(level, 11)
        self.y -= 10
        self.need(size * 1.45 + 45)  # keep the heading on the same page as the lines below it
        self.paragraph(text, "F2", size)
        self.y -= 2

    def text(self, text):
        self.paragraph(text)

    def item(self, marker, text):
        self.paragraph(text, indent=16, marker=marker)

    def code(self, text):
        self.paragraph(text, "F3", 8.5, SECONDARY, indent=8)

    def blank(self):
        self.y -= 6

    def rule(self):
        self.need(14)
        self.y -= 10
        self.draw_line(MARGIN, self.y, MARGIN + WIDTH, self.y, GRID)

    def table(self, rows):
        """A table with a shaded header row. Columns of numbers are right-aligned."""
        pad = 5
        cols = max(len(row) for row in rows)
        rows = [row + [""] * (cols - len(row)) for row in rows]
        fonts = ["F2"] + ["F1"] * (len(rows) - 1)
        for size in (9, 8, 7):  # step down the font size rather than cut words in two
            natural = [max(text_width(row[c], font, size) for row, font in zip(rows, fonts)) + 2 * pad
                       for c in range(cols)]
            widths = fit_columns(natural, WIDTH)
            longest_word = [max(text_width(word, font, size) for row, font in zip(rows, fonts)
                                for word in row[c].split() or [""]) + 2 * pad for c in range(cols)]
            if all(word <= width for word, width in zip(longest_word, widths)):
                break
        leading = size * 1.28
        numeric = [any(NUMBER.fullmatch(row[c]) for row in rows[1:])
                   and all(NUMBER.fullmatch(row[c]) or row[c] in ("", "-", "—", "n/a") for row in rows[1:])
                   for c in range(cols)]
        cells = [[wrap(cell, font, size, w - 2 * pad) for cell, w in zip(row, widths)]
                 for row, font in zip(rows, fonts)]
        heights = [2 * pad + size + leading * (max(map(len, row)) - 1) for row in cells]

        def draw_row(i):
            top = self.y
            self.y -= heights[i]
            if i == 0:
                self.draw_rect(MARGIN, self.y, sum(widths), heights[i], HEADER_FILL)
            x = MARGIN
            for c, lines in enumerate(cells[i]):
                for n, line in enumerate(lines):
                    left = x + widths[c] - pad - text_width(line, fonts[i], size) if numeric[c] else x + pad
                    self.draw_text(left, top - pad - 0.8 * size - n * leading, line, fonts[i], size)
                x += widths[c]
            self.draw_line(MARGIN, self.y, MARGIN + sum(widths), self.y, AXIS if i == 0 else GRID)

        self.y -= 8
        self.need(heights[0] + (heights[1] if len(rows) > 1 else 0))
        draw_row(0)
        for i in range(1, len(rows)):
            if self.y - heights[i] < MARGIN:
                self.new_page()
                draw_row(0)  # repeat the header on the new page
            draw_row(i)
        self.y -= 6

    def chart(self, title, bars):
        """A horizontal bar chart with each value written at the end of its bar."""
        if not bars:
            return
        size, pitch, thickness = 9, 18, 11
        bars = bars[:25]
        self.y -= 10
        self.need(30 + pitch * len(bars))
        if title:
            self.paragraph(title, "F2", 10.5)
            self.y -= 4
        label_w = min(max(text_width(label, "F1", size) for label, _, _ in bars), 0.3 * WIDTH)
        value_w = max(text_width(value, "F1", size) for _, _, value in bars) + 6
        low = min(0, min(amount for _, amount, _ in bars))
        high = max(0, max(amount for _, amount, _ in bars))
        x0 = MARGIN + label_w + 10 + (value_w if low < 0 else 0)
        x1 = MARGIN + WIDTH - (value_w if high > 0 else 0)
        scale = (x1 - x0) / ((high - low) or 1)
        zero = x0 - low * scale
        top = self.y
        for label, amount, value in bars:
            bar_y = self.y - (pitch + thickness) / 2
            baseline = bar_y + thickness / 2 - 0.35 * size
            label = truncate(label, "F1", size, label_w)
            label_x = MARGIN + label_w - text_width(label, "F1", size)
            self.draw_text(label_x, baseline, label, size=size, color=SECONDARY)
            end = zero + amount * scale
            self.draw_bar(zero, end, bar_y, thickness, BAR)
            value_x = end + 4 if amount >= 0 else end - 4 - text_width(value, "F1", size)
            self.draw_text(value_x, baseline, value, size=size)
            self.y -= pitch
        self.draw_line(zero, top - 2, zero, self.y + 2, AXIS)
        self.y -= 4

    def add_footers(self, title):
        for number, page in enumerate(self.pages, start=1):
            self.page = page
            label = f"Page {number} of {len(self.pages)}"
            self.draw_text(MARGIN, MARGIN - 24, truncate(title, "F1", 8, WIDTH - 80), size=8, color=MUTED)
            self.draw_text(MARGIN + WIDTH - text_width(label, "F1", 8), MARGIN - 24, label, size=8, color=MUTED)


def build_pdf(title, content):
    title = clean(title) or "Spend report"
    report = Report()
    report.title(title)
    for kind, *args in parse_markdown(content):
        if not (kind == "heading" and args[1].lower() == title.lower()):  # skip a repeated title
            getattr(report, kind)(*args)
    report.add_footers(title)
    return write_pdf(report.pages, title)


def write_pdf(pages, title):
    """Serialize pages of drawing operations into PDF bytes."""
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
    objects.append(f"<< /Title <FEFF{title.encode('utf-16-be').hex()}> >>".encode())

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1, len(objects), xref)
    return bytes(out)
