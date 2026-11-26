// 面板后端 —— 面板（renderer/index.html）唯一的数据入口。
//
// 宿主的面板是一个**隔离的**页面：它只有 `window.pluginBridge.invoke(channel, payload)` 和
// `pluginBridge.on(event, cb)`，自定义 channel 会被转给插件进程的 `onPanelInvoke(channel,
// payload)`。所以这里就是 DSH 版那条 HTTP API 的对应物，只是换了个传输方式，一个 channel
// 一节，名字与载荷尽量沿用原来的 route：
//
//   "state"   <- GET /state      整个面板的初始载荷
//   "grep"    <- GET /grep       内容检索
//   "spec"    <- GET /spec       一个 spec 的正文与链接（原版把「打开」交给宿主文件页签，
//                                PI-Desktop 没有对应物，所以正文就在面板里读）
//
// 与 DSH 版的两处删除，都是有意的：
//   * `/slice`（子图切片）：原版服务端有、客户端从不调用。PI-Desktop 的面板是这条 API 唯一
//     的消费者，没人调的 channel 就是死代码。（能力本身没丢：`spec_graph` 工具提供它。）
//   * `/config`（设置读写）：设置改由宿主持有并渲染，插件不再自带设置页，面板也就不需要它。
//
// 错误一律折叠成 `{ ok: false, error }` 返回，不抛：面板只关心「这次操作成不成」，
// 抛出只会让 bridge 那一层再包一次。

const { host } = require("./host.js");
const { createFio } = require("./fio.js");
const { lastPanel, panelProject } = require("./project.js");
const {
	FIELDS,
	LINK_KINDS,
	SpecIndex,
	grepSpecs,
	resolveSpecPath,
	isValid,
	linkTargets,
	parseFile,
	scalar,
	validateGraph,
} = require("./spec/index.js");

/** 面板一次最多画这么多节点；超出只报数量。 */
const MAX_NODES = 2000;

/**
 * 索引快照的新鲜度窗口（毫秒）。
 *
 * 一次完整枚举在 11k 目录的仓库上要一两秒（宿主 glob 一次就要走完整棵树），所以面板**永远
 * 不等它**：`state` 立刻返回手里的快照，同时在后台开始刷新；快照过期就带上 `indexing`，
 * 视图轮询到新结果自己重画（stale-while-revalidate）。工具侧不参与这套：agent 可能用通用
 * write/edit 工具改文件，插件无从感知，所以它的读必须每次重走树。
 */
const PANEL_CACHE_MS = 3000;

// A SpecIndex root is only a cache identity: pi.fs resolves the window root per call.
const indexes = new Map();
let activeRoot = null;
let workspaceEpoch = 0;

function entryFor(root) {
  let entry = indexes.get(root);
  if (!entry) {
    entry = { root, index: null, snapshot: null, version: 0, indexedAt: 0,
      attemptedAt: null, completedAt: null, error: null, inFlight: null };
    indexes.set(root, entry);
  }
  return entry;
}

function statusOf(entry) {
  return { projectId: entry?.root ?? null, version: entry?.version ?? 0,
    indexedAt: entry?.indexedAt ?? 0, indexing: Boolean(entry?.inFlight),
    specError: entry?.error ?? null, stale: Boolean(entry?.snapshot &&
      (entry.error || entry.inFlight || Date.now() - entry.indexedAt >= PANEL_CACHE_MS)) };
}

/** One cheap workspace lookup; a due tree scan starts without blocking this reply.
 * The command layer must await this function when answering hint. */
async function indexStatus(pi = host()) {
  try {
    const current = await project(pi);
    if (!current) return { project: null, ...statusOf(null), specError: noProjectText() };
    const entry = entryFor(current.path);
    refreshInBackground(entry, pi);
    return { project: current, ...statusOf(entry) };
  } catch (error) {
    return { ok: false, error: errorOf(error) };
  }
}

function guardedFio(pi, root, guard) {
  const fio = createFio(pi);
  const check = async () => {
    let current;
    try { current = await project(pi); }
    catch (error) { guard.invalid = true; throw error; }
    if (guard.invalid || current?.path !== root || guard.epoch !== workspaceEpoch) {
      guard.invalid = true;
      const entry = indexes.get(root);
      if (entry) entry.index = null;
      throw new Error(`Workspace changed while reading ${root}; retry in the active project.`);
    }
    if (guard.failure) throw guard.failure;
  };
  const wrapped = {};
  for (const name of Object.keys(fio)) {
    wrapped[name] = async (...args) => {
      await check();
      try { return await fio[name](...args); }
      catch (error) {
        // glob has an explicit list fallback; other failures must not look like an empty tree.
        if (name !== "glob") guard.failure = error;
        throw error;
      } finally { await check(); }
    };
  }
  return { fio: wrapped, check };
}

