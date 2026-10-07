/**
 * Chat page with Amazon Cognito sign-in for the spend analysis agent. Shows the agent's work live.
 *
 * Paste this file into the Lambda console editor as index.mjs (runtime Node.js 24.x) and add a function
 * URL with auth type NONE and invoke mode RESPONSE_STREAM. Needs three environment variables:
 *   HARNESS_ARN  - ARN of the spend_agent harness (Step 7)
 *   USER_POOL_ID - ID of the Cognito user pool, e.g. us-east-1_AbCdEf123 (Step 9)
 *   CLIENT_ID    - ID of the user pool's app client (Step 9)
 *
 * GET  /      returns the chat page, where people sign in with their Cognito username and password.
 * POST /chat  sends one message and streams back what the agent does, one JSON object per line. The
 *             Lambda checks the Cognito token, then calls the harness with the user's Cognito ID as the
 *             memory actor ID, so each person only sees their own memory.
 */

import { createHash } from "node:crypto";
import {
  BedrockAgentCoreClient, InvokeHarnessCommand, ListEventsCommand, ListSessionsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { BedrockAgentCoreControlClient, GetHarnessCommand } from "@aws-sdk/client-bedrock-agentcore-control";
import { CognitoIdentityProviderClient, GetUserCommand } from "@aws-sdk/client-cognito-identity-provider";

const { HARNESS_ARN, USER_POOL_ID, CLIENT_ID } = process.env;
const REGION = process.env.AWS_REGION || "us-east-1";
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const MAX_MESSAGE = 4000;
const MAX_CHATS = 20;  // how many past chats the History list shows
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{32,99}$/;

const cognito = new CognitoIdentityProviderClient({});
// No retries: a retried call would run the agent a second time.
const agentcore = new BedrockAgentCoreClient({ maxAttempts: 1 });
const memoryReader = new BedrockAgentCoreClient({});
const control = new BedrockAgentCoreControlClient({});
let memoryId;  // the harness's AgentCore Memory, looked up once by chatMemory()

const CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; "
  + `connect-src 'self' https://cognito-idp.${REGION}.amazonaws.com; base-uri 'none'; form-action 'none'; `
  + "frame-ancestors 'none'";
const PAGE_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP,
                       "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const JSON_HEADERS = { "Content-Type": "application/json" };

export const handler = awslambda.streamifyResponse(async (event, stream, context) => {
  const { method, path } = event.requestContext.http;
  if (method === "GET" && path === "/") {
    const config = JSON.stringify({ region: REGION, clientId: CLIENT_ID });
    return send(stream, 200, PAGE_HEADERS, PAGE.replace("__CONFIG__", config));
  }
  if (method === "POST" && path === "/chat") return chat(event, stream, context);
  if (method === "GET" && path === "/chats") return listChats(event, stream);
  if (method === "GET" && path.startsWith("/chats/")) return openChat(event, stream, path.slice("/chats/".length));
  return send(stream, 404, JSON_HEADERS, JSON.stringify({ error: "Not found." }));
});

const reply = (stream, statusCode, data) => send(stream, statusCode, JSON_HEADERS, JSON.stringify(data));
const signInAgain = (stream) => reply(stream, 401, { error: "Please sign in again." });
const notFound = (stream) => reply(stream, 404, { error: "Chat not found." });

async function send(stream, statusCode, headers, body) {
  const out = awslambda.HttpResponseStream.from(stream, { statusCode, headers });
  out.write(body);  // write first: the status and headers go out with the first write, not with end()
  await new Promise((resolve) => out.end(resolve));
}

// Return the Cognito user ID (sub) of the person signed in, or null if the access token isn't valid.
async function userId(event) {
  const token = (event.headers?.authorization || "").replace(/^Bearer /, "").trim();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
  // These claims can be trusted because GetUser below makes Cognito confirm the token is genuine.
  if (claims.iss !== ISSUER || claims.client_id !== CLIENT_ID || claims.token_use !== "access") return null;
  try {
    const user = await cognito.send(new GetUserCommand({ AccessToken: token }));  // checks signature and expiry
    return user.UserAttributes.find((attribute) => attribute.Name === "sub").Value;
  } catch (error) {
    if (error.name === "NotAuthorizedException" || error.name === "UserNotFoundException") return null;
    throw error;
  }
}

async function chat(event, stream, context) {
  const user = await userId(event);
  if (!user) return signInAgain(stream);

  let request;
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString() : event.body;
    request = JSON.parse(body || "{}");
  } catch {
    return reply(stream, 400, { error: "Invalid request." });
  }
  const message = String(request.message ?? "").trim().slice(0, MAX_MESSAGE);
  if (!message) return reply(stream, 400, { error: "Type a message first." });

  let sessionId;
  if (request.sessionId) {
    // Continue a chat from History, but only one stored under this user.
    sessionId = String(request.sessionId);
    if (!(await ownsChat(user, sessionId))) return notFound(stream);
  } else {
    // A new chat: tie the session to the user, so nobody can continue someone else's conversation.
    sessionId = createHash("sha256").update(`${user}:${request.conversationId ?? ""}`).digest("hex");
  }
  // Stop the agent before the Lambda times out, so the user still gets an answer.
  const seconds = Math.max(10, Math.floor(context.getRemainingTimeInMillis() / 1000) - 15);

  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200, headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" } });
  const emit = (data) => out.write(JSON.stringify(data) + "\n");
  emit({ type: "session", id: sessionId });  // lets the page continue this chat and mark it in History
  try {
    await streamAgent(user, sessionId, message, seconds, emit);
  } catch (error) {
    console.log(`Harness call failed for user ${user}:`, error);
    emit({ type: "error", error: "The agent could not answer. Please try again." });
  }
  await new Promise((resolve) => out.end(resolve));
}

