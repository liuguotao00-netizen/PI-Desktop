// 常驻规则 + 机械闸门 —— 本插件唯一一处跑在 agent 进程里的代码。
//
// ── 为什么需要它 ─────────────────────────────────────────────────────────────
//
// 宿主把插件的技能目录放进基础系统提示（每轮都在），但那段文本的框架语是**条件式**的：
// "When a task matches a skill's description, load the skill first and follow it"。于是根路由器
// 到底会不会被读到，取决于模型愿不愿意把当前任务读成「匹配」。实测（本机 8 个会话、插件装好后）：
// 只有明说要 spec 的那两次进了工作流链路，连一次「把某个仓库移植到当前项目」的改动请求都没加载任何技能。
//
// 1.5.x 只做到「每轮把规则送到提示尾部」。规则送到了，模型照样可以先答题、先动代码——**散文管不住
// 工具调用**。所谓「不保证首次对话发现没有 spec 就去走 setting-up-a-project」，根因不在规则文本，
// 在于没有任何一处是硬约束。所以这里多了一层：`tool_call` 闸门。
//
// ── 闸门（这是「保证」这两个字的落点）────────────────────────────────────────
//
// 宿主（PI-Desktop 的 sidecar `extensionToolCall`）把每一次工具调用交给扩展，扩展返回
// `{ block: true, reason }` 时**调用根本不执行**，`reason` 作为工具结果回到模型手里。这就是一个
// 模型绕不过去的回路：它可以不听提示，但它没法让被拒的调用发生。规则只有两条：
//
//   1. 本会话还没查过 spec 图 → 任何「干活」的工具（bash/edit/write/task/browser/spec_create…）
//      都被拒，理由里点名下一步就是 `spec_validate`；
//   2. `spec_validate` 报 0 个 durable spec → 仍然拒，理由改成「先加载 setting-up-a-project 并照做」，
//      因为首次落地的优先级高于用户那句请求（与 choosing-a-workflow 的 preflight 同一句话）。
//
// 状态从哪来：只有成功的 `spec_validate` 正文首行 `[thinkrail-state] specs=N` 才是证据。
// 扩展在 `tool_result` 里读它。不猜、不嗅探文件系统——这个模块依旧**没有 import**。
//
// 三条防锁死的让步（宁可漏一次，不能把用户卡死）：
//   * 只读工具、`Skill`、提问、todo、以及 spec 的只读工具一律放行；
//   * 名字不在干活清单里的工具（第三方／未知）一律放行；
//   * `spec_validate` 的结果里没有 `[thinkrail-state] specs=N`（无工作区、工具没注册、参数被拒，
//     或宿主把插件的 `{error}` 当成成功结果）→ 闸门永久让路；连续被拒超过 16 次也永久让路。
//
// ── 两条投递通道，为什么现在必须有第二条 ─────────────────────────────────────
//
// 上游 ThinkRail 把规则写进 `before_agent_start` 的 `event.systemPromptOptions.sections` 命名槽位
// （`packages/pi-thinkrail-workflow/SPEC.md:38-41`），并明确拒绝返回 `{ systemPrompt }`——上游宿主
// 在那种情况下的语义是丢掉所有结构化 section。**通道 1 保留，就是为了那些人。**
//
// 但 PI-Desktop 0.20.x 换了 runner，这条通道已经不通。按本机 0.20.1 的
// `agent-runtime/chunks/runner-4RVVP4BP.js` 核实：
//
//     async emitBeforeAgentStart(e,n){
//       let s={type:"before_agent_start",prompt:e,systemPrompt:n,systemPromptOptions:{}};
//       return (await this.emit("before_agent_start",s,(i,r)=>
//         typeof r.systemPrompt!="string" ? i??{} : (s.systemPrompt=r.systemPrompt,{systemPrompt:r.systemPrompt})
//       ))?.systemPrompt
//     }
//
//   * `systemPromptOptions` 是**硬编码空对象**，宿主从不往里面放 `sections`；
//   * 合并器只认 `r.systemPrompt` 字符串，**完全不读** `s.sections`。
//
// 于是「写 sections」在 0.20.x 上写进了一个每轮新建、随后被丢弃的空对象：钩子返回 `{}`，宿主拿不到
// 任何东西，规则静默缺席。这正是「插件还在、路由却不触发」的成因——不是技能坏了，是注入通道断了。
//
// 0.20.x 里串行合并是**前一个的返回值作为下一个的输入**（已实测：第二个扩展看到的 `systemPrompt`
// 已含第一个追加的块），所以多个插件各自追加自己的块不会互相吃掉。代价是返回 `{ systemPrompt }`
// 意味着整条提示由我们这轮交回——但 0.20.x 里本来就没有任何插件能贡献 section（通道已死），
// 这个代价现在等于零；而通道 1 存在时我们仍然优先走通道 1，不去接管整条提示。
//
// ── 幂等 ─────────────────────────────────────────────────────────────────────
//
// 追加以 `WORKFLOW_SECTION` 包成的块为标记：已经含这个块就原样返回 `{}`。于是宿主重跑钩子、
// 或同一轮被调用两次，都不会堆叠出多份规则。
//
// 代价（用户批准时看到的就是这条）：这个模块运行在 agent 进程内，权限等同于 agent 自己的工具，
// 不再受本插件的 fs 网关约束。所以它刻意保持可审阅：**没有任何 import**、不碰文件系统、不发起网络
// 请求。宿主若不认识 `contributes.agentExtensions`，或连 `before_agent_start` / `tool_call` 都没有，
// 这里就什么都不做、也不抛错——规则静默缺席，而不是把整条提示或每一次工具调用弄坏。
//
// The entry scope is a family contract; see writing-workflow-skills.md, meta-rule 4.
// PI-Desktop needs an explicit Skill id because its skill catalog is addressed by id.
//
// 改动这段规则或闸门属于「系统级改动」：按本插件 `skills/writing-workflow-skills.md` 的元规则 13，
// 先改那里的元规则与家族表，再改这里。

