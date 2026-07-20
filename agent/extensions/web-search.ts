import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const SEARCH_SCRIPT = join(homedir(), ".pi", "agent", "bin", "search.js");

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using SearXNG. Returns title, URL, and snippet for each result.",
    promptSnippet: "Search the web for up-to-date information",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "The search query" }),
      count: Type.Optional(
        Type.Number({ default: 5, minimum: 1, maximum: 50 }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!existsSync(SEARCH_SCRIPT)) {
        return {
          content: [
            {
              type: "text",
              text: `Search script not found at ${SEARCH_SCRIPT}`,
            },
          ],
          details: {},
          isError: true,
        };
      }

      const count = Math.max(1, Math.min(50, params.count ?? 5));

      try {
        const stdout = execFileSync(
          SEARCH_SCRIPT,
          [params.query, "--count", String(count)],
          { encoding: "utf-8", timeout: 20_000, maxBuffer: 1024 * 1024 },
        );
        const text = stdout.trim();
        return {
          content: [{ type: "text", text: text || "No results found." }],
          details: { resultCount: text ? count : 0 },
        };
      } catch (err) {
        const msg =
          (err as any)?.stderr?.trim() ||
          (err as Error)?.message ||
          "Unknown error";
        return {
          content: [{ type: "text", text: `Search failed: ${msg}` }],
          details: {},
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      const preview =
        args.query.length > 60
          ? args.query.slice(0, 60) + "..."
          : args.query;
      return new Text(`🌐  ${theme.fg("accent", preview)}`);
    },

    renderResult(
      result: { content: Array<{ type: string; text?: string }> },
      { expanded }: { expanded: boolean },
      theme,
    ) {
      const text = result.content[0];
      const content = text?.type === "text" ? text.text ?? "" : "";

      if (!expanded) {
        const lines = content.split("\n").filter(Boolean);
        const head = lines.slice(0, 6).join("\n");
        const tail =
          lines.length > 6
            ? `\n${theme.fg("muted", `... ${lines.length - 6} more lines`)}`
            : "";
        return new Text(head + tail);
      }

      return new Text(content);
    },
  });
}