// Send one message to the harness and pass on what happens, as it happens:
//   text         a piece of the agent's reply (message counts the agent's messages)
//   tool         the agent starts a tool call
//   tool_input   the call's input is complete (the SQL, or the report title)
//   tool_result  the tool answered (number of rows, or the error)
//   message_end  one agent message is done; stop is "tool_use" if tool calls follow, "end_turn" at the end
//   done / error
async function streamAgent(user, sessionId, message, seconds, emit) {
  const response = await agentcore.send(new InvokeHarnessCommand({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    actorId: user,
    messages: [{ role: "user", content: [{ text: message }] }],
    timeoutSeconds: seconds,
  }));
  const calls = new Map();  // tool use ID -> { tool, input, result }
  let role = null, blocks = new Map(), current = null, count = 0;  // blocks: content block index -> tool use ID
  for await (const event of response.stream) {
    if (event.messageStart) {
      role = event.messageStart.role;
      blocks = new Map();
      current = null;
      if (role === "assistant") count += 1;
    } else if (event.contentBlockStart) {
      const { start = {}, contentBlockIndex: index } = event.contentBlockStart;
      const id = start.toolUse?.toolUseId ?? start.toolResult?.toolUseId;
      if (start.toolUse) {
        const tool = start.toolUse.name.split("___").pop();
        calls.set(id, { tool, input: "", result: "" });
        emit({ type: "tool", id, tool });
      }
      if (id) {
        blocks.set(index, id);
        current = id;
      }
    } else if (event.contentBlockDelta) {
      const { delta = {}, contentBlockIndex: index } = event.contentBlockDelta;
      if (role === "assistant" && delta.text) emit({ type: "text", message: count, delta: delta.text });
      // Use the block index when the event has one, otherwise the block that was opened last.
      const call = calls.get(blocks.get(index) ?? current);
      if (call && delta.toolUse) call.input += delta.toolUse.input ?? "";
      if (call && delta.toolResult) call.result += delta.toolResult.map((part) => part.text ?? "").join("");
    } else if (event.contentBlockStop) {
      const id = blocks.get(event.contentBlockStop.contentBlockIndex) ?? current;
      const call = calls.get(id);
      if (call && role === "assistant") emit({ type: "tool_input", id, ...describeInput(call) });
      if (call && role === "user") emit({ type: "tool_result", id, ...describeResult(call) });
    } else if (event.messageStop && role === "assistant") {
      emit({ type: "message_end", message: count, stop: event.messageStop.stopReason });
    }
    for (const error of ["validationException", "internalServerException", "runtimeClientError"]) {
      if (event[error]) throw new Error(`${error}: ${event[error].message}`);
    }
  }
  emit({ type: "done" });
}

