import { Type } from "@earendil-works/pi-ai";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search";
const FETCH_ENDPOINT = "https://api.deepseek.com/v1/tools/fetch";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const SEARCH_TOTAL_LIMIT = 24_000;
const SEARCH_ITEM_LIMIT = 3_000;
const FETCH_TEXT_LIMIT = 20_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) { reject(signal.reason ?? new Error("Aborted")); return; }
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(signal.reason ?? new Error("Aborted"));
		}, { once: true });
	});
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncateMiddle(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const half = Math.floor(limit / 2);
	return `${text.slice(0, half)}\n\n...[truncated ${text.length - limit} chars]...\n\n${text.slice(-half)}`;
}

function maskKey(key: string): string {
	if (key.length <= 8) return "***";
	return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

function text(content: string): TextContent {
	return { type: "text", text: content };
}

interface SearchResultItem {
	title?: string;
	url?: string;
	snippet?: string;
	content?: string;
	date?: string;
	source?: string;
	[key: string]: unknown;
}

interface SearchResponse {
	results?: SearchResultItem[];
	query?: string;
	[key: string]: unknown;
}

interface FetchResponse {
	content?: string;
	markdown?: string;
	text?: string;
	title?: string;
	url?: string;
	error?: string;
	[key: string]: unknown;
}

async function callApi<T>(
	endpoint: string,
	apiKey: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<T> {
	let lastFail = "request failed";
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(RETRY_BASE_MS * 2 ** (attempt - 1), signal);
			if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		}
		let res: Response;
		try {
			res = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});
		} catch (err) {
			if (signal?.aborted) throw err;
			lastFail = errMessage(err);
			continue;
		}
		if (res.status === 408 || res.status === 429 || res.status >= 500) {
			lastFail = `HTTP ${res.status}`;
			continue;
		}
		if (res.status === 401) {
			throw new Error("认证失败（401）：当前 DeepSeek 密钥无效或已过期，请检查 Pi 中的 DeepSeek 配置。");
		}
		if (!res.ok) {
			let detail = "";
			try {
				const j = (await res.json()) as { error?: { message?: string } | string };
				detail = typeof j.error === "string" ? j.error : j.error?.message ?? "";
			} catch { /* ignore parse errors */ }
			throw new Error(`请求被拒绝（HTTP ${res.status}）${detail ? `：${detail}` : ""}`);
		}
		return (await res.json()) as T;
	}
	throw new Error(`${lastFail}（已重试 ${MAX_RETRIES} 次）`);
}

// ---------------------------------------------------------------------------
// Key resolution — reuses the DeepSeek credential already configured in Pi
// (the same key that powers your DeepSeek chat models), falling back to the
// DEEPSEEK_API_KEY environment variable.
// ---------------------------------------------------------------------------

type AnyCtx = ExtensionToolContext | ExtensionCommandContext;

// Local credential file written by the pi CLI (~/.pi/agent/auth.json).
// Used only as a last resort — e.g. in PI-Desktop, whose model registry
// does not expose provider keys. Read-only; the value is never logged.
function readStoredKey(): string | undefined {
	try {
		const p = path.join(os.homedir(), ".pi", "agent", "auth.json");
		const j = JSON.parse(fs.readFileSync(p, "utf8")) as { deepseek?: { key?: unknown } };
		const k = j?.deepseek?.key;
		return typeof k === "string" && k ? k : undefined;
	} catch {
		return undefined;
	}
}

async function resolveApiKey(ctx?: AnyCtx): Promise<{ key: string; source: string } | undefined> {
	// 1. Host model registry (full pi: the key behind your DeepSeek chat models)
	try {
		const registry = ctx?.modelRegistry;
		if (registry) {
			const model = registry.getAll().find((m) => m.provider === "deepseek");
			if (model) {
				const auth = await registry.getApiKeyAndHeaders(model);
				if (auth.ok && auth.apiKey) {
					return { key: auth.apiKey, source: `Pi 内置凭据（模型 ${model.id}）` };
				}
			}
		}
	} catch { /* registry lacks key access (e.g. PI-Desktop) — fall through */ }
	// 2. Environment variable (useful for headless/CI usage)
	if (process.env.DEEPSEEK_API_KEY) {
		return { key: process.env.DEEPSEEK_API_KEY, source: "环境变量 DEEPSEEK_API_KEY" };
	}
	// 3. pi CLI's local credential file
	const stored = readStoredKey();
	if (stored) {
		return { key: stored, source: "本地凭据文件 ~/.pi/agent/auth.json" };
	}
	return undefined;
}

const MISSING_KEY_MSG =
	"未找到可用的 DeepSeek API key。\n"
	+ "请满足其一：在 Pi 中配置 DeepSeek 模型 / 设置环境变量 DEEPSEEK_API_KEY / 已有 ~/.pi/agent/auth.json 中的 deepseek 凭据。\n"
	+ "获取地址: https://platform.deepseek.com/api_keys";


