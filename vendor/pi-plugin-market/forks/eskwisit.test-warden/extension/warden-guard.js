// Test Warden guard: while a run is open, the code under test is read-only for every tool call.
// warden_check plan writes .test-warden/guard.json; warden_lessons add or warden_check release
// removes it. The hook fires in every session with the same cwd, writers included.
import fs from "node:fs";
import path from "node:path";

const GUARD = ".test-warden/guard.json";
const EDIT_TOOLS = new Set(["edit", "write", "multiedit"]);
const SCRIPT_TIMEOUT = 900; // seconds; the Bash tool's `timeout` field
const DIR_RE = /\.test-warden\//;
const SCRIPT_RE = /\.test-warden\/runs\/[^\s'"]*\.sh\b/;

function rel(cwd, p) {
	return path.relative(cwd, path.resolve(cwd, p)).split(path.sep).join("/");
}

// { run, sources: Set } while the guard is active, else null.
function readGuard(cwd) {
	let g;
	try {
		g = JSON.parse(fs.readFileSync(path.join(cwd, GUARD), "utf8"));
	} catch {
		return null;
	}
	if (!g || !Array.isArray(g.sources)) return null;
	const until = Date.parse(g.until);
	if (!Number.isFinite(until) || until <= Date.now()) return null;
	return { run: String(g.run ?? ""), sources: new Set(g.sources.filter((s) => typeof s === "string")) };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A protected path is "written" when it follows one of these; for cp only as the last argument.
const END = "(?=\\s*(?:$|[;&|)]))";
const WRITE_OPS = [">>?\\s*", "sed\\s+-[a-zA-Z]*i[^|;&]*?", "perl\\s+-[a-zA-Z]*[pn]?i[^|;&]*?", "(?:rm|mv)\\s+[^|;&]*?", "git\\s+checkout\\s+[^|;&]*?--\\s+[^|;&]*?", "git\\s+restore\\s+[^|;&]*?", "tee\\s+(?:-a\\s+)?"];
const COPY_OPS = ["cp\\s+[^|;&]*?"];

// The protected source a Bash command obviously writes to, or null.
function bashTarget(cmd, sources) {
	for (const src of sources) {
		if (!cmd.includes(src)) continue;
		const file = `['"]?(?:\\.\\/)?${esc(src)}['"]?(?=$|[\\s;&|)])`;
		const hit = (ops, tail) => ops.some((op) => new RegExp(`(?:^|[\\s;&|(])${op}${file}${tail}`).test(cmd));
		if (hit(WRITE_OPS, "") || hit(COPY_OPS, END)) return src;
	}
	return null;
}

const readOnly = (p, run) => `Test Warden: ${p} is code under test and read-only during run ${run}. Report the bug instead of fixing it; \`warden_check {action:"release"}\` lifts the guard when the user explicitly asks for the fix.`;

// Null when allowed, else the reason to block.
export function judge(cwd, name, input) {
	const guard = readGuard(cwd);
	if (!guard) return null;
	if (EDIT_TOOLS.has(name)) {
		const file = input?.path ?? input?.file_path;
		const target = typeof file === "string" ? rel(cwd, file) : null;
		return target && guard.sources.has(target) ? readOnly(target, guard.run) : null;
	}
	if (name === "task") return input?.agent === "fixer" ? "Test Warden: the fixer agent edits source until tests pass; use test-warden-writer." : null;
	if (name !== "bash" || typeof input?.command !== "string") return null;
	const cmd = input.command;
	if (SCRIPT_RE.test(cmd)) {
		const t = Number(input.timeout);
		if (!Number.isFinite(t) || t < SCRIPT_TIMEOUT) return `Test Warden: run warden scripts with timeout ≥ ${SCRIPT_TIMEOUT} (this one: ${input.timeout ?? "missing"}).`;
	}
	// The plugin's own restoreCommand/undoCommand copies from the snapshot in .test-warden/.
	if (DIR_RE.test(cmd)) return null;
	const hit = bashTarget(cmd, guard.sources);
	return hit ? readOnly(hit, guard.run) : null;
}

export default function wardenGuard(pi) {
	pi.on("tool_call", async (event, ctx) => {
		try {
			const reason = judge(ctx.cwd, String(event.toolName).toLowerCase(), event.input);
			return reason ? { block: true, reason } : undefined;
		} catch {
			return undefined; // fail open: the gate's snapshot check is the backstop
		}
	});
}