/** 规则注入系统提示时占用的 section 名 / 拼接块的标签名（须匹配 `[a-z][a-z0-9_-]*`）。 */
export const WORKFLOW_SECTION = "pi-thinkrail-workflow";

/** onboarding 技能尾段：仅成功加载本插件的确切全名才算进入流程。 */
export const ONBOARDING_SKILLS = ["setting-up-a-project", "importing-a-codebase", "starting-a-new-project"];

/** `spec_validate` 正文里那行机器可读的项目状态（与 lib/tools/spec-tools.js 同字面量）。 */
export const STATE_MARK = "[thinkrail-state]";

/** 每轮注入系统提示的那一节文字。 */
export const WORKFLOW_RULE = [
	"ThinkRail is installed in this project, and two of its steps are enforced by a tool gate: an action that skips them is refused with that reason, so treat them as required, not advisory.",
	"1. Before your first action in a session that changes state or runs a command (bash, edit, write, task, browser, spec_create/update/delete), call `spec_validate`. It answers with a `[thinkrail-state] specs=N` line and changes nothing.",
	"2. If N is 0, onboarding comes first, whatever the user asked: read the `setting-up-a-project` skill (Skill tool, id `pi.thinkrail/setting-up-a-project`) and follow it before touching the project, then return to the original request and finish it. A task-spec under `.thinkrail/context/` is a draft, never a spec graph; a chat with no project attached is not a project session.",
	"3. If N is above 0, do not onboard: do not create a graph that already exists.",
	"4. Either way, read `choosing-a-workflow` (Skill tool, id `pi.thinkrail/choosing-a-workflow`) and follow it for every new piece of work — it routes to the workflow skill that governs it, or says none applies. At the first request in a project session, if source code exists but no durable spec graph exists, finish project setup before handling that request, whatever it asks, then return to it.",
].join("\n");

/** 通道 2 追加到提示尾部的整块（标签名与 section 名一致，便于幂等判断）。 */
export const WORKFLOW_BLOCK = `<${WORKFLOW_SECTION}>\n${WORKFLOW_RULE}\n</${WORKFLOW_SECTION}>`;

/** 提示里是否已经有这一块——通道 2 的幂等标记。 */
export function hasWorkflowBlock(prompt) {
	return typeof prompt === "string" && prompt.includes(`<${WORKFLOW_SECTION}>`);
}

