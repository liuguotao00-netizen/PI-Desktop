/**
 * Human-facing phrases for plugin tool calls.
 *
 * Plugin tools arrive as raw identifiers (`browser_click`, `run_automation`)
 * and their arguments are JSON objects, which is what a technical trace should
 * keep but what a chat row must not show. This table turns the tools that ship
 * with the desktop into a verb plus one readable object, in the UI language.
 */
export type ToolPhrase = {
  labelKey: string;
  runningKey: string;
  summaryKey?: string;
  summaryParams?: Record<string, string | number>;
};

type Title = { labelKey: string; runningKey: string };

const TITLES: Record<string, Title> = {
  // pi.browser — actions on the page.
  browserclick: { labelKey: "chat.tools.browser.click", runningKey: "chat.tools.browser.clicking" },
  browsermouseclickxy: {
    labelKey: "chat.tools.browser.clickXY",
    runningKey: "chat.tools.browser.clickingXY",
  },
  browserhover: { labelKey: "chat.tools.browser.hover", runningKey: "chat.tools.browser.hovering" },
  browsertype: { labelKey: "chat.tools.browser.type", runningKey: "chat.tools.browser.typing" },
  browserfill: { labelKey: "chat.tools.browser.fill", runningKey: "chat.tools.browser.filling" },
  browserfillform: {
    labelKey: "chat.tools.browser.fillForm",
    runningKey: "chat.tools.browser.fillingForm",
  },
  browserselectoption: {
    labelKey: "chat.tools.browser.selectOption",
    runningKey: "chat.tools.browser.selectingOption",
  },
  browserpresskey: {
    labelKey: "chat.tools.browser.pressKey",
    runningKey: "chat.tools.browser.pressingKey",
  },
  browserscroll: { labelKey: "chat.tools.browser.scroll", runningKey: "chat.tools.browser.scrolling" },
  browserdrag: { labelKey: "chat.tools.browser.drag", runningKey: "chat.tools.browser.dragging" },
  browserhighlight: {
    labelKey: "chat.tools.browser.highlight",
    runningKey: "chat.tools.browser.highlighting",
  },
  browsernavigate: {
    labelKey: "chat.tools.browser.navigate",
    runningKey: "chat.tools.browser.navigating",
  },
  // pi.browser — data reads.
  browsersnapshot: {
    labelKey: "chat.tools.browser.snapshot",
    runningKey: "chat.tools.browser.snapshotting",
  },
  browsergetboundingbox: {
    labelKey: "chat.tools.browser.measure",
    runningKey: "chat.tools.browser.measuring",
  },
  browsertakescreenshot: {
    labelKey: "chat.tools.browser.screenshot",
    runningKey: "chat.tools.browser.screenshotting",
  },
  browsertabs: { labelKey: "chat.tools.browser.tabs", runningKey: "chat.tools.browser.listingTabs" },
  browserlock: { labelKey: "chat.tools.browser.lock", runningKey: "chat.tools.browser.locking" },
  browsertelemetry: {
    labelKey: "chat.tools.browser.telemetry",
    runningKey: "chat.tools.browser.readingTelemetry",
  },
  browsercdp: { labelKey: "chat.tools.browser.command", runningKey: "chat.tools.browser.runningCommand" },
  browserdialog: { labelKey: "chat.tools.browser.dialog", runningKey: "chat.tools.browser.dialogging" },
  browserwait: { labelKey: "chat.tools.browser.wait", runningKey: "chat.tools.browser.waiting" },
  browserconsole: { labelKey: "chat.tools.browser.console", runningKey: "chat.tools.browser.consoling" },
  browsernetwork: { labelKey: "chat.tools.browser.network", runningKey: "chat.tools.browser.networking" },

  // pi.taobao-tools — data retrieval.
  listscripts: {
    labelKey: "chat.tools.data.listScripts",
    runningKey: "chat.tools.data.listingScripts",
  },
  evalscript: {
    labelKey: "chat.tools.data.evalScript",
    runningKey: "chat.tools.data.evaluatingScript",
  },
  checksession: {
    labelKey: "chat.tools.data.checkSession",
    runningKey: "chat.tools.data.checkingSession",
  },
  fetchsearchkeywords: {
    labelKey: "chat.tools.data.fetchKeywords",
    runningKey: "chat.tools.data.fetchingKeywords",
  },
  finishtask: {
    labelKey: "chat.tools.data.finishTask",
    runningKey: "chat.tools.data.finishingTask",
  },
  listautomations: {
    labelKey: "chat.tools.data.listAutomations",
    runningKey: "chat.tools.data.listingAutomations",
  },
  prepareautomation: {
    labelKey: "chat.tools.data.prepareAutomation",
    runningKey: "chat.tools.data.preparingAutomation",
  },
  runautomation: {
    labelKey: "chat.tools.data.runAutomation",
    runningKey: "chat.tools.data.runningAutomation",
  },
  getautomationrun: {
    labelKey: "chat.tools.data.getRun",
    runningKey: "chat.tools.data.gettingRun",
  },
};