function parse(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

function describeInput(call) {
  const args = parse(call.input);
  if (call.tool === "run_query") return { sql: String(args.sql ?? "").trim().slice(0, 4000) };
  if (call.tool === "create_pdf_report") return { title: String(args.title ?? "").slice(0, 200) };
  return {};
}

function describeResult(call) {
  const result = parse(call.result);
  // run_query sends back the SQL it ran: exact, while the input rebuilt from the stream can miss a piece.
  const sql = result.sql ? { sql: String(result.sql).trim().slice(0, 4000) } : {};
  if (result.error) return { ...sql, error: String(result.error).slice(0, 300) };
  if (Array.isArray(result.rows)) return { ...sql, rows: result.rows.length };
  return sql;
}

// --- History: past chats, read from the AgentCore Memory where the harness keeps them ---
//
// Memory stores chats per actor ID, and this Lambda always uses the signed-in user's ID, so people
// only ever see and continue their own chats.

async function chatMemory() {
  if (!memoryId) {
    const { harness } = await control.send(new GetHarnessCommand({ harnessId: HARNESS_ARN.split("/").pop() }));
    const memory = harness.memory?.managedMemoryConfiguration ?? harness.memory?.agentCoreMemoryConfiguration;
    memoryId = memory.arn.split("/").pop();
  }
  return memoryId;
}

async function ownsChat(user, sessionId) {
  if (!SESSION_ID.test(sessionId)) return false;
  const { events } = await memoryReader.send(new ListEventsCommand({
    memoryId: await chatMemory(), actorId: user, sessionId, maxResults: 1 }));
  return events.length > 0;
}

// The chat's messages, oldest first, in the form the harness stores them.
async function chatMessages(user, sessionId) {
  const events = [];
  let nextToken;
  do {
    const page = await memoryReader.send(new ListEventsCommand({
      memoryId: await chatMemory(), actorId: user, sessionId, includePayloads: true, maxResults: 100, nextToken }));
    events.push(...page.events);
    nextToken = page.nextToken;
  } while (nextToken);
  events.sort((a, b) => a.eventTimestamp - b.eventTimestamp);
  const messages = [];
  for (const event of events) {
    for (const payload of event.payload ?? []) {
      const message = parse(payload.conversational?.content?.text).message;  // other payloads are agent state
      if (message?.content) messages.push({ ...message, time: event.eventTimestamp });
    }
  }
  return messages;
}

const questionOf = (message) => message.content.filter((block) => block.text).map((block) => block.text).join("\n");

async function listChats(event, stream) {
  const user = await userId(event);
  if (!user) return signInAgain(stream);
  const sessions = [];
  let nextToken;
  do {
    const page = await memoryReader.send(new ListSessionsCommand({
      memoryId: await chatMemory(), actorId: user, maxResults: 100, nextToken }));
    sessions.push(...page.sessionSummaries);
    nextToken = page.nextToken;
  } while (nextToken);
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  const chats = await Promise.all(sessions.slice(0, MAX_CHATS).map(async (session) => {
    const first = (await chatMessages(user, session.sessionId)).find((m) => m.role === "user" && questionOf(m));
    return first && { id: session.sessionId, created: session.createdAt, title: questionOf(first).slice(0, 120) };
  }));
  return reply(stream, 200, { chats: chats.filter(Boolean) });
}

async function openChat(event, stream, sessionId) {
  const user = await userId(event);
  if (!user) return signInAgain(stream);
  if (!SESSION_ID.test(sessionId)) return notFound(stream);
  const messages = await chatMessages(user, sessionId);
  if (!messages.length) return notFound(stream);
  return reply(stream, 200, { id: sessionId, turns: toTurns(messages) });
}

// Turn stored messages into the events of the live stream, so the page draws old chats like new ones:
// one turn per question, with the agent's notes, tool calls, results and answer.
function toTurns(messages) {
  const turns = [], calls = new Map();
  let turn = null, count = 0;
  for (const message of messages) {
    if (message.role === "user" && questionOf(message)) {
      turn = { question: questionOf(message), events: [], start: message.time, end: message.time };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    turn.end = message.time;
    if (message.role === "assistant") count += 1;
    for (const block of message.content) {
      if (block.text && message.role === "assistant") {
        turn.events.push({ type: "text", message: count, delta: block.text });
      } else if (block.toolUse) {
        const id = block.toolUse.toolUseId;
        const call = { tool: block.toolUse.name.split("___").pop(), input: JSON.stringify(block.toolUse.input ?? {}) };
        calls.set(id, call);
        turn.events.push({ type: "tool", id, tool: call.tool }, { type: "tool_input", id, ...describeInput(call) });
      } else if (block.toolResult && calls.has(block.toolResult.toolUseId)) {
        const call = calls.get(block.toolResult.toolUseId);
        call.result = (block.toolResult.content ?? []).map((part) => part.text ?? "").join("");
        turn.events.push({ type: "tool_result", id: block.toolResult.toolUseId, ...describeResult(call) });
      }
    }
  }
  return turns.map(({ question, events, start, end }) => ({
    question, events, seconds: Math.max(1, Math.round((end - start) / 1000)) }));
}

// The page is a raw template literal, so its own script avoids backticks and dollar-brace.
const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spend Agent</title>
<style>
  :root {
    color-scheme: light;
    --bg: #f7f7f5; --surface: #ffffff; --ink: #1b1b1a; --muted: #6b6a66; --line: #e3e2dc;
    --accent: #2a78d6; --accent-ink: #ffffff; --user: #e8f1fc; --error: #c2352f; --ok: #2f7d32;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #141413; --surface: #1f1f1d; --ink: #f2f1ec; --muted: #a3a29b; --line: #34332f;
      --accent: #3987e5; --accent-ink: #ffffff; --user: #1d3350; --error: #f07a74; --ok: #6cc070;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
         font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between;
           gap: 12px; padding: 12px 16px; background: var(--surface); border-bottom: 1px solid var(--line); }
  .brand { font-weight: 650; }
  #account { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 14px; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 140px; }
  button { font: inherit; border: 0; border-radius: 8px; padding: 9px 16px; cursor: pointer;
           background: var(--accent); color: var(--accent-ink); }
  button:disabled { opacity: 0.55; cursor: default; }
  button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--line); padding: 5px 12px; }
  input, textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line);
                    border-radius: 8px; padding: 9px 12px; width: 100%; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
  .card { max-width: 380px; margin: 8vh auto 0; padding: 28px; background: var(--surface);
          border: 1px solid var(--line); border-radius: 12px; }
  .card h1 { margin: 0 0 4px; font-size: 22px; }
  .card label { display: block; margin-top: 14px; font-size: 14px; color: var(--muted); }
  .card label input { margin-top: 4px; }
  .card button[type=submit] { width: 100%; margin-top: 18px; }
  .muted { color: var(--muted); font-size: 14px; margin: 0; }
  .error { color: var(--error); font-size: 14px; min-height: 1em; margin: 12px 0 0; }
  [hidden] { display: none !important; }
  #messages { display: flex; flex-direction: column; gap: 14px; }
  .message { max-width: 100%; overflow-wrap: anywhere; }
  .message.user { align-self: flex-end; max-width: 85%; background: var(--user);
                  padding: 9px 14px; border-radius: 12px 12px 4px 12px; white-space: pre-wrap; }
  .message.agent { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
  .answer > :first-child { margin-top: 0; }
  .answer > :last-child { margin-bottom: 0; }
  .answer table { border-collapse: collapse; margin: 10px 0; font-size: 14px; display: block; overflow-x: auto; }
  .answer th, .answer td { border-bottom: 1px solid var(--line); padding: 5px 10px; text-align: left; }
  .answer th { font-weight: 600; }
  .answer a { color: var(--accent); }
  .answer pre { overflow-x: auto; }

  /* The agent's work: a live timeline that folds into one line when the answer is done. */
  .activity { font-size: 14px; color: var(--muted); }
  .activity + .answer:not(:empty) { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
  .activity > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
  .activity > summary::-webkit-details-marker { display: none; }
  .activity > summary::after, .tool.expandable > summary::after {
    content: "\203A"; font-size: 18px; line-height: 1; color: var(--muted); }
  .activity[open] > summary::after, .tool.expandable[open] > summary::after { transform: rotate(90deg); }
  .timeline { list-style: none; margin: 8px 0 0; padding: 0 0 0 8px; border-left: 2px solid var(--line); }
  .timeline > li { margin: 0 0 8px; padding-left: 12px; }
  .timeline .note > :first-child { margin-top: 0; }
  .timeline .note > :last-child { margin-bottom: 0; }
  .tool > summary { cursor: pointer; display: flex; align-items: center; gap: 8px; color: var(--ink); }
  .tool > summary::-webkit-details-marker { display: none; }
  .tool .detail { color: var(--muted); }
  .tool pre { margin: 6px 0 0; padding: 8px 10px; background: var(--bg); border-radius: 6px; color: var(--ink);
              font-size: 12.5px; white-space: pre-wrap; }
  .tool .failed-text { margin-top: 6px; color: var(--error); }
  .icon { flex: none; width: 14px; height: 14px; display: inline-grid; place-items: center;
          font-size: 12px; line-height: 1; }
  .icon.ok { color: var(--ok); }
  .icon.failed { color: var(--error); }
  .spinner { border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%;
             animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

  /* History: a panel with the user's past chats */
  #history { position: fixed; z-index: 2; top: 60px; right: 16px; width: min(380px, calc(100vw - 32px));
             max-height: min(70vh, 560px); overflow-y: auto; padding: 8px; background: var(--surface);
             border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.14); }
  #history h2 { margin: 6px 10px 6px; font-size: 13px; font-weight: 600; color: var(--muted); }
  #history-status { margin: 6px 10px; }
  #history-list { list-style: none; margin: 0; padding: 0; }
  #history-list button { display: block; width: 100%; padding: 8px 10px; border-radius: 8px; text-align: left;
                         background: transparent; color: var(--ink); }
  #history-list button:hover, #history-list button[aria-current="true"] { background: var(--bg); }
  #history-list .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #history-list .when { display: block; font-size: 12px; color: var(--muted); }
  .brand, button.ghost { white-space: nowrap; }
  @media (max-width: 480px) {
    #who { display: none; }
    #account { gap: 6px; }
    #account button.ghost { padding: 5px 8px; font-size: 14px; }
  }

  #examples { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  #examples p { width: 100%; margin: 0 0 4px; }
  #examples button { background: var(--surface); color: var(--ink); border: 1px solid var(--line);
                     border-radius: 999px; padding: 6px 14px; font-size: 14px; text-align: left; }
  #composer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px 16px;
              background: linear-gradient(transparent, var(--bg) 30%); }
  #composer div { max-width: 760px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; }
  #input { resize: none; max-height: 160px; background: var(--surface); }
