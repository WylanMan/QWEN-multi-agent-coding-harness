/**
 * Minimal agent discovery — reads .md files from ~/.pi/agent/agents/
 * and optionally .pi/agents/ (project-local overrides).
 *
 * Each file is standard YAML frontmatter + body:
 *   ---
 *   name: web-search
 *   description: Searches the web...
 *   tools: bash
 *   model: deepseek-v4-flash
 *   ---
 *   System prompt body...
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	filePath: string;
}

function loadDir(dir: string): AgentConfig[] {
	const agents: AgentConfig[] = [];
	if (!fs.existsSync(dir)) return agents;

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name || !frontmatter.description) continue;

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model || undefined,
			systemPrompt: body,
			filePath,
		});
	}
	return agents;
}

/** Walk up from cwd looking for .pi/agents/ */
function findProjectAgentsDir(cwd: string): string | null {
	let cur = cwd;
	while (true) {
		const candidate = path.join(cur, CONFIG_DIR_NAME, "agents");
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
		const parent = path.dirname(cur);
		if (parent === cur) return null;
		cur = parent;
	}
}

/**
 * Discover agents: project-local override user-level.
 * Project agents with the same name replace user agents.
 */
export function discoverAgents(cwd: string): AgentConfig[] {
	const userDir = path.join(getAgentDir(), "agents");
	const projectDir = findProjectAgentsDir(cwd);

	const map = new Map<string, AgentConfig>();
	for (const a of loadDir(userDir)) map.set(a.name, a);
	if (projectDir) {
		for (const a of loadDir(projectDir)) map.set(a.name, a);
	}
	return Array.from(map.values());
}
