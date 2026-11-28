/**
 * Pure view logic for the Stop That Shit panel.
 *
 * No DOM, no bridge: the same functions run in the panel and in `node --test`,
 * so the rendering rules are verified without a browser.
 */
(function attach(root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StsView = factory();
})(typeof globalThis === "undefined" ? this : globalThis, function () {
  "use strict";

  var MODE_LABEL = {
    answer: "answer",
    review: "review",
    monitor: "monitor",
    change: "change",
    open: "open",
    unconfirmed: "unconfirmed"
  };

  function text(value, fallback) {
    if (value === 0) return "0";
    if (value === null || value === undefined || value === "") return fallback === undefined ? "—" : fallback;
    return String(value);
  }

  function formatTime(iso) {
    if (!iso) return "—";
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    var pad = function pad(value) { return String(value).padStart(2, "0"); };
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
      + " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  // The Guard has one active level per session; "observing" is what the user
  // sees when nothing is armed yet, which is the install default.
  function controlState(contract) {
    var level = contract && contract.level ? String(contract.level) : "watch";
    var mode = contract && contract.mode ? String(contract.mode) : "unconfirmed";
    if (level === "off") return "off";
    if (level === "watch") return mode === "unconfirmed" ? "observing" : "watching";
    return level === "lock" ? "locked" : "armed";
  }

  function headline(contract) {
    var state = controlState(contract);
    var mode = MODE_LABEL[contract && contract.mode] || "unconfirmed";
    return { state: state, mode: mode, label: state + " · " + mode };
  }

  function policyRows(contract) {
    var source = contract || {};
    var budget = source.agentBudget;
    var agents = typeof budget === "number" && Number.isFinite(budget)
      ? (budget >= Number.MAX_SAFE_INTEGER ? "unlimited" : String(budget))
      : "unlimited";
    var files = Array.isArray(source.allowedPaths) && source.allowedPaths.length
      ? source.allowedPaths.join(", ")
      : "any path";
    return [
      { id: "agents", label: "Agents", value: agents },
      { id: "hash", label: "Hash", value: text(source.hashPolicy, "deny") },
      { id: "deps", label: "Deps", value: text(source.dependencyPolicy, "ask") },
      { id: "files", label: "Files", value: files },
      { id: "source", label: "Authority", value: text(source.source, "default") }
    ];
  }

  function runtimeRows(summary) {
    var value = summary || {};
    var labels = value.labels || {};
    return [
      { id: "checked", label: "Checked actions", value: text(value.checkedActions, "0") },
      { id: "context", label: "Context responses", value: text(value.contextResponses, "0") },
      { id: "deny", label: "Permission denies", value: text(value.permissionDenyResponses, "0") },
      { id: "execDeny", label: "Execution denies", value: text(value.executionDenialResponses, "0") },
      { id: "correct", label: "Labeled correct", value: text(labels.correct, "0") },
      { id: "incorrect", label: "Labeled incorrect", value: text(labels.incorrect, "0") },
      { id: "inconclusive", label: "Labeled inconclusive", value: text(labels.inconclusive, "0") },
      { id: "damaged", label: "Damaged records", value: text(value.damagedRecords, "0") }
    ];
  }

  function eventRow(event) {
    var action = (event && event.action) || {};
    var decision = (event && event.decision) || {};
    return {
      eventId: text(event && event.eventId, ""),
      occurredAt: text(event && event.occurredAt, ""),
      time: formatTime(event && event.occurredAt),
      toolName: text(action.toolName, "unknown"),
      mutability: text(action.mutability, "unknown"),
      policyOutcome: text(decision.policyOutcome, "—"),
      reasonCode: text(decision.reasonCode, "—"),
      responseOutcome: text(decision.responseOutcome, "—"),
      hostEffect: text(decision.hostEffect, "unobserved"),
      mode: text((event && event.contract && event.contract.mode) || "unconfirmed", "unconfirmed"),
      controlState: text(event && event.controlState, "—"),
      label: text(event && event.label, "")
    };
  }

  function filterEvents(events, filters) {
    var options = filters || {};
    var query = String(options.query || "").trim().toLowerCase();
    var outcome = String(options.outcome || "").trim();
    return (events || []).map(eventRow).filter(function (row) {
      if (outcome && row.policyOutcome !== outcome) return false;
      if (!query) return true;
      return [row.toolName, row.reasonCode, row.mutability, row.mode, row.eventId]
        .some(function (field) { return String(field).toLowerCase().indexOf(query) !== -1; });
    });
  }

  function explainLines(event, t) {
    if (!event) return [];
    var row = eventRow(event);
    var action = event.action || {};
    var decision = event.decision || {};
    var contract = event.contract || {};
    // Without a translator these lines stay the English text the tests pin.
    var say = function say(key, fallback) {
      return typeof t === "function" ? t(key) : fallback;
    };
    var lines = [
      say("explain.event", "Event: ") + row.eventId,
      say("explain.when", "When: ") + row.time,
      say("explain.state", "State: ") + String(row.controlState).toUpperCase() + " / " + row.mode,
      say("explain.action", "Action: ") + row.toolName + " (" + row.mutability + ")"
        + say("explain.paths", "; paths=") + text(action.pathCount, "0"),
      say("explain.decision", "Decision: ") + row.policyOutcome + " / " + row.reasonCode,
      say("explain.response", "Response: ") + row.responseOutcome,
      say("explain.hostEffect", "Host effect: ") + row.hostEffect,
      say("explain.policy", "Hash: {hash}; deps: {deps}; agents: {agents}")
        .replace("{hash}", text(contract.hashPolicy, "deny"))
        .replace("{deps}", text(contract.dependencyPolicy, "ask"))
        .replace("{agents}", text(contract.agentBudget, "unlimited")),
      say("explain.label", "Label: ") + (row.label || say("label.unlabeled", "unlabeled"))
    ];
    if (decision.explanation) lines.push(say("explain.why", "Why: ") + decision.explanation);
    if (decision.nextStep) lines.push(say("explain.next", "Next: ") + decision.nextStep);
    return lines;
  }

  function doctorRows(report) {
    if (!report) return [];
    var probe = report.extension;
    var rows = (report.checks || []).map(function (check) {
      return {
        id: check.id,
        ok: Boolean(check.ok),
        label: check.ok ? "PASS" : "FAIL",
        labelKey: check.ok ? "pass" : "fail",
        detail: text(check.detail, ""),
        detailKey: check.id,
        detailArgs: check.data || {}
      };
    });
    // The probe answers "is the Guard even loaded here?", which the other rows
    // cannot: they only describe files that may have been written elsewhere.
    rows.unshift(probe
      ? {
        id: "extension",
        ok: true,
        label: "LOADED",
        labelKey: "loaded",
        detail: "registered " + formatTime(probe.registeredAt) + " · command API: " + text(probe.commandApi, "unknown"),
        detailKey: "extensionLoaded",
        detailArgs: { time: formatTime(probe.registeredAt), api: text(probe.commandApi, "unknown") }
      }
      : {
        id: "extension",
        ok: false,
        label: "WAITING",
        labelKey: "waiting",
        detail: "the agent extension has not registered in this data directory yet",
        detailKey: "extensionWaiting",
        detailArgs: {}
      });
    return rows;
  }

  // The doctor's rows carry numbers plus a sentence; this turns them into the
  // sentence for the current language, falling back to the recorded English one.
  function doctorDetail(row, t) {
    if (!row) return "";
    var key = row.detailKey === "extensionDataDir" && row.detailArgs && row.detailArgs.elsewhere
      ? "doctor.extensionElsewhere"
      : "doctor." + row.detailKey;
    var template = typeof t === "function" ? t(key) : null;
    if (!template || template === key) return text(row.detail, "");
    var args = row.detailArgs || {};
    if (key === "doctor.stateFiles" && args.unreadable) {
      args = { total: args.total, damaged: args.damaged, unreadable: " (" + args.unreadable + ")" };
    }
    return String(template).replace(/\{(\w+)\}/g, function (match, name) {
      var value = args[name];
      return value === undefined || value === null ? "" : String(value);
    });
  }

  function summarize(overview) {
    if (!overview || overview.ok === false) {
      return { state: "unavailable", mode: "—", label: "unavailable · —" };
    }
    var sessions = overview.sessions || {};
    var list = sessions.list || [];
    var contract = list.length ? list[0].contract : null;
    var head = headline(contract);
    return {
      state: head.state,
      mode: head.mode,
      label: head.label,
      sessions: text(sessions.total, "0"),
      damagedSessions: text(sessions.damaged, "0"),
      locks: text((overview.locks || {}).count, "0"),
      staleLocks: text((overview.locks || {}).stale, "0")
    };
  }

  return {
    controlState: controlState,
    doctorDetail: doctorDetail,
    doctorRows: doctorRows,
    eventRow: eventRow,
    explainLines: explainLines,
    filterEvents: filterEvents,
    formatTime: formatTime,
    headline: headline,
    policyRows: policyRows,
    runtimeRows: runtimeRows,
    summarize: summarize
  };
});