function normalized(toolName?: string): string {
  return (toolName || "")
    .split(".")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const TITLE_SUFFIXES = Object.keys(TITLES).sort((a, b) => b.length - a.length);

/**
 * Persisted plugin tools are namespaced (`plugin_pi_browser_browser_click`);
 * in-memory ones may be `pi.browser.browser_click` or bare. Match the bare
 * tool name as a suffix so every surface gets the same phrase.
 */
function resolveTool(toolName?: string): { key: string; title: Title } | null {
  const key = normalized(toolName);
  if (TITLES[key]) return { key, title: TITLES[key] };
  const suffix = TITLE_SUFFIXES.find((candidate) => key.endsWith(candidate));
  return suffix ? { key: suffix, title: TITLES[suffix] } : null;
}

function text(value: unknown, limit = 60): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function asRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

function target(record: Record<string, unknown>): ToolPhrase | null {
  const name = text(record.element, 40);
  if (name) return { labelKey: "", runningKey: "", summaryKey: "chat.tools.summary.target", summaryParams: { target: name } };
  const ref = text(record.ref, 20);
  if (ref) return { labelKey: "", runningKey: "", summaryKey: "chat.tools.summary.ref", summaryParams: { ref } };
  return null;
}

function withTitle(title: Title, summary: ToolPhrase | null): ToolPhrase {
  return {
    ...title,
    ...(summary?.summaryKey
      ? { summaryKey: summary.summaryKey, summaryParams: summary.summaryParams }
      : {}),
  };
}

function shortUrl(value: unknown): string {
  const raw = text(value, 120);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return text(`${url.host}${url.pathname === "/" ? "" : url.pathname}`, 60);
  } catch {
    return raw;
  }
}

export function getToolPhrase(toolName?: string, args?: unknown): ToolPhrase | null {
  const resolved = resolveTool(toolName);
  if (!resolved) return null;
  const { key, title } = resolved;
  const record = asRecord(args);

  switch (key) {
    case "browserclick":
    case "browserhover":
    case "browserhighlight":
    case "browsergetboundingbox":
    case "browserselectoption":
      return withTitle(title, target(record));
    case "browsertype":
    case "browserfill":
      // The value itself is never echoed: password fields must stay private.
      return withTitle(title, target(record));
    case "browserfillform": {
      const fields = Array.isArray(record.fields) ? record.fields.length : 0;
      return withTitle(
        title,
        fields
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.fields",
              summaryParams: { count: fields },
            }
          : null,
      );
    }
    case "browserpresskey": {
      const pressed = text(record.key, 20);
      return withTitle(
        title,
        pressed
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.key",
              summaryParams: { key: pressed },
            }
          : null,
      );
    }
    case "browsernavigate": {
      const url = shortUrl(record.url);
      return withTitle(
        title,
        url
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.url",
              summaryParams: { url },
            }
          : null,
      );
    }
    case "browserscroll": {
      const direction = text(record.direction, 10).toLowerCase();
      const keyByDirection: Record<string, string> = {
        up: "chat.tools.summary.scrollUp",
        down: "chat.tools.summary.scrollDown",
        left: "chat.tools.summary.scrollLeft",
        right: "chat.tools.summary.scrollRight",
      };
      return withTitle(
        title,
        keyByDirection[direction]
          ? { labelKey: "", runningKey: "", summaryKey: keyByDirection[direction] }
          : null,
      );
    }
    case "browserdrag": {
      const from = text(record.from, 20);
      const to = text(record.to, 20);
      return withTitle(
        title,
        from && to
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.drag",
              summaryParams: { from, to },
            }
          : null,
      );
    }
    case "browsermouseclickxy": {
      const x = Number(record.x);
      const y = Number(record.y);
      return withTitle(
        title,
        Number.isFinite(x) && Number.isFinite(y)
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.coords",
              summaryParams: { x, y },
            }
          : null,
      );
    }
    case "browsertakescreenshot": {
      if (record.fullPage === true) {
        return withTitle(title, { labelKey: "", runningKey: "", summaryKey: "chat.tools.summary.fullPage" });
      }
      return withTitle(title, target(record));
    }
    case "evalscript": {
      const script = text(record.script, 40);
      return withTitle(
        title,
        script
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.script",
              summaryParams: { script },
            }
          : null,
      );
    }
    case "fetchsearchkeywords": {
      const category = text(record.cate_name, 40) || text(record.cate_id, 40);
      return withTitle(
        title,
        category
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.category",
              summaryParams: { category },
            }
          : null,
      );
    }
    case "prepareautomation":
    case "runautomation": {
      const id = text(record.id, 40);
      return withTitle(
        title,
        id
          ? {
              labelKey: "",
              runningKey: "",
              summaryKey: "chat.tools.summary.automation",
              summaryParams: { id },
            }
          : null,
      );
    }
    case "browserwait": {
      const target = text(record.target, 40);
      if (target) {
        return withTitle(title, {
          labelKey: "", runningKey: "",
          summaryKey: "chat.tools.summary.target", summaryParams: { target },
        });
      }
      const kindKey: Record<string, string> = {
        selector: "waitSelector", text: "waitText", url: "waitUrl",
        navigation: "waitNavigation", domStable: "waitDomStable", networkIdle: "waitNetworkIdle",
      };
      const suffix = kindKey[text(record.kind, 20)];
      return withTitle(
        title,
        suffix ? { labelKey: "", runningKey: "", summaryKey: `chat.tools.summary.${suffix}` } : null,
      );
    }
    case "browserdialog": {
      const action = text(record.action, 20);
      return withTitle(title, {
        labelKey: "", runningKey: "",
        summaryKey: action === "dismiss" ? "chat.tools.summary.dialogDismiss" : "chat.tools.summary.dialogAccept",
      });
    }
    default:
      return withTitle(title, null);
  }
}