/** 宿主传完整插件工具名；仅剥掉本插件的确切前缀，不误认其他插件。 */
function kind(name) {
	const raw = String(name ?? "").toLowerCase();
	const ownSpec = /^plugin_pi_thinkrail_(spec_(?:validate|graph|grep|get|create|update|delete))$/.exec(raw);
	return (ownSpec ? ownSpec[1] : raw).replace(/[^a-z0-9]/g, "");
}

const SPEC_TOOLS = new Set(["specvalidate", "specgraph", "specgrep", "specget", "speccreate", "specupdate", "specdelete"]);

/** 只读、提问、待办、以及 spec 的只读工具：闸门永远放行。 */
const ALLOWED = new Set([
	"skill",
	"read",
	"readfile",
	"readfiles",
	"grep",
	"rg",
	"glob",
	"ls",
	"list",
	"listdir",
	"find",
	"view",
	"tree",
	"stat",
	"search",
	"todo",
	"todowrite",
	"todoread",
	"specvalidate",
	"specgraph",
	"specgrep",
	"specget",
]);

/** 「干活」的工具：会改变项目、跑命令、或把活外包出去。闸门关着时一律拒。 */
const WORK = new Set([
	"bash",
	"shell",
	"exec",
	"run",
	"runcommand",
	"edit",
	"write",
	"multiedit",
	"patch",
	"applypatch",
	"notebookedit",
	"task",
	"agent",
	"delegate",
	"browser",
	"browserpreview",
	"webfetch",
	"websearch",
	"fetch",
	"speccreate",
	"specupdate",
	"specdelete",
]);

/** 连续被拒这么多次就永久让路：模型彻底不听时，也不能把会话焊死。 */
const MAX_BLOCKS = 16;

/** 工具结果正文：宿主传 `content` 字符串或内容块数组；details 不是状态证据。 */
function textOf(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
	if (content && typeof content === "object") return String(content.text ?? "");
	return "";
}

/**
 * 闸门判定 —— 纯函数，测试直接喂它。
 *
 * 返回 `null` 表示放行；返回 `{ block: true, reason }` 表示这次调用被拒。
 */
export function gateDecision(state, toolName) {
	const name = kind(toolName);
	if (!state || state.open) return null; // 没有项目可查、或已经放弃：放行
	if (ALLOWED.has(name) || name.startsWith("ask")) return null; // 出路与只读永远开着（`task` 不以 ask 开头，所以照样拦）
	if (!WORK.has(name)) return null; // 不认识的工具不拦：宁可漏，不锁死
	if (!state.checked) {
		return {
			block: true,
			reason:
				`ThinkRail gate: this session has not checked the project's spec graph yet, so \`${toolName}\` did not run. ` +
				"Next call: `spec_validate` — it is read-only and answers with `[thinkrail-state] specs=N`. " +
				"If N is 0, onboarding takes priority: load the `pi.thinkrail/setting-up-a-project` skill and follow it before changing the project. " +
				`Then retry \`${toolName}\`.`,
		};
	}
	if (state.specs === 0 && !state.onboarded) {
		return {
			block: true,
			reason:
				`ThinkRail gate: \`spec_validate\` reported 0 durable specs, so first-time project setup takes priority over \`${toolName}\`, whatever the request asks. ` +
				"Next: load the `pi.thinkrail/setting-up-a-project` skill (Skill tool) and follow it — it routes a code-only project to `importing-a-codebase` and an empty workspace with an idea to `starting-a-new-project`. " +
				`After the first spec graph exists, retry \`${toolName}\` and finish the original request.`,
		};
	}
	return null;
}

/** 本会话已知的项目状态写进规则尾部：下一轮提示自带结论，不必再靠模型回忆。 */
export function stateLine(state) {
	if (!state?.checked) return "";
	if (state.specs === 0) {
		if (state.onboarded) {
			return (
				"Recorded in this session: `spec_validate` reported 0 durable specs and onboarding has started → finish the first spec graph " +
				"(it is not a graph until a durable spec exists), then resume the original request."
			);
		}
		return (
			"Recorded in this session: `spec_validate` reported 0 durable specs → onboarding is required before this project is changed " +
			"(load `pi.thinkrail/setting-up-a-project`), then resume the original request."
		);
	}
	return `Recorded in this session: \`spec_validate\` reported ${state.specs} durable spec(s) → the graph exists; do not onboard.`;
}