</style>
</head>
<body>
<header>
  <div class="brand">Spend Agent</div>
  <div id="account" hidden>
    <span id="who"></span>
    <button id="history-button" class="ghost" type="button" aria-expanded="false"
            aria-controls="history">History</button>
    <button id="new-chat" class="ghost" type="button">New chat</button>
    <button id="sign-out" class="ghost" type="button">Sign out</button>
  </div>
</header>
<div id="history" hidden>
  <h2>Past chats</h2>
  <p id="history-status" class="muted"></p>
  <ul id="history-list"></ul>
</div>
<main>
  <form id="login" class="card" hidden>
    <h1>Sign in</h1>
    <p class="muted">Use the username and password you were given.</p>
    <label>Username <input id="username" autocomplete="username" required></label>
    <label id="password-field">Password
      <input id="password" type="password" autocomplete="current-password" required></label>
    <div id="new-password-fields" hidden>
      <p class="muted" style="margin-top:14px">Choose a new password: at least 8 characters, with upper and lower
        case letters, a number and a symbol.</p>
      <label>New password <input id="new-password" type="password" autocomplete="new-password"></label>
      <label>Repeat new password <input id="repeat-password" type="password" autocomplete="new-password"></label>
    </div>
    <p id="login-error" class="error" role="alert"></p>
    <button id="login-button" type="submit">Sign in</button>
  </form>

  <section id="chat" hidden>
    <div id="messages" aria-live="polite"></div>
    <div id="examples">
      <p class="muted">Ask a question about the company's spending, for example:</p>
      <button type="button">Which department's spend grew the most last quarter?</button>
      <button type="button">Is any department over budget in Q3 2026?</button>
      <button type="button">What's driving our AWS costs?</button>
      <button type="button">How much of our AWS spend was untagged last quarter?</button>
    </div>
  </section>
