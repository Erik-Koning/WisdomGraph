/**
 * page.ts — the single inline HTML page served at `/`.
 *
 * No bundler, no CDN, no framework: plain fetch + DOM in one template string.
 * Left column is the chat (streamed over /api/chat/stream, with 👍 👎 and a
 * comment box per assistant message, a "remember" box, reset/forget). Right
 * column is four tabs — Injected (the three compiled blocks for the last
 * turn), Graph (the explain tree with approve / reject / forget per hint and a
 * dry-run recall box), Events & audit, Maintenance. The Graph, Events and
 * Maintenance stats refresh after every chat, feedback, governance and
 * maintenance call.
 *
 * The template is `String.raw` so `\n` inside the page's JavaScript survives;
 * nothing inside it uses backticks or `${`.
 */
export const PAGE: string = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wisdom Graph tester</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1c2330; --muted: #66707f; --line: #dfe3e8;
    --accent: #2f6fed; --accent-ink: #ffffff; --ok: #1f8a4c; --warn: #b7791f; --bad: #c0392b;
    --chip: #eef1f5; --user: #e8f0ff; --assistant: #f3f4f6; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 14px; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0 8px 0 0; white-space: nowrap; }
  header h1 span { color: var(--muted); font-weight: normal; }
  header label { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  header input { width: 140px; }
  #badges { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  #status { padding: 4px 16px; font-family: var(--mono); font-size: 12px; color: var(--muted); min-height: 24px; white-space: pre-wrap; }
  #status.error { color: var(--bad); }
  main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; padding: 0 12px 12px; height: calc(100vh - 78px); min-width: 960px; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; display: flex; flex-direction: column; min-height: 0; }
  input, textarea, button, select { font: inherit; }
  input, textarea { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: #fff; color: var(--ink); }
  textarea { resize: vertical; width: 100%; }
  button { border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 5px 10px; cursor: pointer; }
  button:hover { border-color: #b9c2ce; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  button.danger { color: var(--bad); }
  button.small { padding: 2px 7px; font-size: 12px; }
  button:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row > input, .row > textarea { flex: 1; }
  .muted { color: var(--muted); }
  .mono { font-family: var(--mono); font-size: 12px; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; background: #f8f9fb; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
  pre.empty { color: var(--muted); font-style: italic; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 14px 0 6px; }
  h2:first-child { margin-top: 0; }

  /* chat */
  #messages { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 92%; border-radius: 10px; padding: 8px 10px; }
  .msg.user { align-self: flex-end; background: var(--user); }
  .msg.assistant { align-self: flex-start; background: var(--assistant); }
  .msg .body { white-space: pre-wrap; word-break: break-word; }
  .msg .meta { margin-top: 6px; font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .msg .actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .msg .actions input { flex: 1; min-width: 160px; font-size: 12px; padding: 3px 6px; }
  .msg .receipt { font-size: 11px; color: var(--ok); font-family: var(--mono); width: 100%; }
  .msg .receipt.error { color: var(--bad); }
  .chat-bottom { border-top: 1px solid var(--line); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .chat-bottom label { font-size: 12px; color: var(--muted); }

  /* tabs */
  nav.tabs { display: flex; border-bottom: 1px solid var(--line); }
  nav.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 9px 14px; color: var(--muted); }
  nav.tabs button.active { color: var(--ink); border-bottom-color: var(--accent); font-weight: 600; }
  .tab { display: none; overflow: auto; padding: 12px; flex: 1; }
  .tab.active { display: block; }

  /* graph */
  .chips { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .chip { background: var(--chip); border-radius: 999px; padding: 1px 8px; font-size: 11px; font-family: var(--mono); color: #3b4452; }
  .chip.lane-preRoute { background: #e9f5ee; } .chip.lane-agent { background: #fff3e0; } .chip.lane-responseStyle { background: #e8f0ff; }
  .chip.status-active { color: var(--ok); } .chip.status-pending { color: var(--warn); } .chip.status-retired, .chip.status-superseded { color: var(--bad); }
  .chip.approval-approved { background: #dff5e6; color: var(--ok); } .chip.approval-rejected { background: #fde8e6; color: var(--bad); }
  .chip.review { background: #fde8e6; color: var(--bad); }
  .node { border-left: 2px solid var(--line); padding-left: 10px; margin: 8px 0; }
  .node > .head { font-weight: 600; }
  .node > .head .muted { font-weight: normal; }
  .node .props { font-size: 11px; }
  ul.hints { list-style: none; margin: 4px 0; padding: 0; }
  li.hint { border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; margin: 6px 0; background: #fcfcfd; }
  li.hint .why { font-size: 11px; color: var(--muted); margin-top: 4px; }
  li.hint .hint-actions { display: flex; gap: 6px; margin-top: 6px; }
  li.hint.retired { opacity: .7; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  td.mono { font-family: var(--mono); }
  .outcome-kept { color: var(--ok); } .outcome-suppressed { color: var(--warn); } .outcome-dropped { color: var(--bad); }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Wisdom Graph <span>web tester</span></h1>
  <label>subject <input id="subject" placeholder="erik"></label>
  <label>client <input id="client" placeholder="none"></label>
  <button id="apply" class="primary">Switch</button>
  <div id="badges"></div>
</header>
<div id="status">loading config…</div>
<main>
  <section id="chat">
    <div id="messages"></div>
    <div class="chat-bottom">
      <div class="row">
        <textarea id="chat-input" rows="2" placeholder="Ask something… Enter sends, Shift+Enter for a newline"></textarea>
        <button id="send" class="primary">Send</button>
      </div>
      <label for="remember-input">Remember a preference directly (synthetic turn + comment feedback)</label>
      <div class="row">
        <input id="remember-input" placeholder="e.g. shorter answers, bullet points, no disclaimers, call me Erik">
        <button id="remember">Remember</button>
      </div>
      <div class="row">
        <button id="reset" class="small">Reset chat history</button>
        <button id="forget-subject" class="small danger">Forget subject (delete graph)</button>
        <span class="muted mono" id="history-note"></span>
      </div>
    </div>
  </section>
  <section id="side">
    <nav class="tabs">
      <button data-tab="injected" class="active">Injected</button>
      <button data-tab="graph">Graph</button>
      <button data-tab="events">Events &amp; audit</button>
      <button data-tab="maintenance">Maintenance</button>
    </nav>
    <div class="tab active" id="tab-injected">
      <h2>Recall</h2>
      <pre id="inj-recall" class="empty">no turn yet — send a message</pre>
      <h2>preRoute → systemPromptPrefix (START)</h2>
      <pre id="inj-preRoute" class="empty">(empty)</pre>
      <h2>agent → nodePreamble (MIDDLE)</h2>
      <pre id="inj-agent" class="empty">(empty)</pre>
      <h2>responseStyle → synthesizeSuffix (END)</h2>
      <pre id="inj-responseStyle" class="empty">(empty)</pre>
      <details><summary>full system prompt sent to the model</summary><pre id="inj-system" class="empty">(none)</pre></details>
      <details><summary>ingest receipt + provenance</summary><pre id="inj-receipt" class="empty">(none)</pre></details>
    </div>
    <div class="tab" id="tab-graph">
      <div class="row">
        <input id="dry-input" placeholder="dry-run recall query (optional) — shows which hints would be kept / suppressed / dropped">
        <button id="dry-run">Dry-run</button>
        <label class="muted"><input type="checkbox" id="include-retired"> retired</label>
        <button id="graph-refresh" class="small">Refresh</button>
      </div>
      <pre id="graph-stats" class="empty" style="margin-top:8px">loading…</pre>
      <div id="trace"></div>
      <div id="tree"></div>
      <div id="pending"></div>
      <div id="retired"></div>
    </div>
    <div class="tab" id="tab-events">
      <h2>Recent events</h2>
      <div id="events"></div>
      <h2>Audit</h2>
      <div id="audit"></div>
    </div>
    <div class="tab" id="tab-maintenance">
      <div class="row">
        <button data-maint="consolidate">Consolidate</button>
        <button data-maint="maintain">Maintain</button>
        <button data-maint="drain">Drain</button>
        <button id="stats-refresh" class="small">Refresh stats</button>
      </div>
      <h2>Report</h2>
      <pre id="maint-report" class="empty">(none yet)</pre>
      <h2>Engine stats</h2>
      <pre id="stats" class="empty">loading…</pre>
    </div>
  </section>
</main>
<script>
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var state = { subjectId: "", clientId: null, lastRun: null, busy: false };

  // ── helpers ──
  function esc(s) {
    return String(s === undefined || s === null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function setStatus(text, isError) {
    var el = $("status");
    el.textContent = text;
    el.className = isError ? "error" : "";
  }
  function showPre(id, text) {
    var el = $(id);
    if (text && String(text).trim() !== "") { el.textContent = text; el.className = ""; }
    else { el.textContent = "(empty)"; el.className = "empty"; }
  }
  function idQuery() {
    var p = new URLSearchParams();
    p.set("subjectId", state.subjectId);
    p.set("clientId", state.clientId === null ? "" : state.clientId);
    return p;
  }
  async function api(path, opts) {
    var res = await fetch(path, opts);
    var data;
    try { data = await res.json(); } catch (e) { data = { error: "non-JSON response (HTTP " + res.status + ")" }; }
    if (!res.ok) throw new Error(data && data.error ? data.error : "HTTP " + res.status);
    return data;
  }
  function get(path, params) {
    var p = idQuery();
    Object.keys(params || {}).forEach(function (k) { p.set(k, params[k]); });
    return api(path + "?" + p.toString());
  }
  function post(path, body) {
    var payload = Object.assign({ subjectId: state.subjectId, clientId: state.clientId }, body || {});
    return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  }
  function del(path) { return api(path + "?" + idQuery().toString(), { method: "DELETE" }); }
  function fmtTime(iso) { return iso ? String(iso).replace("T", " ").replace(/\.\d+Z$/, "Z") : ""; }
  function chip(text, cls) { return '<span class="chip ' + (cls || "") + '">' + esc(text) + '</span>'; }

  // ── tabs ──
  document.querySelectorAll("nav.tabs button").forEach(function (b) {
    b.addEventListener("click", function () {
      document.querySelectorAll("nav.tabs button").forEach(function (x) { x.classList.remove("active"); });
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      b.classList.add("active");
      $("tab-" + b.dataset.tab).classList.add("active");
    });
  });

  // ── config + identity ──
  async function loadConfig() {
    var cfg = await get("/api/config");
    state.subjectId = cfg.subjectId;
    state.clientId = cfg.clientId;
    $("subject").value = cfg.subjectId;
    $("client").value = cfg.clientId || "";
    $("badges").innerHTML =
      chip(cfg.offline ? "offline model" : cfg.model + " (" + cfg.effort + ")") +
      chip(cfg.store) +
      (cfg.sharedSubjectId ? chip("shared=" + cfg.sharedSubjectId) : "") +
      chip(cfg.categories.map(function (c) { return c.name; }).join(", "));
    setStatus("subject=" + cfg.subjectId + (cfg.clientId ? " client=" + cfg.clientId : "") + " · " + cfg.store + " · " + (cfg.offline ? "offline (echo assistant + heuristic extractor)" : cfg.model));
  }
  async function switchIdentity() {
    var subject = $("subject").value.trim();
    var client = $("client").value.trim();
    if (!subject) { setStatus("subject is required", true); return; }
    state.subjectId = subject;
    state.clientId = client === "" ? null : client;
    state.lastRun = null;
    setStatus("subject=" + subject + (client ? " client=" + client : ""));
    await loadHistory();
    await refreshAll();
  }
  $("apply").addEventListener("click", function () { switchIdentity().catch(fail); });
  function fail(e) { setStatus("error: " + (e && e.message ? e.message : e), true); }

  // ── chat ──
  function addMessage(role, text) {
    var el = document.createElement("div");
    el.className = "msg " + role;
    el.innerHTML = '<div class="body"></div>';
    el.querySelector(".body").textContent = text || "";
    $("messages").appendChild(el);
    $("messages").scrollTop = $("messages").scrollHeight;
    return el;
  }
  function finishAssistant(el, result) {
    el.querySelector(".body").textContent = result.reply;
    var r = result.recall;
    var agentCounts = Object.keys(r.laneCounts.agent).map(function (a) { return a + ":" + r.laneCounts.agent[a]; }).join(" ") || "—";
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = result.runId + " · topic=" + r.topic.category + " (" + r.topic.confidence.toFixed(2) + ", " + r.topic.method + ")" +
      " · preRoute " + r.laneCounts.preRoute + " · agent " + agentCounts + " · responseStyle " + r.laneCounts.responseStyle +
      " · " + r.tokenEstimate + " tok · " + r.meta.cache + " " + r.meta.elapsedMs + "ms · ingest " + result.receipt.status;
    el.appendChild(meta);
    var actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML =
      '<button class="small" data-signal="up" title="feedback: up">👍</button>' +
      '<button class="small" data-signal="down" title="feedback: down">👎</button>' +
      '<input placeholder="comment / correction, e.g. shorter please, no disclaimers">' +
      '<button class="small" data-signal="comment">Comment</button>' +
      '<button class="small" data-signal="correction">Correction</button>' +
      '<div class="receipt"></div>';
    el.appendChild(actions);
    actions.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        var signal = b.dataset.signal;
        var text = actions.querySelector("input").value.trim();
        if ((signal === "comment" || signal === "correction") && !text) { setStatus(signal + " needs text", true); return; }
        sendFeedback(result.runId, signal, text || undefined, actions.querySelector(".receipt"), b).catch(fail);
      });
    });
    $("messages").scrollTop = $("messages").scrollHeight;
  }
  async function sendFeedback(runId, signal, text, receiptEl, button) {
    button.disabled = true;
    try {
      var body = { runId: runId, signal: signal };
      if (text) body.text = text;
      var out = await post("/api/feedback", body);
      receiptEl.className = "receipt";
      receiptEl.textContent = signal + (text ? ' "' + text + '"' : "") + " → " + out.receipt.status + (out.receipt.reason ? " (" + out.receipt.reason + ")" : "") + " · " + out.eventId;
      setStatus("feedback " + signal + " on " + runId + ": " + out.receipt.status);
      await refreshAll();
    } catch (e) {
      receiptEl.className = "receipt error";
      receiptEl.textContent = "feedback failed: " + e.message;
      throw e;
    } finally {
      button.disabled = false;
    }
  }
  function sendChat() {
    var text = $("chat-input").value.trim();
    if (!text || state.busy) return;
    state.busy = true;
    $("send").disabled = true;
    $("chat-input").value = "";
    addMessage("user", text);
    var el = addMessage("assistant", "");
    var body = el.querySelector(".body");
    body.textContent = "…";
    var streamed = "";
    var params = idQuery();
    params.set("text", text);
    var es = new EventSource("/api/chat/stream?" + params.toString());
    var finished = false;
    function done() {
      if (finished) return;
      finished = true;
      es.close();
      state.busy = false;
      $("send").disabled = false;
      $("chat-input").focus();
    }
    es.addEventListener("delta", function (ev) {
      streamed += JSON.parse(ev.data).text;
      body.textContent = streamed;
      $("messages").scrollTop = $("messages").scrollHeight;
    });
    es.addEventListener("done", function (ev) {
      var result = JSON.parse(ev.data);
      state.lastRun = result;
      finishAssistant(el, result);
      renderInjected(result);
      setStatus("turn " + result.runId + " · " + result.recall.summary);
      done();
      refreshAll().catch(fail);
    });
    es.addEventListener("error", function (ev) {
      var msg = "stream error";
      try { if (ev.data) msg = JSON.parse(ev.data).error; } catch (e) { /* not ours */ }
      if (!finished) { body.textContent = streamed || "(" + msg + ")"; setStatus(msg, true); }
      done();
    });
    es.onerror = function () { if (!finished) { body.textContent = streamed || "(connection lost)"; setStatus("stream connection lost", true); } done(); };
  }
  $("send").addEventListener("click", sendChat);
  $("chat-input").addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); sendChat(); }
  });
  $("remember").addEventListener("click", function () {
    var text = $("remember-input").value.trim();
    if (!text) return;
    $("remember").disabled = true;
    post("/api/remember", { text: text }).then(function (out) {
      $("remember-input").value = "";
      setStatus("remembered via " + out.runId + " · turn " + out.turn.status + " · feedback " + out.feedback.status + (out.feedback.reason ? " (" + out.feedback.reason + ")" : ""));
      var el = addMessage("assistant", "(remembered: " + text + ")");
      el.classList.add("muted");
      return refreshAll();
    }).catch(fail).finally(function () { $("remember").disabled = false; });
  });
  $("reset").addEventListener("click", function () {
    post("/api/reset").then(function () { $("messages").innerHTML = ""; state.lastRun = null; setStatus("chat history reset"); }).catch(fail);
  });
  $("forget-subject").addEventListener("click", function () {
    if (!confirm("Delete every node, hint, event and audit row for subject " + state.subjectId + "?")) return;
    del("/api/subject").then(function () { $("messages").innerHTML = ""; state.lastRun = null; setStatus("subject " + state.subjectId + " forgotten"); return refreshAll(); }).catch(fail);
  });
  async function loadHistory() {
    var h = await get("/api/history");
    $("messages").innerHTML = "";
    h.messages.forEach(function (m) { addMessage(m.role === "assistant" ? "assistant" : "user", m.content); });
    $("history-note").textContent = h.messages.length ? h.messages.length + " messages in server history" : "";
  }

  // ── injected tab ──
  function renderInjected(result) {
    var r = result.recall;
    var lines = [
      r.summary,
      "provenance (candidate ids): " + (r.provenance.length ? r.provenance.join(", ") : "—"),
      "agent used for nodePreamble: " + (result.agent || "(direct — no agent preamble)"),
    ];
    showPre("inj-recall", lines.join("\n"));
    showPre("inj-preRoute", result.injected.preRoute);
    showPre("inj-agent", result.injected.agent);
    showPre("inj-responseStyle", result.injected.responseStyle);
    showPre("inj-system", result.systemPrompt);
    showPre("inj-receipt", JSON.stringify({ receipt: result.receipt, topic: r.topic, meta: r.meta, laneCounts: r.laneCounts }, null, 2));
  }

  // ── graph tab ──
  function renderHint(h, extraClass) {
    var r = h.hint;
    var chips = [
      chip(r.lane, "lane-" + r.lane), chip(r.scope + (r.agent ? " " + r.agent : "") + (r.clientId ? " client=" + r.clientId : "")), chip(r.source),
      chip(r.status, "status-" + r.status), chip(r.approval, "approval-" + r.approval), chip(r.maturity), chip(r.kind),
      r.needsReview ? chip("needs review", "review") : "",
      chip(r.slot + "=" + JSON.stringify(r.value)),
      chip("conf " + r.confidence.toFixed(2)), chip("eff " + h.effectiveScore.toFixed(2)), chip("decay " + h.decayWeight.toFixed(2)),
      h.suppressedBy ? chip("suppressed by " + h.suppressedBy.hintId + " (" + h.suppressedBy.rule + ")", "review") : "",
      r.retiredReason ? chip("retired: " + r.retiredReason, "status-retired") : "",
    ].join("");
    var canApprove = r.status === "active" || r.status === "pending";
    return '<li class="hint ' + (extraClass || "") + '" data-id="' + esc(r.id) + '">' +
      '<div class="text">' + esc(r.text) + ' <span class="muted mono">' + esc(r.nodePath) + '</span></div>' +
      '<div class="chips">' + chips + '</div>' +
      '<div class="why">' + esc(h.why) + ' · id=' + esc(r.id) + '</div>' +
      '<div class="hint-actions">' +
        (canApprove ? '<button class="small" data-action="approved">Approve</button><button class="small" data-action="rejected">Reject</button>' : "") +
        '<button class="small danger" data-action="forget">Forget</button>' +
      '</div></li>';
  }
  function renderNode(n) {
    var node = n.node;
    var props = Object.keys(node.properties || {}).length ? '<div class="props mono muted">props ' + esc(JSON.stringify(node.properties)) + '</div>' : "";
    return '<div class="node">' +
      '<div class="head">' + esc(node.path === "/" ? "/ (global)" : node.path) + ' <span class="muted">— ' + esc(node.title) +
        ' · ' + n.hints.length + ' hint' + (n.hints.length === 1 ? "" : "s") +
        (node.agents && node.agents.length ? ' · agents=' + esc(node.agents.join(",")) : "") +
        (node.status !== "active" ? ' · ' + esc(node.status) : "") + '</span></div>' +
      props +
      (n.hints.length ? '<ul class="hints">' + n.hints.map(function (h) { return renderHint(h, ""); }).join("") + '</ul>' : "") +
      n.children.map(renderNode).join("") +
      '</div>';
  }
  function renderTrace(trace) {
    if (!trace) { $("trace").innerHTML = ""; return; }
    var rows = trace.candidates.map(function (c) {
      return '<tr><td class="outcome-' + c.outcome + '">' + esc(c.outcome) + '</td><td class="mono">' + esc(c.hintId) + '</td>' +
        '<td>' + c.relevance.toFixed(2) + '</td><td>' + c.decayWeight.toFixed(2) + '</td><td>' + c.effective.toFixed(2) + '</td>' +
        '<td>' + esc(c.rule || "") + ' ' + esc(c.reason || "") + '</td></tr>';
    }).join("");
    $("trace").innerHTML = '<h2>Dry-run recall</h2>' +
      '<div class="mono">topic=' + esc(trace.topic.category) + ' (' + trace.topic.confidence.toFixed(2) + ', ' + esc(trace.topic.method) + ') agents=[' + esc(trace.topic.agents.join(",")) + '] paths=' + esc(trace.topic.nodePaths.join(",") || "—") +
      ' · ' + trace.recall.meta.status + ' · ' + trace.recall.charter.tokenEstimate + ' tok</div>' +
      (rows ? '<table><tr><th>outcome</th><th>hint</th><th>rel</th><th>decay</th><th>eff</th><th>rule / reason</th></tr>' + rows + '</table>' : '<div class="muted">no candidates</div>');
  }
  function renderExplain(e) {
    var s = e.stats;
    showPre("graph-stats", "subject " + e.subjectId + (e.tenantId ? " tenant " + e.tenantId : "") + " · " + s.nodes + " nodes · " + s.activeHints + " active · " + s.pending + " pending · " + s.retired + " retired · slots: " + (s.slots.join(", ") || "—") + "\ngenerated " + fmtTime(e.generatedAt));
    renderTrace(e.trace);
    $("tree").innerHTML = '<h2>Graph</h2>' + (e.tree.length ? e.tree.map(renderNode).join("") : '<div class="muted">empty — no nodes yet for this subject</div>');
    $("pending").innerHTML = e.pendingApproval.length ? '<h2>Pending approval (' + e.pendingApproval.length + ')</h2><ul class="hints">' + e.pendingApproval.map(function (h) { return renderHint(h, ""); }).join("") + '</ul>' : "";
    $("retired").innerHTML = e.retired.length ? '<h2>Retired (' + e.retired.length + ')</h2><ul class="hints">' + e.retired.map(function (h) { return renderHint(h, "retired"); }).join("") + '</ul>' : "";
    $("events").innerHTML = e.recentEvents.length ? '<table><tr><th>at</th><th>kind</th><th>status</th><th>id</th><th>run</th><th>ops</th></tr>' + e.recentEvents.map(function (ev) {
      return '<tr><td class="mono">' + esc(fmtTime(ev.at)) + '</td><td>' + esc(ev.kind) + '</td><td>' + esc(ev.status) + (ev.scrubbedAt ? ' (scrubbed)' : '') + '</td><td class="mono">' + esc(ev.id) + '</td><td class="mono">' + esc(ev.runId || "") + '</td>' +
        '<td class="mono">' + (ev.accepted !== undefined ? "+" + ev.accepted : "") + (ev.rejected !== undefined ? " −" + ev.rejected : "") + '</td></tr>';
    }).join("") + '</table>' : '<div class="muted">no events</div>';
    $("audit").innerHTML = e.audit.length ? '<table><tr><th>at</th><th>action</th><th>actor</th><th>hint</th><th>node</th><th>detail</th></tr>' + e.audit.map(function (a) {
      return '<tr><td class="mono">' + esc(fmtTime(a.at)) + '</td><td>' + esc(a.action) + '</td><td class="mono">' + esc(a.actor) + '</td><td class="mono">' + esc(a.hintId || "") + '</td><td class="mono">' + esc(a.nodePath || "") + '</td>' +
        '<td class="mono">' + esc(a.detail && Object.keys(a.detail).length ? JSON.stringify(a.detail) : "") + '</td></tr>';
    }).join("") + '</table>' : '<div class="muted">no audit rows</div>';
  }
  async function refreshGraph() {
    var params = {};
    var q = $("dry-input").value.trim();
    if (q) params.query = q;
    if ($("include-retired").checked) params.includeRetired = "1";
    renderExplain(await get("/api/explain", params));
  }
  async function refreshStats() {
    showPre("stats", JSON.stringify(await get("/api/stats"), null, 2));
  }
  async function refreshAll() {
    await refreshGraph();
    await refreshStats();
  }
  $("dry-run").addEventListener("click", function () { refreshGraph().catch(fail); });
  $("dry-input").addEventListener("keydown", function (ev) { if (ev.key === "Enter") refreshGraph().catch(fail); });
  $("include-retired").addEventListener("change", function () { refreshGraph().catch(fail); });
  $("graph-refresh").addEventListener("click", function () { refreshGraph().catch(fail); });
  $("tab-graph").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-action]");
    if (!b) return;
    var li = b.closest("li.hint");
    var hintId = li.dataset.id;
    var action = b.dataset.action;
    b.disabled = true;
    var p = action === "forget"
      ? del("/api/hint/" + encodeURIComponent(hintId))
      : post("/api/hint/" + encodeURIComponent(hintId) + "/approve", { status: action, by: "web:" + state.subjectId });
    p.then(function () { setStatus(action + " " + hintId); return refreshAll(); }).catch(fail).finally(function () { b.disabled = false; });
  });

  // ── maintenance tab ──
  document.querySelectorAll("button[data-maint]").forEach(function (b) {
    b.addEventListener("click", function () {
      b.disabled = true;
      post("/api/maintenance/" + b.dataset.maint).then(function (out) {
        showPre("maint-report", JSON.stringify(out, null, 2));
        setStatus(out.action + " done in " + out.elapsedMs + "ms");
        return refreshAll();
      }).catch(fail).finally(function () { b.disabled = false; });
    });
  });
  $("stats-refresh").addEventListener("click", function () { refreshStats().catch(fail); });

  // ── boot ──
  loadConfig().then(loadHistory).then(refreshAll).catch(fail);
})();
</script>
</body>
</html>
`;