/** 通道 2 的整块：规则 + 已知状态。 */
export function workflowBlock(state) {
	const line = stateLine(state);
	return `<${WORKFLOW_SECTION}>\n${WORKFLOW_RULE}${line ? `\n${line}` : ""}\n</${WORKFLOW_SECTION}>`;
}

/**
 * ExtensionAPI 工厂。宿主用 jiti 加载本文件，把默认导出当工厂调用。
 *
 * 三个钩子，各管一件事：
 *   * `before_agent_start` —— 投递规则（两条通道按宿主能力二选一，不叠加）；
 *   * `tool_call` —— 闸门：查过 spec 图之前、以及报 0 之后，拒掉「干活」的调用；
 *   * `tool_result` —— 取证：从 spec 工具的结果里读出 `specs=N`，并认下加载过的 onboarding 技能。
 */
export default function workflowRule(pi) {
	if (typeof pi?.on !== "function") return; // 宿主 API 换了形状：什么都不贡献，也不抛错

	const state = { checked: false, specs: null, onboarded: false, open: false, blocks: 0 };

	pi.on("before_agent_start", (event) => {
		// 通道 1（0.15.x–0.19.x，以及上游）：有命名 section 表就只写 section，不接管整条提示。
		const sections = event?.systemPromptOptions?.sections;
		if (sections && typeof sections === "object") {
			sections[WORKFLOW_SECTION] = stateLine(state)
				? `${WORKFLOW_RULE}\n${stateLine(state)}`
				: WORKFLOW_RULE;
			return {};
		}
		// 通道 2（0.20.x 起：sections 通道已不被读取）：追加到本轮提示尾部。
		const base = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
		if (!base) return {}; // 拿不到提示就什么都不做，绝不凭空造一条
		if (hasWorkflowBlock(base)) return {}; // 已经在里面了：不重复堆叠
		return { systemPrompt: `${base}\n${workflowBlock(state)}` };
	});

	pi.on("tool_call", (event) => {
		const decision = gateDecision(state, event?.toolName);
		if (!decision) return;
		state.blocks += 1;
		if (state.blocks > MAX_BLOCKS) {
			state.open = true; // 熔断：连续被拒到这个次数，说明这条路走不通，别再卡住会话
			return;
		}
		return decision;
	});

	pi.on("tool_result", (event) => {
		const name = kind(event?.toolName);
		if (name === "specvalidate") {
			if (event?.isError) {
				// 报错的结果不是证据（哪怕正文里恰好有状态行）：让路，但不记图。
				state.open = true;
				return;
			}
			// 唯一的证据来源。结果里没有 `[thinkrail-state] specs=N` 就等于没拿到证据：
			// 无工作区、工具没注册、参数被拒，或者宿主把插件的 `{error}` 当成成功结果
			// （PI-Desktop 0.22.0 实测：`{"error":"No workspace is open"}` → isError=false、ok:true）。
			// 这些都走同一条路：闸门永久让路——让一个取不到证的会话陪葬没有意义。
			const firstLine = textOf(event?.content).split(/\r?\n/, 1)[0];
			const match = /^\[thinkrail-state\] specs=(\d+)$/.exec(firstLine);
			if (match && Number.isSafeInteger(Number(match[1]))) {
				state.checked = true;
				state.specs = Number(match[1]);
				state.blocks = 0; // 拿到证据后重计；有意熔断策略不变。
				return;
			}
			state.open = true;
			return;
		}
		if (event?.isError) {
			// 有意 fail-open：其它 spec 工具自己都跑不动时，不能锁死会话。
			if (SPEC_TOOLS.has(name)) state.open = true;
			return;
		}
		if (name !== "skill") return;
		const id = event?.input?.id;
		if (ONBOARDING_SKILLS.some((skill) => id === `pi.thinkrail/${skill}`)) state.onboarded = true;
	});
}
