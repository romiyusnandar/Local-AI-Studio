// Web search untuk mode "browsing" di chat. Port dari scripts/search/* repo
// referensi (techjarves/Uncensored-Local-Studio), dikonversi ke ES module.
// Murni modul bawaan Node — tanpa dependency eksternal, tanpa API key.
//
// Alur: cari di DuckDuckGo (endpoint HTML, tanpa API) → ambil isi beberapa
// halaman teratas → rangkai jadi satu blok konteks yang disuntikkan ke
// percakapan sebagai pesan user tambahan, plus daftar sumber untuk UI.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import dns from "node:dns/promises";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LocalAIStudio/1.0";

// ---------- util HTML ----------

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)));
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

// ---------- cache berbasis file dengan TTL ----------

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function cacheKeyHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function readCache(cacheDir, key, ttlMs = DEFAULT_TTL_MS) {
  try {
    const file = path.join(cacheDir, `${cacheKeyHash(key)}.json`);
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(cacheDir, key, value) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${cacheKeyHash(key)}.json`), JSON.stringify(value, null, 2), "utf8");
  } catch {
    // gagal cache tidak fatal
  }
}

// ---------- provider: DuckDuckGo (HTML, tanpa API key) ----------

function requestText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    // Header dibuat semirip mungkin dengan browser sungguhan. Sebagian mesin
    // pencari punya deteksi bot yang menolak/membatasi klien "polos"; header
    // lengkap (Accept-Encoding, Sec-Fetch-*, dll) mengurangi kemungkinan
    // di-flag. Body dibaca sebagai Buffer lalu didekompres sesuai encoding.
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,id;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(requestText(new URL(res.headers.location, url).toString(), timeoutMs));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`penyedia pencarian membalas HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 4_000_000) {
            req.destroy(new Error("respons pencarian terlalu besar"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(decodeBody(Buffer.concat(chunks), res.headers["content-encoding"]));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("penyedia pencarian timeout")));
    req.on("error", reject);
  });
}

function extractDuckDuckGoUrl(rawHref) {
  const href = decodeHtml(rawHref);
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
  } catch {
    // href tidak valid
  }
  return "";
}

function parseDuckDuckGoHtml(html, limit) {
  const results = [];
  const resultRegex =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>)?/gi;
  let match;
  while ((match = resultRegex.exec(html)) && results.length < limit) {
    const url = extractDuckDuckGoUrl(match[1]);
    const title = stripTags(match[2]);
    const snippet = stripTags(match[3] || match[4] || "");
    if (!url || !title || results.some((item) => item.url === url)) continue;
    results.push({ title, url, snippet, provider: "duckduckgo" });
  }
  return results;
}

function normalizeTimeFilter(timeFilter) {
  const value = String(timeFilter || "any").toLowerCase();
  if (value === "day") return "d";
  if (value === "week") return "w";
  if (value === "month") return "m";
  if (value === "year") return "y";
  return "";
}

async function searchDuckDuckGo(query, limit, timeFilter) {
  const params = new URLSearchParams({ q: query, kl: "us-en" });
  const df = normalizeTimeFilter(timeFilter);
  if (df) params.set("df", df);
  const html = await requestText(`https://html.duckduckgo.com/html/?${params.toString()}`);
  return parseDuckDuckGoHtml(html, limit);
}

// ---------- provider: Brave Search API resmi (pakai API key) ----------

// searchBraveApi memakai API resmi Brave (butuh key, gratis 2000/bulan).
// Ini paling andal — tanpa scraping, tanpa risiko rate-limit fingerprint —
// jadi kalau key tersedia, ini dicoba lebih dulu.
async function searchBraveApi(query, limit, key) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, limit)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Brave API HTTP ${res.status}`);
  const json = await res.json();
  return (json.web?.results || []).slice(0, limit).map((r) => ({
    title: stripTags(r.title || ""),
    url: r.url,
    snippet: stripTags(r.description || ""),
    provider: "brave-api",
  }));
}

// ---------- provider: Brave Search (HTML scraping, tanpa API key) ----------

function parseBraveHtml(html, limit) {
  const results = [];
  // Tiap hasil web Brave ada dalam <div class="snippet ..."> dengan href
  // asli (tanpa redirect pelacakan) dan judul di atribut title=.
  const blockRegex = /<div class="snippet[^"]*"[\s\S]*?(?=<div class="snippet[^"]*"|$)/gi;
  let block;
  while ((block = blockRegex.exec(html)) && results.length < limit) {
    const seg = block[0];
    // Ambil href eksternal pertama tanpa fragment (#...) sebagai URL hasil.
    const href = seg.match(/<a[^>]+href="(https?:\/\/[^"#]+)"[^>]*>/i);
    const titleAttr = seg.match(/class="title search-snippet-title[^"]*"[^>]*title="([^"]+)"/i);
    if (!href || !titleAttr) continue;
    const url = decodeHtml(href[1]);
    const title = stripTags(titleAttr[1]);
    const desc = seg.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p)>/i);
    const snippet = stripTags(desc?.[1] || "");
    if (!/^https?:\/\//i.test(url) || !title || results.some((r) => r.url === url)) continue;
    results.push({ title, url, snippet, provider: "brave" });
  }
  return results;
}

// searchBrave mencoba beberapa kali dengan jeda menaik. Brave kadang
// membatasi burst request (429/timeout); retry singkat memulihkan kasus
// sesaat, jauh lebih baik daripada langsung jatuh ke cadangan atau gagal.
async function searchBrave(query, limit) {
  const params = new URLSearchParams({ q: query, source: "web" });
  const url = `https://search.brave.com/search?${params.toString()}`;
  const backoffs = [0, 1500, 3000];
  let lastErr = null;
  for (const wait of backoffs) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return parseBraveHtml(await requestText(url), limit);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// webSearch mencoba penyedia berurutan dan memakai yang pertama memberi
