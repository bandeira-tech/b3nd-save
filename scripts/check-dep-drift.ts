#!/usr/bin/env -S deno run --allow-read=deno.json --allow-net=jsr.io
/**
 * check-dep-drift.ts — verify that every jsr:@bandeira-tech/* pin in
 * deno.json resolves the current JSR latest version.
 *
 * Semver / caret rules:
 *   ^0.M.P  →  must match major 0 AND minor M exactly; patch ≥ P.
 *              (0.x caret does NOT cross minors — ^0.22.0 excludes 0.23.0)
 *   ^A.B.C (A≥1)  →  same major A; minor+patch ≥ B.C
 *   ~M.N.P  →  same major.minor; patch ≥ P
 *   bare    →  exact match
 *
 * Exits 0 when all pins are current; exits 1 listing each drifted pin.
 */

// ── semver helpers (pure, exported for unit tests) ───────────────────────

/** Parse "1.2.3" → [1, 2, 3].  Strips a leading ^ or ~. */
export function parseVer(v: string): [number, number, number] {
  const clean = v.replace(/^[~^]/, "");
  const parts = clean.split(".").map(Number);
  if (parts.length < 3 || parts.some((n) => isNaN(n))) {
    throw new Error(`Unparseable version: "${v}"`);
  }
  return [parts[0], parts[1], parts[2]];
}

/**
 * Returns true when `latest` is satisfied by `range`.
 * Handles ^ prefix (with 0.x minor-lock), ~ prefix, or bare version.
 */
export function satisfies(range: string, latest: string): boolean {
  const [latestMaj, latestMin, latestPat] = parseVer(latest);

  if (range.startsWith("^")) {
    const [maj, min, pat] = parseVer(range);
    if (maj === 0) {
      // 0.x caret: major and minor must match exactly; patch ≥ required
      return latestMaj === 0 && latestMin === min && latestPat >= pat;
    }
    // ≥1.x caret: same major, (minor, patch) lexicographically ≥ (min, pat)
    if (latestMaj !== maj) return false;
    if (latestMin > min) return true;
    if (latestMin < min) return false;
    return latestPat >= pat;
  }

  if (range.startsWith("~")) {
    const [maj, min, pat] = parseVer(range);
    return latestMaj === maj && latestMin === min && latestPat >= pat;
  }

  // Bare version: exact match
  const [maj, min, pat] = parseVer(range);
  return latestMaj === maj && latestMin === min && latestPat === pat;
}

// ── main (runs only when invoked directly) ────────────────────────────────

if (import.meta.main) {
  const denoJson = JSON.parse(await Deno.readTextFile("deno.json"));
  const imports: Record<string, string> = denoJson.imports ?? {};

  // Collect unique @bandeira-tech JSR pins (multiple subpaths share one range)
  const pinsByPkg = new Map<string, string>(); // pkg → range (first seen)
  for (const specifier of Object.values(imports)) {
    const m = (specifier as string).match(
      /^jsr:(@bandeira-tech\/[^@/]+)@([^/]+)/,
    );
    if (!m) continue;
    const [, pkg, range] = m;
    if (!pinsByPkg.has(pkg)) pinsByPkg.set(pkg, range);
  }

  if (pinsByPkg.size === 0) {
    console.log("No jsr:@bandeira-tech/* pins found — nothing to check.");
    Deno.exit(0);
  }

  const drifted: string[] = [];

  for (const [pkg, range] of pinsByPkg) {
    const url = `https://jsr.io/${pkg}/meta.json`;
    let latest: string;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const meta = await res.json() as { latest: string };
      latest = meta.latest;
    } catch (e) {
      console.error(`ERROR: could not fetch ${url}: ${e}`);
      drifted.push(`  ${pkg}: fetch failed — treat as drift until resolved`);
      continue;
    }

    if (satisfies(range, latest)) {
      console.log(`OK  ${pkg}  ${range}  (latest ${latest})`);
    } else {
      drifted.push(
        `  ${pkg}: pinned ${range}, latest ${latest} — bump required`,
      );
    }
  }

  if (drifted.length > 0) {
    console.error("\nDEP DRIFT — pins that lag JSR latest:");
    for (const msg of drifted) console.error(msg);
    console.error(
      "\nBump the pin in deno.json, run deno check + tests, publish a patch release.",
    );
    Deno.exit(1);
  }

  console.log("\nAll @bandeira-tech pins are current.");
}