/** All readers for one project share one scan, including explicit refreshes.
 * Failures use the same cache window as successes to avoid a retry storm. */
function refreshInBackground(entry, pi, fresh = false) {
  if (entry.inFlight) return entry.inFlight;
  if (!fresh && entry.completedAt !== null && Date.now() - entry.completedAt < PANEL_CACHE_MS) return null;
  entry.attemptedAt = Date.now();
  const guard = { epoch: workspaceEpoch, invalid: false };
  const io = guardedFio(pi, entry.root, guard);
  if (!entry.index) entry.index = new SpecIndex(entry.root, io.fio);
  // Rebind the guard on each scan; never reuse a poisoned index.
  const index = entry.index;
  index.fio = io.fio;
  const run = Promise.resolve().then(async () => {
    try {
      await io.check();
      const graph = await index.graph({ fresh: true });
      await io.check(); // SpecIndex may catch individual I/O errors internally.
      entry.snapshot = summarizeGraph(graph, index);
      entry.indexedAt = Date.now();
      entry.error = null;
    } catch (error) {
      entry.error = errorOf(error);
      // A failed scan can already have mutated the parse cache. Discard it whole.
      entry.index = null;
    } finally {
      entry.version += 1;
      entry.completedAt = Date.now();
      entry.inFlight = null;
    }
  });
  entry.inFlight = run;
  return run;
}

function errorOf(error) {
	return error?.message ?? String(error);
}

/**
 * 面板当前能工作的项目。
 *
 * 面板没有会话 id，所以只能讲「宿主此刻激活的项目」。它为空时（用户在别的会话里，或那个会话
 * 本身没有项目）返回 null——**不能**退回「上次那个项目」去读文件：宿主此刻没有工作区根，
 * 任何 `pi.fs.*` 都会被拒。上次那个项目只用来把话说清楚（见 `noProjectText`）。
 */
async function project(pi) {
	const current = await panelProject(pi);
	const nextRoot = current && !current.stale ? current.path : null;
	if (nextRoot !== activeRoot) {
		activeRoot = nextRoot;
		workspaceEpoch += 1;
	}
	if (nextRoot === null) return null;
	return { path: current.path, name: current.name };
}

/** 面板这一侧统一的「没有激活项目」说法：能指名就指名。 */
function noProjectText() {
	const last = lastPanel();
	return last
		? `No project is open in PI-Desktop. ThinkRail last showed "${last.name}" (${last.path}); activate it (sidebar or Mod+K) and retry.`
		: "No project is open in PI-Desktop. Activate a project (sidebar or Mod+K) and retry.";
}

/**
 * 面板要的那份图摘要。
 *
 * `truncated` 有两个来源：分片枚举触到刹车（`index.truncated`，即索引真的不全），或者节点数
 * 超过面板一次能画的量。前一种必须显示出来——一个「看起来完整」的不完整索引比没有索引更坏。
 */
function summarizeGraph(graph, index) {
	const report = validateGraph(graph);
	const nodes = [...graph.nodes.values()].map((node) => ({
		id: node.id,
		type: node.type,
		title: node.title ?? null,
		path: node.path,
		status: scalar(node.frontmatter, FIELDS.status) ?? null,
		parent: scalar(node.frontmatter, FIELDS.parent) ?? null,
		// 正向链接随 state 一起送出去，面板据此自己反过来算「谁指向我」。
		// 这样点开一个 spec 就完全不需要重新扫全树（见 specDetail 的说明）。
		links: LINK_KINDS.flatMap((kind) =>
			linkTargets(node.frontmatter, kind).map((target) => ({ kind, target })),
		),
	}));
	nodes.sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
	return {
		count: nodes.length,
		truncated: nodes.length > MAX_NODES || index?.truncated === true,
		edges: graph.edges.length,
		nodes: nodes.slice(0, MAX_NODES),
		issues: {
			dangling: report.danglingLinks.length,
			duplicates: report.duplicateIds.length,
			cycles: report.parentCycles.length,
			valid: index?.truncated !== true && isValid(report),
		},
	};
}

