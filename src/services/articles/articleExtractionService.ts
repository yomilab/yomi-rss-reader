import { readabilityAdapter } from './extractors/readabilityAdapter';
import { defuddleAdapter } from './extractors/defuddleAdapter';
import {
  type ContentParser,
  type ContentParserAdapter,
  type ExtractedArticleContent,
  DEFAULT_CONTENT_PARSER,
  countWordsInHtml,
  isContentParser,
} from './extractors/types';

export type { ExtractedArticleContent } from './extractors/types';
export { type ContentParser, DEFAULT_CONTENT_PARSER, CONTENT_PARSER_VALUES } from './extractors/types';

const ADAPTERS: Record<ContentParser, ContentParserAdapter> = {
  defuddle: defuddleAdapter,
  readability: readabilityAdapter,
};

const resolveAdapter = (parser: ContentParser | undefined): ContentParserAdapter => {
  if (parser && isContentParser(parser)) {
    return ADAPTERS[parser];
  }
  return ADAPTERS[DEFAULT_CONTENT_PARSER];
};

const otherAdapter = (primary: ContentParserAdapter): ContentParserAdapter =>
  primary.id === 'defuddle' ? readabilityAdapter : defuddleAdapter;

// A result only counts when it has readable words. Defuddle can return `<body></body>`
// for an empty page or just a `<script type="application/json">` blob for Next.js pages.
const hasReadableContent = (result: ExtractedArticleContent | null): result is ExtractedArticleContent =>
  !!result && countWordsInHtml(result.content) > 0;

/**
 * Extract structured article content from raw HTML using the user's preferred parser.
 *
 * The optional `parser` argument lets the caller route to a specific adapter; when
 * omitted we fall back to the default parser. If the chosen adapter throws or
 * returns no readable words we transparently retry with the other adapter once so a
 * single-adapter regression cannot break article fetching for the user.
 */
export const extractArticleContentFromHtml = async (
  url: string,
  html: string,
  parser?: ContentParser
): Promise<ExtractedArticleContent | null> => {
  const primary = resolveAdapter(parser);

  try {
    const result = await primary.extract(url, html);
    if (hasReadableContent(result)) {
      return result;
    }
  } catch (error) {
    console.warn(`[articleExtraction] ${primary.id} adapter failed; trying alternate adapter`, error);
  }

  // Try the other registered adapter once before giving up.
  const fallback = otherAdapter(primary);
  try {
    const result = await fallback.extract(url, html);
    return hasReadableContent(result) ? result : null;
  } catch (error) {
    console.warn(`[articleExtraction] ${fallback.id} fallback failed`, error);
    return null;
  }
};
