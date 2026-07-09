#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.length < 1 || args[0] === "-h" || args[0] === "--help") {
  console.log("Usage: node agent/tools/source-snippets.js <url> [term ...]");
  console.log("Fetch a source URL and print a compact title/description plus matched snippets.");
  process.exit(args.length < 1 ? 1 : 0);
}

const url = args[0];
const terms = args.slice(1).length
  ? args.slice(1)
  : ["cost", "burden", "economic", "billion", "trillion", "million", "GDP", "work", "employment", "productivity", "health"];

const MAX_SNIPPETS = 8;
const SNIPPET_RADIUS = 260;
const MAX_TEXT_FALLBACK = 1400;

const decodeEntities = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

const compactText = (text) => {
  const lines = text
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 20);

  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(line);
    }
  }
  return unique.join("\n");
};

const cleanHtml = (html) => {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  const meta =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1] ||
    "";
  const date = firstMeta(html, [
    "article:published_time",
    "citation_publication_date",
    "dc.date",
    "date",
  ]) || firstJsonValue(html, "datePublished");
  const author = firstMeta(html, [
    "citation_author",
    "author",
    "article:author",
  ]) || firstJsonValue(html, "author");

  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<(p|br|li|h[1-6]|tr|td|div|section|article|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

  return {
    title,
    meta: decodeEntities(meta).replace(/\s+/g, " ").trim(),
    date: cleanInline(date),
    author: cleanInline(author),
    text: compactText(text),
  };
};

const cleanInline = (value) => decodeEntities(String(value || ""))
  .replace(/\\\//g, "/")
  .replace(/\s+/g, " ")
  .trim();

const firstMeta = (html, names) => {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"));
    if (direct?.[1]) return direct[1];
    const reverse = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["']`, "i"));
    if (reverse?.[1]) return reverse[1];
  }
  return "";
};

const firstJsonValue = (html, key) => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scalar = html.match(new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, "i"));
  if (scalar?.[1]) return scalar[1];

  if (key === "author") {
    const named = html.match(/"author"\s*:\s*\{[\s\S]{0,500}?"name"\s*:\s*"([^"]+)"/i);
    if (named?.[1]) return named[1];
    const arrayNamed = html.match(/"author"\s*:\s*\[[\s\S]{0,800}?"name"\s*:\s*"([^"]+)"/i);
    if (arrayNamed?.[1]) return arrayNamed[1];
  }

  return "";
};

const extractPdfText = (buffer) => {
  const result = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
    input: buffer,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) return { error: `pdftotext unavailable: ${result.error.message}` };
  if (result.status !== 0) return { error: (result.stderr || "pdftotext failed").trim() };
  return { text: compactText(result.stdout) };
};

const findSnippets = (text, needles) => {
  const lower = text.toLowerCase();
  const snippets = [];
  const usedWindows = [];

  for (const needle of needles) {
    const query = needle.toLowerCase();
    const idx = lower.indexOf(query);
    if (idx < 0) continue;

    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
    if (usedWindows.some(([s, e]) => Math.abs(start - s) < 160 || (start >= s && start <= e))) continue;
    usedWindows.push([start, end]);
    snippets.push({ term: needle, text: text.slice(start, end).replace(/\s+/g, " ").trim() });
    if (snippets.length >= MAX_SNIPPETS) break;
  }

  return snippets;
};

const looksBlocked = (text) => {
  const lower = text.toLowerCase();
  return [
    "just a moment",
    "enable javascript and cookies",
    "access denied",
    "unusual traffic",
    "cloudflare",
    "captcha",
  ].some((needle) => lower.includes(needle));
};

(async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        accept: "text/html,application/pdf,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
      },
    });
  } catch (err) {
    clearTimeout(timeout);
    console.log(`Fetch error: ${err.message}`);
    process.exit(2);
  }
  clearTimeout(timeout);

  const contentType = response.headers.get("content-type") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  let title = "";
  let meta = "";
  let date = "";
  let author = "";
  let text = "";

  if (contentType.includes("pdf") || /\.pdf($|\?)/i.test(response.url)) {
    const pdf = extractPdfText(buffer);
    if (pdf.error) {
      console.log(`Status: ${response.status} ${response.statusText}`);
      console.log(`Final URL: ${response.url}`);
      console.log(`Content-Type: ${contentType || "unknown"}`);
      console.log(pdf.error);
      process.exit(1);
    }
    text = pdf.text;
    title = "PDF document";
  } else {
    const html = buffer.toString("utf8");
    const cleaned = cleanHtml(html);
    title = cleaned.title;
    meta = cleaned.meta;
    date = cleaned.date;
    author = cleaned.author;
    text = cleaned.text;
  }

  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log(`Final URL: ${response.url}`);
  console.log(`Content-Type: ${contentType || "unknown"}`);
  if (title) console.log(`Title: ${title}`);
  if (date) console.log(`Date: ${date}`);
  if (author) console.log(`Author: ${author}`);
  if (meta) console.log(`Description: ${meta}`);

  if (looksBlocked(`${title}\n${meta}\n${text.slice(0, 1000)}`)) {
    console.log("Blocked/low-signal page detected. Try a different source or browser-visible page.");
    process.exit(0);
  }

  const snippets = findSnippets(text, terms);
  if (snippets.length) {
    console.log("Snippets:");
    for (const snippet of snippets) {
      console.log(`- [${snippet.term}] ${snippet.text}`);
    }
  } else {
    console.log("No matched snippets. First readable text:");
    console.log(text.slice(0, MAX_TEXT_FALLBACK));
  }
})();
