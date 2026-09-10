import type { DiscoveredProviderModel } from "./model-discovery-contract.js";
import type { FetchedDocument } from "./model-discovery-parser.js";

export const DEEPSEEK_VERSION_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

function cellText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/gi, " ")
    .replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
}

/** Join the two explicitly labelled rows, never discover callable IDs from version text. */
export function parseDeepSeekVersions(document: string): Map<string, string> {
  const safe = document.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, "");
  const tables = [...safe.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map((match) =>
    [...match[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
      [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cellText(cell[1]!))));
  if (!tables.length) {
    tables.push(safe.split("\n").filter((line) => line.includes("|"))
      .map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map(cellText)));
  }
  const candidates = new Map<string, Set<string>>();
  for (const rows of tables) {
    const headers = rows.filter((row) => /^(模型|MODEL)$/i.test(row[0] ?? ""));
    const versions = rows.filter((row) => /^(模型版本|MODEL VERSION)$/i.test(row[0] ?? ""));
    if (headers.length !== 1) continue;
    const header = headers[0]!;
    for (const row of versions) {
      if (row.length !== header.length) continue;
      for (let i = 1; i < header.length; i++) {
        const id = header[i]!.toLowerCase(), version = row[i]!;
        if (!/^deepseek-[a-z0-9-]+$/.test(id) || !/^[a-z0-9._-]{1,128}$/i.test(version)) continue;
        const owner = header.slice(1).map((name) => name.toLowerCase())
          .filter((name) => version.toLowerCase() === name || version.toLowerCase().startsWith(`${name}-`))
          .sort((left, right) => right.length - left.length)[0];
        if (owner !== id) continue;
        const values = candidates.get(id) ?? new Set<string>();
        values.add(version); candidates.set(id, values);
      }
    }
  }
  return new Map([...candidates].filter(([, values]) => values.size === 1)
    .map(([id, values]) => [id, [...values][0]!]));
}

export async function enrichDeepSeekVersions(
  models: DiscoveredProviderModel[], load: (signal: AbortSignal) => Promise<FetchedDocument>, checkedAt: Date,
  timeoutMs = 3_000,
): Promise<void> {
  // Public documentation is optional metadata, not an authority for account permissions.
  for (const model of models) model.facts.officialVersion = null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const document = await Promise.race([load(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Version lookup timed out")); }, timeoutMs);
    })]);
    const versions = parseDeepSeekVersions(document.text);
    for (const model of models) {
      const version = versions.get(model.id.toLowerCase());
      if (!version) continue;
      model.facts.officialVersion = version;
      model.facts.fieldEvidence.official_version = [{ url: document.url,
        checkedAt: checkedAt.toISOString(), extractedValue: version }];
    }
  } catch {
    // Unknown is explicit; never invent a version or retain it as freshly verified.
  } finally {
    clearTimeout(timer);
  }
}
