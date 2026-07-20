/**
 * Subagent — delegates tasks to specialized agents in isolated pi processes.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Agent definitions live in ~/.pi/agent/agents/*.md or .pi/agents/*.md.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";

// ─── constants ──────────────────────────────────────────────────────

const MAX_PARALLEL_TASKS = 16;
const MAX_CONCURRENCY = 6;
const PER_TASK_TRUNCATE = 80 * 1024; // 80 KB per-task output cap

// ─── formatting helpers ─────────────────────────────────────────────

function fmt(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

function usageLine(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns > 1 ? "s" : ""}`);
	if (u.input || u.output) parts.push(`↑${fmt(u.input)} ↓${fmt(u.output)}`);
	if (u.cacheRead) parts.push(`R${fmt(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${fmt(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" · ");
}

interface Usage {
	input: number; output: number; cacheRead: number;
	cacheWrite: number; cost: number; turns: number;
}

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: { role: string; content: string }[];
	stderr: string;
	usage: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	results: SingleResult[];
}

// ─── helpers ────────────────────────────────────────────────────────

function findPi() {
	const script = process.argv[1];
	const isBunVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !isBunVirtual && fs.existsSync(script)) {
		// Only use the current script if it's actually the pi CLI
		// (e.g., dist/cli.js, cli.js, pi, pi.js). Avoid picking up
		// custom wrappers like server.js that start a WebSocket server.
		const base = path.basename(script);
		const isPiCli = base === "cli.js" || base === "pi" || base === "pi.js" ||
			script.includes("pi-coding-agent") ||
			script.includes(path.join("dist", "cli.js"));
		if (isPiCli) {
			return { command: process.execPath, args: [script] };
		}
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}
	return { command: "pi", args: [] };
}

function getFinalText(messages: { role: string; content: string }[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i].content;
	}
	return "";
}

function isFailed(r: SingleResult): boolean {
	return r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
}

function truncate(s: string, maxBytes = PER_TASK_TRUNCATE): string {
	if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
	let t = s.slice(0, maxBytes);
	while (Buffer.byteLength(t, "utf8") > maxBytes) t = t.slice(0, -1);
	return t + `\n\n[Output truncated: ${Buffer.byteLength(s, "utf8") - Buffer.byteLength(t, "utf8")} bytes omitted.]`;
}

// ─── concurrency-limited map ────────────────────────────────────────

async function concurrentMap<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) return [];
	const n = Math.max(1, Math.min(limit, items.length));
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (true) {
				const i = next++;
				if (i >= items.length) return;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

// ─── run a single subagent ──────────────────────────────────────────

async function runSingleAgent(
	cwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	modelOverride: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: ((text: string) => void) | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		const names = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName, task, exitCode: 1, messages: [], stderr: `Unknown agent "${agentName}". Available: ${names}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }, step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const model = modelOverride || agent.model;
	if (model) args.push("--model", model);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	let tmpDir: string | null = null;
	let tmpPath: string | null = null;

	if (agent.systemPrompt.trim()) {
		tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
		tmpPath = path.join(tmpDir, "prompt.md");
		await fs.promises.writeFile(tmpPath, agent.systemPrompt.trim(), "utf-8");
		args.push("--append-system-prompt", tmpPath);
	}
	args.push(`Task: ${task}`);

	const result: SingleResult = {
		agent: agentName, task, exitCode: 0, messages: [], stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		model, step,
	};

	const emit = () => { if (onUpdate) onUpdate(getFinalText(result.messages) || "(running...)") };

	try {
		result.exitCode = await new Promise<number>((resolve) => {
			const pi = findPi();
			const proc = spawn(pi.command, [...pi.args, ...args], {
				cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
			});
			let buf = "";

			const consume = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try { ev = JSON.parse(line); } catch { return; }

				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					const msg = ev.message;
					const texts = (msg.content || [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n");
					if (texts) result.messages.push({ role: "assistant", content: texts });

					result.usage.turns++;
					const u = msg.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += u.cost?.total || 0;
					}
					if (msg.stopReason) result.stopReason = msg.stopReason;
					if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					emit();
				}
			};

			proc.stdout.on("data", (data: Buffer) => {
				buf += data.toString();
				const lines = buf.split("\n");
				buf = lines.pop() || "";
				for (const line of lines) consume(line);
			});
			proc.stderr.on("data", (data: Buffer) => { result.stderr += data.toString() });

			proc.on("close", (code) => {
				if (buf.trim()) consume(buf);
				resolve(code ?? 0);
			});
			proc.on("error", () => resolve(1));

			if (signal) {
				const kill = () => {
					proc.kill("SIGTERM");
					setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL") }, 5000);
				};
				if (signal.aborted) kill();
				else signal.addEventListener("abort", kill, { once: true });
			}
		});
		return result;
	} finally {
		if (tmpPath) try { fs.unlinkSync(tmpPath) } catch {}
		if (tmpDir) try { fs.rmdirSync(tmpDir) } catch {}
	}
}

type OnToolUpdate = (partial: AgentToolResult<SubagentDetails>) => void;

// ─── extension registration ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents in isolated pi processes.",
			"Agents are defined in ~/.pi/agent/agents/*.md with YAML frontmatter",
			"(name, description, tools, model) and a system prompt body.",
			"Project-local agents in .pi/agents/*.md override user agents.",
			"",
			"Modes:",
			"  • Single —  { agent: \"name\", task: \"...\" }",
			"  • Parallel — { tasks: [{ agent, task }, ...] }  — runs up to 6 in parallel",
			"  • Chain —    { chain: [{ agent, task }, ...] }   — sequential, {previous} for prior output",
		].join(" "),
		promptSnippet: "Delegate a task to a specialized agent (isolated context, custom model/tools)",
		promptGuidelines: [
			"Use subagent for tasks that benefit from isolated context: web searches, code review, exploration, documentation generation.",
			"The subagent runs in a separate pi process with its own model, tools, and system prompt — it won't see your conversation history.",
			"Use agent=\"web-search\" with task=<query> for web searches. This uses a cheap model and saves context.",
			"Available agents are listed when you call subagent with an unknown name.",
			"For parallel tasks, pass a `tasks` array. You can also chain agents with `chain` and use {previous} to feed prior output into the next step.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Agent to invoke (single mode)" })),
			task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
			tasks: Type.Optional(Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent name" }),
					task: Type.String({ description: "Task for this agent" }),
					model: Type.Optional(Type.String({ description: "Override agent model" })),
				}),
				{ description: "Array of {agent, task} for parallel execution" },
			)),
			chain: Type.Optional(Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent name" }),
					task: Type.String({ description: "Task with optional {previous} placeholder" }),
					model: Type.Optional(Type.String({ description: "Override agent model" })),
				}),
				{ description: "Array of {agent, task} for sequential execution" },
			)),
			model: Type.Optional(Type.String({
				description: "Override the agent's default model (single mode only)",
			})),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agents = discoverAgents(ctx.cwd);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				const names = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Provide exactly one mode (agent+task, tasks[], or chain[]).\nAvailable agents: ${names}` }],
					details: { mode: "single" as const, results: [] },
				};
			}

			const makeDetails = (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): SubagentDetails => ({ mode, results });

			// ── Chain mode ──────────────────────────────────────────
			if (hasChain) {
				const steps = params.chain!;
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < steps.length; i++) {
					const step = steps[i];
					const task = step.task.replace(/\{previous\}/g, previousOutput);

					const chainUpdate = onUpdate
						? (text: string) => {
							const r: SingleResult = {
								agent: step.agent, task, exitCode: -1, messages: [{ role: "assistant", content: text }],
								stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
								step: i + 1,
							};
							onUpdate({ content: [{ type: "text", text }], details: makeDetails("chain")([...results, r]) });
						}
						: undefined;

					const r = await runSingleAgent(ctx.cwd, agents, step.agent, task, step.model, i + 1, signal, chainUpdate);
					results.push(r);

					if (isFailed(r)) {
						const msg = getFinalText(r.messages) || r.stderr || r.errorMessage || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${msg}` }],
							details: makeDetails("chain")(results), isError: true,
						};
					}
					previousOutput = getFinalText(r.messages);
				}
				return {
					content: [{ type: "text", text: getFinalText(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			// ── Parallel mode ───────────────────────────────────────
			if (hasTasks) {
				const tasks = params.tasks!;
				if (tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: makeDetails("parallel")([]),
					};
				}

				const allResults: SingleResult[] = tasks.map((t, i) => ({
					agent: t.agent, task: t.task, exitCode: -1, messages: [], stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					step: i + 1,
				}));

				const emitParallel = () => {
					if (!onUpdate) return;
					const done = allResults.filter((r) => r.exitCode !== -1).length;
					const running = allResults.length - done;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await concurrentMap(tasks, MAX_CONCURRENCY, async (t, idx) => {
					const r = await runSingleAgent(ctx.cwd, agents, t.agent, t.task, t.model, idx + 1, signal, (text) => {
						allResults[idx] = { ...allResults[idx], messages: [{ role: "assistant", content: text }] };
						emitParallel();
					});
					allResults[idx] = r;
					emitParallel();
					return r;
				});

				const ok = results.filter((r) => !isFailed(r)).length;
				const summaries = results.map((r) => {
					const out = truncate(getFinalText(r.messages) || r.stderr || "(no output)");
					const status = isFailed(r) ? `failed${r.stopReason ? ` (${r.stopReason})` : ""}` : "completed";
					return `### [${r.agent}] ${status}\n\n${out}`;
				});
				return {
					content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}` }],
					details: makeDetails("parallel")(results),
				};
			}

			// ── Single mode ─────────────────────────────────────────
			if (params.agent && params.task) {
				let lastStream = "(starting...)";
				const result = await runSingleAgent(
					ctx.cwd, agents, params.agent, params.task, params.model, undefined, signal,
					(text) => { lastStream = text },
				);

				if (isFailed(result)) {
					const msg = result.errorMessage || result.stderr || getFinalText(result.messages) || "(no output)";
					return {
						content: [{ type: "text", text: `Agent "${result.agent}" ${result.stopReason || "failed"}: ${msg}` }],
						details: { mode: "single" as const, results: [result] }, isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getFinalText(result.messages) || lastStream || "(no output)" }],
					details: { mode: "single" as const, results: [result] },
				};
			}

			const names = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${names}` }],
				details: { mode: "single" as const, results: [] },
			};
		},

		renderCall(args, theme) {
			if (args.chain?.length) {
				const steps = args.chain.map((s: any) => s.agent).join(" → ");
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("dim", `  ${steps}`),
				);
			}
			if (args.tasks?.length) {
				const agents = args.tasks.map((t: any) => t.agent).join(", ");
				return new Text(
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length})`) +
					theme.fg("dim", `  ${agents}`),
				);
			}
			const preview = (args.task ?? "").length > 70 ? args.task.slice(0, 70) + "..." : (args.task ?? "");
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", args.agent ?? "?") +
				theme.fg("dim", `  ${preview}`),
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";

			// Fallback for results without structured details
			if (!details || details.results.length === 0) {
				return new Text(text || "(no output)");
			}

			// Single mode
			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const failed = isFailed(r);
				const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const body = getFinalText(r.messages) || text;

				if (!expanded) {
					const head = body.split("\n").slice(0, 5).join("\n");
					const more = body.split("\n").length > 5;
					let out = `${icon} ${theme.fg("toolTitle", "subagent")} · ${theme.fg("accent", r.agent)}`;
					if (r.usage.turns) out += " · " + theme.fg("dim", usageLine(r.usage, r.model));
					out += "\n" + head;
					if (more) out += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
					return new Text(out);
				}

				let out = `${icon} ${theme.fg("toolTitle", "subagent")} · ${theme.fg("accent", r.agent)}`;
				if (r.usage.turns) out += "\n" + theme.fg("dim", usageLine(r.usage, r.model));
				if (failed && r.stopReason) out += `\n${theme.fg("error", `[${r.stopReason}]`)}`;
				out += "\n\n" + body;
				return new Text(out);
			}

			// Chain mode
			if (details.mode === "chain") {
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const total = details.results.length;
				const icon = ok === total ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (!expanded) {
					let out = `${icon} ${theme.fg("toolTitle", "chain")} · ${ok}/${total} steps`;
					for (const r of details.results) {
						const ri = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const head = getFinalText(r.messages).split("\n").slice(0, 3).join("\n") || "(no output)";
						out += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}\n${head}`;
					}
					out += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					return new Text(out);
				}

				let out = `${icon} ${theme.fg("toolTitle", "chain")} · ${ok}/${total} steps`;
				for (const r of details.results) {
					const ri = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					out += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${ri}`;
					if (r.usage.turns) out += `\n${theme.fg("dim", usageLine(r.usage, r.model))}`;
					if (isFailed(r) && r.stopReason) out += `\n${theme.fg("error", `[${r.stopReason}]`)}`;
					out += "\n\n" + getFinalText(r.messages);
				}
				const totalUsage = details.results.reduce(
					(a, r) => ({ ...a, input: a.input + r.usage.input, output: a.output + r.usage.output, cacheRead: a.cacheRead + r.usage.cacheRead, cacheWrite: a.cacheWrite + r.usage.cacheWrite, cost: a.cost + r.usage.cost, turns: a.turns + r.usage.turns }),
					{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				);
				if (totalUsage.turns) out += `\n\n${theme.fg("dim", `Total: ${usageLine(totalUsage)}`)}`;
				return new Text(out);
			}

			// Parallel mode
			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const ok = details.results.filter((r) => r.exitCode !== -1 && !isFailed(r)).length;
				const fail = details.results.filter((r) => r.exitCode !== -1 && isFailed(r)).length;
				const total = details.results.length;

				const icon = running > 0
					? theme.fg("warning", "⏳")
					: fail > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
				const status = running > 0
					? `${ok + fail}/${total} done, ${running} running`
					: `${ok}/${total} tasks`;

				if (!expanded || running > 0) {
					let out = `${icon} ${theme.fg("toolTitle", "parallel")} · ${status}`;
					for (const r of details.results) {
						const ri = r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const head = getFinalText(r.messages).split("\n").slice(0, 3).join("\n") || (r.exitCode === -1 ? "(running...)" : "(no output)");
						out += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}\n${head}`;
					}
					if (running === 0) out += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					return new Text(out);
				}

				let out = `${icon} ${theme.fg("toolTitle", "parallel")} · ${status}`;
				for (const r of details.results) {
					const ri = isFailed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					out += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${ri}`;
					if (r.usage.turns) out += `\n${theme.fg("dim", usageLine(r.usage, r.model))}`;
					out += "\n\n" + getFinalText(r.messages);
				}
				const totalUsage = details.results.reduce(
					(a, r) => ({ ...a, input: a.input + r.usage.input, output: a.output + r.usage.output, cacheRead: a.cacheRead + r.usage.cacheRead, cacheWrite: a.cacheWrite + r.usage.cacheWrite, cost: a.cost + r.usage.cost, turns: a.turns + r.usage.turns }),
					{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				);
				if (totalUsage.turns) out += `\n\n${theme.fg("dim", `Total: ${usageLine(totalUsage)}`)}`;
				return new Text(out);
			}

			return new Text(text || "(no output)");
		},
	});
}