</main>
<form id="composer" hidden>
  <div>
    <textarea id="input" rows="1" placeholder="Ask about the company's spending" aria-label="Message"></textarea>
    <button id="send" type="submit">Send</button>
  </div>
</form>

<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/18.0.14/lib/marked.umd.min.js"
        integrity="sha512-trN9mtGYvoySPVI909KTnwbJI9AkKPydRCV/qAsUG1+q39hhpKltEag9b5JpdjeIZn5i8IH62hHRFdbKwMFh9w=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.4.16/purify.min.js"
        integrity="sha512-flQmhkXNRQ3iUfvtdCobtpMjCb6kE+zLnTiAulAQJ3WykVfy84JvCMOo6vhwWXHTXjR25h9Zj+LyGFRWKjRoag=="
        crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
const CONFIG = __CONFIG__;
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "spend-agent-auth";

let auth = loadAuth();      // {token, username} once signed in
let challenge = null;       // set while Cognito asks for a new password
let conversationId = crypto.randomUUID();  // names a new chat until the server gives it a session ID
let sessionId = null;      // the open chat's session ID, so it can be continued and marked in History
let busy = false;

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});
const markdown = (text) => DOMPurify.sanitize(marked.parse(text));

function loadAuth() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

function saveAuth(value) {
  auth = value;
  try {
    if (value) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function render() {
  $("login").hidden = !!auth;
  $("chat").hidden = $("composer").hidden = $("account").hidden = !auth;
  if (auth) {
    $("who").textContent = auth.username;
    $("input").focus();
  } else {
    $("username").focus();
  }
}

function setPasswordStep(newPassword) {
  $("password-field").hidden = newPassword;
  $("password").required = !newPassword;
  $("new-password-fields").hidden = !newPassword;
  $("new-password").required = $("repeat-password").required = newPassword;
  $("login-button").textContent = newPassword ? "Set password and sign in" : "Sign in";
}

async function cognito(action, body) {
  const response = await fetch("https://cognito-idp." + CONFIG.region + ".amazonaws.com/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": "AWSCognitoIdentityProviderService." + action,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.message || "Sign-in failed.");
    error.type = data.__type;
    throw error;
  }
  return data;
}

$("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  $("login-button").disabled = true;
  const username = $("username").value.trim();
  try {
    let data;
    if (challenge) {
      if ($("new-password").value !== $("repeat-password").value) throw new Error("The new passwords don't match.");
      data = await cognito("RespondToAuthChallenge", {
        ChallengeName: "NEW_PASSWORD_REQUIRED",
        ClientId: CONFIG.clientId,
        Session: challenge.session,
        ChallengeResponses: {USERNAME: challenge.username, NEW_PASSWORD: $("new-password").value},
      });
    } else {
      data = await cognito("InitiateAuth", {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: CONFIG.clientId,
        AuthParameters: {USERNAME: username, PASSWORD: $("password").value},
      });
    }
    if (data.ChallengeName === "NEW_PASSWORD_REQUIRED") {
      challenge = {session: data.Session, username};
      setPasswordStep(true);
      $("new-password").focus();
      return;
    }
    if (!data.AuthenticationResult) throw new Error("This sign-in step isn't supported: " + data.ChallengeName);
    saveAuth({token: data.AuthenticationResult.AccessToken, username: challenge ? challenge.username : username});
    challenge = null;
    setPasswordStep(false);
    $("login").reset();
    render();
  } catch (error) {
    $("login-error").textContent = error.message;
    if (challenge && error.type === "NotAuthorizedException") {  // the password change took too long: start over
      challenge = null;
      setPasswordStep(false);
    }
  } finally {
    $("login-button").disabled = false;
  }
});

