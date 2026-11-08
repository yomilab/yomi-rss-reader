import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { READER_THEMES } from "@/services/settings/readerThemes";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");
const themeCss = read("src/styles/theme.css");
const presetCss = read("src/styles/reader-themes.css");
const listCss = read("src/components/MainArea/ArticleList.css");

const lightBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(themeCss)?.[1] ?? "";
const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(themeCss)?.[1] ?? "";

const token = (block: string, name: string): string => {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].trim();
};

type Rgb = [number, number, number];

const hex = (value: string): Rgb => {
  const n = Number.parseInt(value.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const mix = (a: Rgb, b: Rgb, percentA: number): Rgb =>
  a.map((channel, index) => channel * (percentA / 100) + b[index] * (1 - percentA / 100)) as Rgb;

const luminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** `color-mix(in srgb, var(--system-accent-color) N%, var(<other>))` → [N, other]. */
const accentMix = (value: string): [number, string | null] => {
  const match = /color-mix\(in srgb,\s*var\(--system-accent-color\)\s*(\d+(?:\.\d+)?)%,\s*(?:var\((--[a-z-]+)\)|transparent)\)/.exec(value);
  if (!match) throw new Error(`Expected an accent color-mix, got ${value}`);
  return [Number(match[1]), match[2] ?? null];
};

/** `color-mix(in srgb, var(--theme-text-secondary) N%, var(--theme-primary-color))` → N. */
const softInkPercent = (value: string): number => {
  const match = /color-mix\(in srgb,\s*var\(--theme-text-secondary\)\s*(\d+(?:\.\d+)?)%,\s*var\(--theme-primary-color\)\)/.exec(value);
  if (!match) throw new Error(`Expected a soft-ink color-mix, got ${value}`);
  return Number(match[1]);
};

interface Scheme {
  bgPercent: number;
  titlePercent: number;
  titleBase: string;
  secondaryPercent: number;
  secondaryBase: string;
  /** Share of the soft ink in the secondary text's base (the rest is ink). */
  softInkPercent: number;
}

const scheme = (block: string): Scheme => {
  const [bgPercent] = accentMix(token(block, "--article-list-active-bg"));
  const [titlePercent, titleBase] = accentMix(token(block, "--article-list-active-color"));
  const [secondaryPercent, secondaryBase] = accentMix(token(block, "--article-list-active-secondary-color"));
  return {
    bgPercent,
    titlePercent,
    titleBase: titleBase ?? "",
    secondaryPercent,
    secondaryBase: secondaryBase ?? "",
    softInkPercent: softInkPercent(token(block, "--article-list-active-ink-soft")),
  };
};

const light = scheme(lightBlock);
const dark = scheme(darkBlock);

/** macOS accent colors (System Settings → Appearance). */
const MACOS_ACCENTS = {
  blue: "#007AFF",
  purple: "#A550A7",
  pink: "#F74F9E",
  red: "#FF5257",
  orange: "#F7821B",
  yellow: "#FFC600",
  green: "#62BA46",
  graphite: "#8C8C8C",
};

/** Solid list fills (`--theme-article-bg` without the window glass). */
const LIGHT_LIST = "#FAFAF9";
const DARK_LIST = "#1B1B1D";

const expectReadableOnBlock = (accent: Rgb, page: Rgb, ink: Rgb, softInk: Rgb, s: Scheme, label: string) => {
  const block = mix(accent, page, s.bgPercent);
  const secondaryBase = mix(softInk, ink, s.softInkPercent);
  expect(contrast(mix(accent, ink, s.titlePercent), block), `${label} title`).toBeGreaterThanOrEqual(4.5);
  expect(contrast(mix(accent, secondaryBase, s.secondaryPercent), block), `${label} secondary`).toBeGreaterThanOrEqual(4.5);
};

describe("article list active highlight colors", () => {
  it("mixes the text toward the theme ink, not the raw accent", () => {
    expect(light.titleBase).toBe("--theme-primary-color");
    expect(light.secondaryBase).toBe("--article-list-active-ink-soft");
    expect(dark.titleBase).toBe("--theme-primary-color");
    expect(dark.secondaryBase).toBe("--article-list-active-ink-soft");
  });

  it.each(Object.entries(MACOS_ACCENTS))("keeps %s text readable on the block (light)", (name, accent) => {
    expectReadableOnBlock(
      hex(accent),
      hex(LIGHT_LIST),
      hex(token(lightBlock, "--theme-primary-color")),
      hex(token(lightBlock, "--theme-text-secondary")),
      light,
      name,
    );
  });

  it.each(Object.entries(MACOS_ACCENTS))("keeps %s text readable on the block (dark)", (name, accent) => {
    expectReadableOnBlock(
      hex(accent),
      hex(DARK_LIST),
      hex(token(darkBlock, "--theme-primary-color")),
      hex(token(darkBlock, "--theme-text-secondary")),
      dark,
      name,
    );
  });

  // Presets set the accent to --rt-accent, the ink to --rt-ink and the
  // secondary text to --rt-ink-soft (reader-themes.css).
  const presetBlocks = new Map<string, Record<string, string>>();
  for (const [, id, mode, body] of presetCss.matchAll(
    /\[data-reader-theme="([^"]+)"\]\[data-reader-scheme="(light|dark)"\]\s*\{([^}]*)\}/g,
  )) {
    const tokens: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--rt-[a-z-]+):\s*([^;]+);/g)) tokens[name] = value.trim();
    presetBlocks.set(`${id}/${mode}`, tokens);
  }

  it.each(READER_THEMES.flatMap((theme) => [`${theme.id}/light`, `${theme.id}/dark`]))(
    "keeps text readable on the block in the %s reader theme",
    (id) => {
      const tokens = presetBlocks.get(id);
      expect(tokens, id).toBeDefined();
      const s = id.endsWith("/dark") ? dark : light;
      expectReadableOnBlock(
        hex(tokens!["--rt-accent"]),
        hex(tokens!["--rt-page"]),
        hex(tokens!["--rt-ink"]),
        hex(tokens!["--rt-ink-soft"]),
        s,
        id,
      );
    },
  );
});

describe("article list active highlight styles", () => {
  it("draws the fill with one block, not a background on the active row", () => {
    expect(listCss).toMatch(/\.article-list-active-highlight \{[^}]*background-color: var\(--article-list-active-bg\)/);
    expect(listCss).not.toMatch(/\.article-list-item\.is-active \.article-list-item-content[^{]*\{[^}]*background-color/);
  });

  it("makes the block wider than the row card", () => {
    expect(listCss).toMatch(/\.article-list-active-highlight \{[^}]*--article-list-active-outset: \d+px/);
    expect(listCss).toMatch(/min\(var\(--article-list-column-width\), var\(--max-article-width\)\)\s*\+ var\(--article-list-active-outset\) \* 2/);
  });

  it("shifts the active row's text colors with the block", () => {
    expect(listCss).toMatch(/\.article-list-item\.is-active \.article-list-item-title \{\s*color: var\(--article-list-active-color\);/);
    expect(listCss).toMatch(/\.article-list-item\.is-active \.article-list-item-date \{\s*color: var\(--article-list-active-secondary-color\);/);
  });

  it("puts the active text rules after the read-state title color, so they win", () => {
    expect(listCss.indexOf(".article-list-item.is-active .article-list-item-title {"))
      .toBeGreaterThan(listCss.indexOf(".article-list-item.is-read .article-list-item-title {"));
  });
});
