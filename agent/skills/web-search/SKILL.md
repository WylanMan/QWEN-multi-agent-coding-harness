---
name: web-search
description: Web search via local SearXNG instance. Use when you need current information from the internet.
---

# Web Search

SearXNG runs as a Docker container (`pi-searxng`) on localhost:8888.

## Quick search

```bash
~/.pi/agent/bin/search.js "your query here"
```

Returns 5 results by default. Each result has: title, URL, content snippet.

## Options

```bash
~/.pi/agent/bin/search.js "query"             # 5 results (default)
~/.pi/agent/bin/search.js "query" --count 10  # 10 results
~/.pi/agent/bin/search.js "query" --json      # Raw JSON from SearXNG
```

## Subagent

For isolated web searches that don't bloat your conversation context, use the subagent:

```
subagent({ agent: "web-search", task: "find the latest docs on topic X" })
```

This spawns a separate pi process with a cheap model, performs the search, and returns structured results. The search traces stay in the subagent's context, not yours.

## Notes

- SearXNG aggregates results from DuckDuckGo, Google CSE, Brave, and others
- Rate limiter is disabled (local use only)
- Timeout: 15 seconds per search
