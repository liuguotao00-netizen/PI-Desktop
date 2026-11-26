// LLM Council guard: while a council run is active, Task calls that would break the council's
// rules are blocked. Everything else passes, and any error passes too (fail open).
//
// The hook fires in every session, including the council sub-agents (they have only Read and
// Write, so a Task-only guard never touches them).
import fs from "node:fs";
import path from "node:path";

const RUNS = path.join(".llm-council", "runs");
const ACTIVE_MS = 3 * 60 * 60 * 1000; // a run older than this is finished or abandoned
const GENERIC_AGENTS = new Set(["explorer", "fixer", "code-reviewer", "test-runner", "ui-designer"]);

const exists = (p) => {
	try {
		fs.statSync(p);
		return true;
	} catch {
		return false;
	}
};

/** The newest run directory (names sort chronologically) that is started, not reported and fresh; null when none. */
export function activeRun(cwd, nowMs = Date.now()) {
	const root = path.join(cwd, RUNS);
	let names;
	try {
		names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return null;
	}
	for (const name of names.sort().reverse()) {
		const dir = path.join(root, name);
		if (!exists(path.join(dir, "question.md")) && !exists(path.join(dir, "user_question.md"))) continue;
		if (exists(path.join(dir, "report.md"))) continue;
		if (nowMs - fs.statSync(dir).mtimeMs >= ACTIVE_MS) continue;
		return dir;
	}
	return null;
}

/** The models that failed in a run, from its failovers.json. */
export function failedModels(dir) {
	try {
		const data = JSON.parse(fs.readFileSync(path.join(dir, "failovers.json"), "utf8"));
		return Array.isArray(data?.failed) ? data.failed.filter((m) => typeof m === "string") : [];
	} catch {
		return [];
	}
}

/** Null when the Task call is allowed, else the reason to block it. */
export function judge(input, dir) {
	const agent = typeof input?.agent === "string" ? input.agent : "";
	const model = typeof input?.model === "string" ? input.model : "";
	const shown = path.join(RUNS, path.basename(dir)).split(path.sep).join("/");
	if (GENERIC_AGENTS.has(agent)) return `LLM Council: seats run only on council-* personas (run ${shown})`;
	if (agent.startsWith("council-") && input?.resume) return "LLM Council: every stage is a fresh delegation; never resume a seat";
	if (model && failedModels(dir).includes(model)) {
		return `LLM Council: model ${model} failed earlier in this run; call council next / start for the replacement`;
	}
	return null;
}

export default function councilGuard(pi) {
	pi.on("tool_call", async (event, ctx) => {
		try {
			if (String(event?.toolName).toLowerCase() !== "task") return undefined;
			const cwd = ctx?.cwd;
			if (typeof cwd !== "string" || !cwd) return undefined;
			const dir = activeRun(cwd);
			if (!dir) return undefined;
			const reason = judge(event.input, dir);
			return reason ? { block: true, reason } : undefined;
		} catch {
			return undefined;
		}
	});
}
