#!/usr/bin/env node
// search.js — SearXNG CLI wrapper
// Usage: search.js <query> [--count N]

const query = process.argv[2];
const countIdx = process.argv.indexOf("--count");
const count = countIdx !== -1 ? parseInt(process.argv[countIdx + 1]) || 5 : 5;

if (!query) {
  console.error("Usage: search.js <query> [--count <n>]");
  process.exit(1);
}

const base = process.env.SEARXNG_INSTANCE_URL || "http://localhost:8888";

try {
  const res = await fetch(
    `${base}/search?format=json&q=${encodeURIComponent(query)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) {
    console.error(`Search failed: HTTP ${res.status}`);
    process.exit(1);
  }

  const data = await res.json();
  const results = data.results.slice(0, count);

  if (results.length === 0) {
    console.log("No results found.");
    process.exit(0);
  }

  for (const r of results) {
    console.log(`${r.title}\n${r.url}\n${r.content ?? ""}\n`);
  }
} catch (err) {
  console.error(`Search error: ${err.message}`);
  process.exit(1);
}