export default function deepseekWeb(pi: ExtensionAPI) {
	// --- Tool: web search ----------------------------------------------------
	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek 联网搜索",
		description:
			"Web search via DeepSeek's official Search API — fresh, sourced results with titles, URLs and snippets. "
			+ "Use for current events, recent releases, live prices, or any fact that may have changed after your training cutoff. "
			+ "Follow up with deepseek_fetch on a result URL to read the full article.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			count: Type.Optional(Type.Number({ description: "Number of results (default 5, max 10)" })),
			needContent: Type.Optional(Type.Boolean({ description: "Include full page content for each result (slower, higher cost)" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params: { query: string; count?: number; needContent?: boolean }, signal, _onUpdate, ctx) {
			try {
				const cred = await resolveApiKey(ctx);
				if (!cred) throw new Error(MISSING_KEY_MSG);
				const count = Math.min(Math.max(params.count ?? 5, 1), 10);
				const resp = await callApi<SearchResponse>(SEARCH_ENDPOINT, cred.key, {
					query: params.query,
					count,
					need_content: params.needContent ?? false,
				}, signal);
				const results = resp.results ?? [];
				if (results.length === 0) {
					return { content: [text(`搜索「${params.query}」没有返回结果。`)], details: { results: [], query: params.query } };
				}
				let budget = SEARCH_TOTAL_LIMIT;
				const out = results.map((item, i) => {
					const title = item.title ?? "(无标题)";
					const url = item.url ?? "";
					const snippet = (item.snippet ?? item.content ?? "").trim();
					let line = `${i + 1}. ${title}\n   ${url}`;
					if (snippet) {
						line += `\n   ${truncateMiddle(snippet, Math.min(SEARCH_ITEM_LIMIT, budget))}`;
					}
					budget -= line.length;
					return { line, title, url, snippet: snippet.slice(0, 500) };
				});
				return {
					content: [text(out.map(o => o.line).join("\n\n"))],
					details: { results: out.map(({ title, url, snippet }) => ({ title, url, snippet })), query: params.query },
				};
			} catch (err) {
				return { content: [text(`⚠️ deepseek_search 出错: ${errMessage(err)}`)], isError: true };
			}
		},
	});

	// --- Tool: fetch page content --------------------------------------------
	pi.registerTool({
		name: "deepseek_fetch",
		label: "DeepSeek 抓取网页",
		description:
			"Extract readable text from a URL via DeepSeek's official Fetch API — cleaner than naive scraping, handles JS-heavy pages. "
			+ "Use after deepseek_search to read a full article, or when handed a specific URL to read. "
			+ "Output is plain/markdown-style text ready for summarization or fact-checking.",
		parameters: Type.Object({
			url: Type.String({ description: "The URL to fetch (http or https)" }),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(_id, params: { url: string }, signal, _onUpdate, ctx) {
			try {
				const cred = await resolveApiKey(ctx);
				if (!cred) throw new Error(MISSING_KEY_MSG);
				if (!/^https?:\/\//i.test(params.url)) {
					return { content: [text(`⚠️ 无效的 URL（仅支持 http/https）: ${params.url}`)], isError: true };
				}
				const resp = await callApi<FetchResponse>(FETCH_ENDPOINT, cred.key, { url: params.url }, signal);
				const raw = (resp.content ?? resp.markdown ?? resp.text ?? "").trim();
				const parts: string[] = [];
				if (resp.title) parts.push(`📄 ${resp.title}`);
				parts.push(truncateMiddle(raw, FETCH_TEXT_LIMIT) || "(页面内容为空)");
				return {
					content: [text(parts.join("\n\n"))],
					details: { url: params.url, title: resp.title, charCount: raw.length },
				};
			} catch (err) {
				return { content: [text(`⚠️ deepseek_fetch 出错: ${errMessage(err)}`)], isError: true };
			}
		},
	});

	// --- Command: /search <query> ---------------------------------------------
	pi.registerCommand("/search", {
		description: "使用 DeepSeek Search API 联网搜索并展示结果",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("用法: /search <查询内容>", "info");
				return;
			}
			try {
				const cred = await resolveApiKey(ctx);
				if (!cred) { ctx.ui.notify(MISSING_KEY_MSG, "error"); return; }
				const resp = await callApi<SearchResponse>(SEARCH_ENDPOINT, cred.key, { query, count: 5, need_content: false });
				const results = resp.results ?? [];
				if (results.length === 0) {
					ctx.ui.notify(`搜索「${query}」没有返回结果。`, "info");
					return;
				}
				const lines = [
					`🔍 ${query}（${results.length} 条结果 · DeepSeek Search）`,
					"",
					...results.flatMap((r, i) => [
						`${i + 1}. ${r.title ?? "(无标题)"}`,
						`   ${r.url ?? ""}`,
						...(() => {
							const snip = (r.snippet ?? r.content ?? "").trim().replace(/\n+/g, " ");
							return snip ? [`   ${snip.slice(0, 160)}`] : [];
						})(),
						"",
					]),
				];
				ctx.ui.notify(lines.join("\n").slice(0, 4000), "info");
			} catch (err) {
				ctx.ui.notify(`搜索出错: ${errMessage(err)}`, "error");
			}
		},
	});

	// --- Command: /deepseek-key -----------------------------------------------
	pi.registerCommand("/deepseek-key", {
		description: "显示当前生效的 DeepSeek API key 来源（脱敏）",
		handler: async (_args, ctx) => {
			const cred = await resolveApiKey(ctx);
			if (!cred) {
				ctx.ui.notify(MISSING_KEY_MSG, "error");
				return;
			}
			ctx.ui.notify(`✅ DeepSeek API key 就绪\n来源: ${cred.source}\n密钥: ${maskKey(cred.key)}`, "info");
		},
	});
}
