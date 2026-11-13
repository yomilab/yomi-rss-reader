import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { READER_THEMES } from "@/services/settings/readerThemes";

const cssPath = path.resolve(process.cwd(), "src/styles/reader-themes.css");
const css = readFileSync(cssPath, "utf8");

/** `--rt-*` color tokens per `[data-reader-theme="<id>"][data-reader-scheme="<scheme>"]` block, keyed `id/scheme`. */
function parsePresetTokens(source: string): Map<string, Record<string, string>> {
  const presets = new Map<string, Record<string, string>>();
  const blockPattern = /\[data-reader-theme="([^"]+)"\]\[data-reader-scheme="(light|dark)"\]\s*\{([^}]*)\}/g;
  for (const [, themeId, scheme, body] of source.matchAll(blockPattern)) {
    const id = `${themeId}/${scheme}`;
    const tokens: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--rt-[a-z-]+):\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
    presets.set(id, tokens);
  }
  return presets;
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Expected #rrggbb, got ${hex}`);
  const n = Number.parseInt(match[1], 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const presetTokens = parsePresetTokens(css);

describe("reader-themes.css", () => {
  it("defines a light and a dark color block for exactly the registry themes", () => {
    const expected = READER_THEMES.flatMap((theme) => [`${theme.id}/light`, `${theme.id}/dark`]);
    expect([...presetTokens.keys()].sort()).toEqual(expected.sort());
  });

  it("lists the same theme ids in index.html's pre-paint script as the registry", () => {
    // index.html cannot import the registry; an id missing there loses the
    // pre-paint apply, and a stale extra id would point at a missing CSS block.
    const html = readFileSync(path.resolve(process.cwd(), "index.html"), "utf8");
    const match = /const READER_THEME_IDS = (\[[^\]]*\]);/.exec(html);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual(READER_THEMES.map((theme) => theme.id));
  });

  it("gives the dark version a darker page than the light version", () => {
    for (const theme of READER_THEMES) {
      const light = presetTokens.get(`${theme.id}/light`)?.["--rt-page"] ?? "#000000";
      const dark = presetTokens.get(`${theme.id}/dark`)?.["--rt-page"] ?? "#ffffff";
      expect(luminance(dark), theme.id).toBeLessThan(luminance(light));
    }
  });

  it("overrides the inline macOS accent that useSystemAccentColor() sets on the root", () => {
    // An inline style beats any normal stylesheet declaration; only !important wins.
    expect(css).toMatch(/--system-accent-color:\s*var\(--rt-accent\)\s*!important;/);
  });

  it("keeps the built-in window transparency (Modern glass, Surface opacity)", () => {
    // A solid preset surface or body background hides the native vibrancy.
    expect(css).toMatch(/--theme-sidebar-bg:[^;]*var\(--app-surface-fill-alpha\)/);
    expect(css).toMatch(/--theme-article-bg:[^;]*var\(--rt-list-fill-alpha\)/);
    expect(css).toMatch(/--theme-article-view-bg:[^;]*var\(--app-reader-fill-alpha\)/);
    expect(css).not.toMatch(/\bbody\s*\{[^}]*background/);
  });

  it("keeps fonts out of CSS (ThemeProvider resolves them from the registry)", () => {
    expect(css).not.toMatch(/--rt-font-/);
  });

  it("takes Ivory's colors from the portals' ivory theme", () => {
    // portal-theme themes.css, ivory: --paper, --ink, --ink-2, --accent, --accent-ink.
    expect(presetTokens.get("ivory/light")).toMatchObject({
      "--rt-page": "#FAF9F5",
      "--rt-ink": "#141413",
      "--rt-ink-soft": "#5E5D59",
      "--rt-accent": "#B5532E",
      "--rt-on-accent": "#FFFFFF",
    });
    expect(presetTokens.get("ivory/dark")).toMatchObject({
      "--rt-page": "#141413",
      "--rt-ink": "#FAF9F5",
      "--rt-ink-soft": "#C2C0B6",
      "--rt-accent": "#D97757",
      "--rt-on-accent": "#141413",
    });
  });

  describe.each(READER_THEMES.flatMap((theme) => [`${theme.id}/light`, `${theme.id}/dark`]))("%s", (id) => {
    it("meets the readability contrast invariants", () => {
      expectReadable(presetTokens.get(id) ?? {});
    });
  });
});

function expectReadable(tokens: Record<string, string>) {
  const page = tokens["--rt-page"];
  expect(contrast(tokens["--rt-ink"], page)).toBeGreaterThanOrEqual(7);
  expect(contrast(tokens["--rt-ink-soft"], page)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens["--rt-accent"], page)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(tokens["--rt-on-accent"], tokens["--rt-accent"])).toBeGreaterThanOrEqual(4.5);
}