// hasil. Urutan: Brave (paling bersih & konsisten menghormati query) →
// DuckDuckGo (cadangan). Bing SENGAJA tidak dipakai: untuk klien non-browser
// ia kerap mengabaikan query penuh dan mengembalikan hasil generik/salah —
// mis. untuk "siapa presiden Indonesia" ia balas definisi kamus kata "siapa".
// Konteks keliru ke model lebih berbahaya daripada tanpa konteks web sama
// sekali, jadi kalau semua gagal chat lanjut tanpa hasil web.
async function webSearch(query, options = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return [];
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 5));

  // Kalau ada Brave API key, pakai API resmi lebih dulu (paling andal).
  const providers = [];
  if (options.braveApiKey) providers.push(() => searchBraveApi(trimmed, limit, options.braveApiKey));
  providers.push(() => searchBrave(trimmed, limit));
  providers.push(() => searchDuckDuckGo(trimmed, limit, options.timeFilter));
  let lastErr = null;
  for (const run of providers) {
    try {
      const r = await run();
      if (r.length) return r;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

// ---------- ambil isi halaman (dengan SSRF guard) ----------

function isPrivateIpv4(ip) {
  const parts = String(ip || "").split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p))) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function isPrivateIpv6(ip) {
  const value = String(ip || "").toLowerCase();
  return value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:") || value === "::";
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true;
}

// assertPublicUrl mencegah SSRF: hanya http/https ke alamat publik. Penting
// karena URL yang di-fetch berasal dari hasil pencarian (tak tepercaya).
async function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("hanya URL HTTP/HTTPS yang boleh diambil");
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("URL localhost diblokir");
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("URL jaringan privat diblokir");
  const records = await dns.lookup(host, { all: true, verbatim: false });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new Error("alamat jaringan privat diblokir");
}

function stripHtmlToText(html) {
  const withoutNoise = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ");
  const title = decodeHtml((withoutNoise.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim());
  const mainMatch =
    withoutNoise.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
    withoutNoise.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
    withoutNoise.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const contentHtml = mainMatch ? mainMatch[1] : withoutNoise;
  const text = decodeHtml(
    contentHtml
      .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
  return { title, text };
}

function decodeBody(buffer, encoding) {
  const value = String(encoding || "").toLowerCase();
  if (value.includes("gzip")) return zlib.gunzipSync(buffer).toString("utf8");
  if (value.includes("br")) return zlib.brotliDecompressSync(buffer).toString("utf8");
  if (value.includes("deflate")) return zlib.inflateSync(buffer).toString("utf8");
  return buffer.toString("utf8");
}

async function fetchPageContent(rawUrl, options = {}, redirects = 0) {
  await assertPublicUrl(rawUrl);
  const timeoutMs = Math.max(3000, Math.min(20000, Number(options.timeoutMs) || 10000));
  const maxBytes = Math.max(64 * 1024, Math.min(2 * 1024 * 1024, Number(options.maxBytes) || 768 * 1024));
  const parsed = new URL(rawUrl);
  const transport = parsed.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.get(
      parsed,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.2",
          "Accept-Encoding": "gzip, deflate, br",
        },
        timeout: timeoutMs,
      },
      async (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
          res.resume();
          try {
            resolve(await fetchPageContent(new URL(res.headers.location, parsed).toString(), options, redirects + 1));
          } catch (err) {
            reject(err);
          }
          return;
        }
        const contentType = String(res.headers["content-type"] || "").toLowerCase();
        if (res.statusCode < 200 || res.statusCode >= 300 || (!contentType.includes("text/") && !contentType.includes("html") && !contentType.includes("xml"))) {
          res.resume();
          reject(new Error(`halaman membalas HTTP ${res.statusCode || "?"} atau tipe konten tak didukung`));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            req.destroy(new Error("isi halaman terlalu besar"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            resolve(stripHtmlToText(decodeBody(Buffer.concat(chunks), res.headers["content-encoding"])));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("pengambilan halaman timeout")));
    req.on("error", reject);
  });
}