function signOut(message) {
  saveAuth(null);
  newChat();
  render();
  $("login-error").textContent = message || "";
}

function newChat() {
  conversationId = crypto.randomUUID();
  sessionId = null;
  closeHistory();
  $("messages").replaceChildren();
  $("examples").hidden = false;
}

function addMessage(kind) {
  const element = document.createElement("div");
  element.className = "message " + kind;
  $("messages").append(element);
  return element;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const plural = (count, one, many) => count + " " + (count === 1 ? one : many);

// Put each SQL clause on its own line, unless the agent already did.
function formatSql(sql) {
  if (sql.includes("\n")) return sql;
  return sql.replace(/\s+(FROM|WHERE|GROUP BY|ORDER BY|HAVING|LIMIT|(?:LEFT |RIGHT |INNER |FULL )?JOIN|UNION ALL)\s+/gi,
                     "\n$1 ");
}

const RUNNING = {run_query: "Running a query", describe_tables: "Looking up the tables",
                 create_pdf_report: "Creating the PDF report"};
const DONE = {run_query: "Ran a query", describe_tables: "Looked up the tables and their columns",
              create_pdf_report: "Created the PDF report"};

// One agent reply: a timeline of the agent's work (notes and tool calls) above the answer, updated
// as events stream in. Everything the agent wrote goes through DOMPurify or textContent.
class Reply {
  constructor() {
    this.root = addMessage("agent");
    this.activity = element("details", "activity");
    this.activity.open = true;
    this.summary = element("summary");
    this.statusIcon = element("span", "icon spinner");
    this.status = element("span", "", "Thinking");
    this.summary.append(this.statusIcon, this.status);
    this.timeline = element("ol", "timeline");
    this.activity.append(this.summary, this.timeline);
    this.answer = element("div", "answer");
    this.root.append(this.activity, this.answer);
    this.text = "";          // the agent's current message, shown as the answer while it streams
    this.message = 0;
    this.tools = new Map();  // tool use ID -> {item, icon, label, detail, tool}
    this.queries = 0;
    this.failed = 0;
    this.started = Date.now();
    this.timer = setInterval(() => this.updateStatus(), 1000);
    this.updateStatus();
  }

  seconds() { return Math.round((Date.now() - this.started) / 1000); }

  updateStatus() {
    const running = [...this.tools.values()].filter((tool) => !tool.done).pop();
    this.status.textContent = (running ? RUNNING[running.tool] || "Using " + running.tool : "Thinking")
      + "... " + this.seconds() + "s";
  }

  handle(event) {
    if (event.type === "text") {
      if (event.message !== this.message) {
        this.message = event.message;
        this.text = "";
      }
      this.text += event.delta;
      this.scheduleAnswer();
    } else if (event.type === "tool") {
      this.moveTextToTimeline();
      this.addTool(event);
    } else if (event.type === "tool_input") {
      this.setInput(event);
    } else if (event.type === "tool_result") {
      this.setResult(event);
    } else if (event.type === "message_end" && /timeout|max_iterations/.test(event.stop)) {
      this.text += "\n\n*The agent ran out of time before it finished. Try a narrower question.*";
      this.scheduleAnswer();
    } else if (event.type === "error") {
      this.showError(event.error);
    }
    this.updateStatus();
  }

  // Text the agent wrote before calling a tool is a note about its work, not the answer.
  moveTextToTimeline() {
    if (this.text.trim()) {
      const note = element("li", "note");
      note.innerHTML = markdown(this.text);
      this.timeline.append(note);
    }
    this.text = "";
    this.answer.replaceChildren();
  }

  addTool(event) {
    const item = element("li");
    const box = element("details", "tool");
    const head = element("summary");
    const icon = element("span", "icon spinner");
    const label = element("span", "", RUNNING[event.tool] || "Using " + event.tool);
    const detail = element("span", "detail");
    head.append(icon, label, detail);
    box.append(head);
    item.append(box);
    this.timeline.append(item);
    this.tools.set(event.id, {item, box, icon, label, detail, tool: event.tool, done: false});
    if (event.tool === "run_query") this.queries += 1;
    keepScrolled();
  }

  setInput(event) {
    const tool = this.tools.get(event.id);
    if (!tool) return;
    if (event.sql) this.showSql(tool, event.sql);
    if (event.title) tool.detail.textContent = '"' + event.title + '"';
  }

  showSql(tool, sql) {
    if (!tool.sql) {
      tool.sql = element("pre");
      tool.box.append(tool.sql);
      tool.box.classList.add("expandable");
    }
    tool.sql.textContent = formatSql(sql);
  }

  setResult(event) {
    const tool = this.tools.get(event.id);
    if (!tool) return;
    tool.done = true;
    tool.label.textContent = DONE[tool.tool] || "Used " + tool.tool;
    if (event.sql) this.showSql(tool, event.sql);  // the SQL exactly as it ran
    if (event.error) {
      this.failed += 1;
      tool.icon.className = "icon failed";
      tool.icon.textContent = "✕";
      tool.detail.textContent = "failed";
      tool.box.append(element("div", "failed-text", event.error));
      tool.box.classList.add("expandable");
    } else {
      tool.icon.className = "icon ok";
      tool.icon.textContent = "✓";
      if (event.rows !== undefined) tool.detail.textContent = plural(event.rows, "row", "rows");
    }
  }

  scheduleAnswer() {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = null;
      this.answer.innerHTML = markdown(this.text);
      keepScrolled();
    });
  }

  showError(message) {
    this.answer.replaceChildren(element("p", "error", message));
  }

  // Fold the work into one line, like "Worked for 23s, 4 queries (1 failed)". Old chats pass their duration.
  finish(seconds) {
    clearInterval(this.timer);
    if (this.pending) {
      cancelAnimationFrame(this.pending);
      this.pending = null;
      this.answer.innerHTML = markdown(this.text);
    }
    if (!this.timeline.children.length) {
      this.activity.remove();
      return;
    }
    this.statusIcon.remove();
    let status = "Worked for " + (seconds ?? this.seconds()) + "s";
    if (this.queries) status += ", " + plural(this.queries, "query", "queries");
    if (this.failed) status += " (" + this.failed + " failed)";
    this.status.textContent = status;
    this.activity.open = false;
  }
}