/**
 * 一个 spec 的正文与 frontmatter —— **只读这一个文件**。
 *
 * 这里刻意不碰索引：以前为了拿链接关系会调 `index.graph()`，而图一旦过期就触发一次全树枚举
 * （一次 glob 就要走完整棵树，顶到它的 500 条上限还会转成并发 list）。结果是「点开一个 spec」这件事的代价取决于你上次扫树
 * 是多久之前——人看得越久，下一次点越慢，这正好是最难受的一种卡。
 *
 * 现在：路径校验（逐段 list，顺带挡住越界与大小写歧义）+ 一次 readText，共 3 次宿主调用，
 * 与仓库有多大无关。链接关系由面板用 state 里已经带下来的正向链接自己反推。
 */
async function specDetail(pi, root, file) {
	if (typeof file !== "string" || file.trim() === "") {
		return { ok: false, error: "`file` is required." };
	}
	const guard = { epoch: workspaceEpoch, invalid: false };
	const io = guardedFio(pi, root, guard);
	const fio = io.fio;
	const resolved = await resolveSpecPath(fio, file);
	if ("error" in resolved) return { ok: false, error: resolved.error };

	let content;
	try {
		content = await fio.readText(resolved.rel);
	} catch (error) {
		return { ok: false, error: `Failed to read ${resolved.rel}: ${errorOf(error)}` };
	}
	await io.check();
	const { frontmatter, body } = parseFile(content);
	return { ok: true, projectId: root, file: resolved.rel, body, frontmatter };
}

async function loadState(pi, payload) {
	const current = await project(pi);
	if (!current) return { ok: true, project: null, specRoot: null, specs: null,
		...statusOf(null), specError: noProjectText() };
	const entry = entryFor(current.path);
	const pending = refreshInBackground(entry, pi, payload?.fresh === true);
	if (payload?.fresh === true && pending) await pending;
	const latest = await project(pi);
	if (latest?.path !== current.path) throw new Error("Workspace changed; retry in the active project.");
	return { ok: true, project: current, specRoot: current.path,
		specs: entry.snapshot, ...statusOf(entry) };
}

async function search(pi, payload) {
	const current = await project(pi);
	if (!current) return { ok: false, error: noProjectText() };
	const args = payload ?? {};
	let result;
	try {
		const entry = entryFor(current.path);
		const pending = refreshInBackground(entry, pi, payload?.fresh === true);
		if (pending) await pending;
		if (entry.error) throw new Error(entry.error);
		const latest = await project(pi);
		if (latest?.path !== current.path || !entry.index) throw new Error("Workspace changed; retry the search.");
		const cacheOptions = { maxAgeMs: Infinity };
		result = grepSpecs(await entry.index.contentEntries(cacheOptions), {
			pattern: String(args.pattern ?? ""),
			...(args.regex !== undefined ? { regex: Boolean(args.regex) } : {}),
			...(args.ignoreCase !== undefined ? { ignoreCase: Boolean(args.ignoreCase) } : {}),
			...(args.type !== undefined ? { type: String(args.type) } : {}),
			...(args.tag !== undefined ? { tag: String(args.tag) } : {}),
			...(args.parent !== undefined ? { parent: String(args.parent) } : {}),
			...(args.dependsOn !== undefined ? { dependsOn: String(args.dependsOn) } : {}),
			...(args.limit !== undefined ? { limit: Number(args.limit) } : {}),
		});
	} catch (error) {
		return { ok: false, projectId: current.path, error: errorOf(error) };
	}
	return { ok: true, projectId: current.path, ...result };
}

/** `onPanelInvoke` 的实现：一个 channel 一节。 */
async function onPanelInvoke(channel, payload) {
	const pi = host();
	try {
		switch (channel) {
			case "state":
				return await loadState(pi, payload);
			case "grep":
				return await search(pi, payload);
			case "spec": {
				const current = await project(pi);
				if (!current) return { ok: false, error: noProjectText() };
				return await specDetail(pi, current.path, payload?.file);
			}
			default:
				return { ok: false, error: `Unsupported panel channel: ${channel}` };
		}
	} catch (error) {
		return { ok: false, error: errorOf(error) };
	}
}

module.exports = {
	MAX_NODES,
	indexStatus,
	loadState,
	onPanelInvoke,
	search,
	specDetail,
	summarizeGraph,
};