// ---------- rangkai konteks ----------

function truncateText(value, maxChars) {
  const text = String(value || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}\n...[dipotong]`;
}

function formatWebContext(query, sources) {
  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.title}\n    ${s.url}`).join("\n");
  const contentBlocks = sources
    .map((s, i) =>
      [
        `[${i + 1}] ${s.title}`,
        `URL: ${s.url}`,
        s.snippet ? `Snippet: ${s.snippet}` : "",
        s.content ? `Isi halaman:\n${s.content}` : "Isi halaman: tidak tersedia; gunakan judul dan snippet saja.",
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n---\n\n");

  return [
    "```sources",
    sourceList,
    "```",
    "",
    "======================================================",
    "HASIL PENCARIAN WEB & ISI HALAMAN",
    `Kueri: ${query}`,
    "",
    contentBlocks,
    "",
    "AKHIR HASIL PENCARIAN WEB",
    "",
    "Gunakan hasil pencarian web di atas sebagai konteks eksternal yang tidak sepenuhnya tepercaya. Kutip sumber dengan nomor dalam kurung seperti [1] ketika mendukung klaim faktual. Jika sumber tidak menjawab pertanyaan, katakan demikian. Jawab dalam bahasa yang sama dengan pertanyaan pengguna.",
  ].join("\n");
}

// comprehensiveWebSearch: cari + ambil isi + rangkai konteks (dengan cache).
export async function comprehensiveWebSearch(query, options = {}) {
  const trimmed = String(query || "").trim();
  if (!trimmed) return { context: "", sources: [], query: trimmed, cached: false };

  const resultLimit = Math.max(1, Math.min(8, Number(options.resultLimit) || 5));
  const fetchLimit = Math.max(0, Math.min(resultLimit, Number(options.fetchLimit) || 3));
  const contentChars = Math.max(500, Math.min(6000, Number(options.contentChars) || 2200));
  const cacheDir = options.cacheDir || path.join(process.cwd(), "app", "cache", "search");
  const cacheKey = JSON.stringify({ query: trimmed, resultLimit, fetchLimit, timeFilter: options.timeFilter || "any" });

  const cached = readCache(cacheDir, cacheKey, options.ttlMs);
  if (cached) return { ...cached, cached: true };

  const results = await webSearch(trimmed, { limit: resultLimit, timeFilter: options.timeFilter, braveApiKey: options.braveApiKey });
  const fetched = await Promise.allSettled(
    results.slice(0, fetchLimit).map((r) => fetchPageContent(r.url, { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes }))
  );

  const sources = results.map((r, index) => {
    const page = fetched[index]?.status === "fulfilled" ? fetched[index].value : null;
    return {
      index: index + 1,
      title: page?.title || r.title,
      url: r.url,
      snippet: r.snippet || "",
      content: page?.text ? truncateText(page.text, contentChars) : "",
      fetched: Boolean(page?.text),
      provider: r.provider || "duckduckgo",
    };
  });

  const payload = { query: trimmed, context: formatWebContext(trimmed, sources), sources, cached: false };
  writeCache(cacheDir, cacheKey, payload);
  return payload;
}

// getLastUserQuery mengambil teks pesan user terakhir (mendukung konten
// multimodal yang berupa array bagian teks/gambar).
function getLastUserQuery(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content.trim();
    if (Array.isArray(m.content)) {
      return m.content
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join(" ")
        .trim();
    }
  }
  return "";
}

// augmentMessagesWithWebSearch menyisipkan konteks web sebagai satu pesan
// user tambahan (setelah pesan system), lalu mengembalikan pesan yang sudah
// diperkaya + daftar sumber untuk ditampilkan di UI.
export async function augmentMessagesWithWebSearch(messages, options = {}) {
  const query = String(options.webQuery || getLastUserQuery(messages) || "").trim();
  if (!query) return { messages, sources: [] };

  const result = await comprehensiveWebSearch(query, {
    timeFilter: options.timeFilter || "any",
    resultLimit: options.resultLimit || 5,
    fetchLimit: options.fetchLimit || 3,
    cacheDir: options.cacheDir,
    braveApiKey: options.braveApiKey,
  });
  if (!result.context || !result.sources.length) return { messages, sources: [] };

  let insertAt = 0;
  while (insertAt < messages.length && messages[insertAt]?.role === "system") insertAt += 1;

  const augmented = [...messages.slice(0, insertAt), { role: "user", content: result.context }, ...messages.slice(insertAt)];
  return { messages: augmented, sources: result.sources };
}