// Keep the newest output in view, unless the reader has scrolled up.
function keepScrolled() {
  const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 160;
  if (nearBottom) window.scrollTo({top: document.body.scrollHeight});
}

async function send(text) {
  text = text.trim();
  if (!text || busy) return;
  busy = true;
  $("send").disabled = true;
  $("examples").hidden = true;
  $("input").value = "";
  resizeInput();
  addMessage("user").textContent = text;
  const reply = new Reply();
  keepScrolled();
  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: {"Content-Type": "application/json", "Authorization": "Bearer " + auth.token},
      body: JSON.stringify(sessionId ? {message: text, sessionId} : {message: text, conversationId}),
    });
    if (response.status === 401) {
      signOut("Your sign-in has expired. Please sign in again.");
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Something went wrong (error " + response.status + ").");
    }
    // The answer arrives as one JSON event per line, while the agent works.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "session") sessionId = event.id;
        else reply.handle(event);
      }
    }
    if (!reply.text.trim() && !reply.answer.querySelector(".error")) {
      reply.showError("The agent returned an empty answer.");
    }
  } catch (error) {
    reply.showError(error.message);
  } finally {
    reply.finish();
    busy = false;
    $("send").disabled = false;
    if (auth) $("input").focus();
  }
}

// GET one of the chat API paths as the signed-in user. Returns null when the sign-in has expired.
async function api(path) {
  const response = await fetch(path, {headers: {"Authorization": "Bearer " + auth.token}});
  if (response.status === 401) {
    signOut("Your sign-in has expired. Please sign in again.");
    return null;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong (error " + response.status + ").");
  return data;
}

function closeHistory() {
  $("history").hidden = true;
  $("history-button").setAttribute("aria-expanded", "false");
}

async function toggleHistory() {
  if (!$("history").hidden) return closeHistory();
  $("history").hidden = false;
  $("history-button").setAttribute("aria-expanded", "true");
  $("history-list").replaceChildren();
  $("history-status").textContent = "Loading...";
  try {
    const data = await api("/chats");
    if (!data) return;
    $("history-status").textContent = data.chats.length ? "" : "No past chats yet.";
    for (const chat of data.chats) {
      const button = element("button");
      button.type = "button";
      if (chat.id === sessionId) button.setAttribute("aria-current", "true");
      const when = new Date(chat.created).toLocaleString([], {month: "short", day: "numeric", hour: "2-digit",
                                                               minute: "2-digit"});
      button.append(element("span", "title", chat.title), element("span", "when", when));
      button.addEventListener("click", () => openChat(chat.id));
      const item = element("li");
      item.append(button);
      $("history-list").append(item);
    }
  } catch (error) {
    $("history-status").textContent = error.message;
  }
}

// Show a past chat the way it looked, with its steps, and continue it from there.
async function openChat(id) {
  if (busy) return;
  newChat();
  $("examples").hidden = true;
  const loading = addMessage("agent");
  loading.append(element("p", "muted", "Loading the chat..."));
  try {
    const data = await api("/chats/" + encodeURIComponent(id));
    if (!data) return;
    loading.remove();
    for (const turn of data.turns) {
      addMessage("user").textContent = turn.question;
      const reply = new Reply();
      for (const event of turn.events) reply.handle(event);
      reply.finish(turn.seconds);
    }
    sessionId = data.id;
    window.scrollTo({top: document.body.scrollHeight});
    $("input").focus();
  } catch (error) {
    loading.replaceChildren(element("p", "error", error.message));
  }
}

function resizeInput() {
  const input = $("input");
  input.style.height = "auto";
  input.style.height = input.scrollHeight + 2 + "px";
}

$("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  send($("input").value);
});
$("input").addEventListener("input", resizeInput);
$("input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
});
for (const example of $("examples").querySelectorAll("button")) {
  example.addEventListener("click", () => send(example.textContent));
}
$("new-chat").addEventListener("click", () => { newChat(); $("input").focus(); });
$("history-button").addEventListener("click", (event) => {
  event.stopPropagation();
  toggleHistory();
});
document.addEventListener("click", (event) => {
  if (!$("history").hidden && !$("history").contains(event.target)) closeHistory();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeHistory(); });
$("sign-out").addEventListener("click", () => signOut());

render();
</script>
</body>
</html>
`;
