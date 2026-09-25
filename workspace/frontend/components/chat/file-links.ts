// Agents quote uploaded files by their backend URL — from inside a container
// that is http://host.containers.internal:8080/v1/files/<id>, usually wrapped
// in `backticks`. That address doesn't resolve in a browser, a code span isn't
// clickable, and the route needs the workspace token besides (which an agent
// must not paste into chat). So the chat renders any such URL, whatever host
// it names, as an in-app file link instead: FILE_LINK_PREFIX + <id>, which
// markdown-content.tsx's `a` renderer turns into "open in Files" (click) /
// token-authenticated download (ctrl/middle-click).

export const FILE_LINK_PREFIX = '#oa-file-';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
// Optional surrounding backticks; any http(s) host; optional ?query.
const FILE_URL = new RegExp(
  '`?https?:\\/\\/[^\\s`<>()\\[\\]]+?\\/v1\\/files\\/(' + UUID + ')(?:\\?[^\\s`<>()\\[\\]]*)?`?',
  'g',
);
// A URL already sitting inside a markdown link target: ](url) — leave its text, fix only the target.
const LINK_TARGET = new RegExp(
  '\\]\\(\\s*https?:\\/\\/[^\\s)]+?\\/v1\\/files\\/(' + UUID + ')(?:\\?[^\\s)]*)?\\s*\\)',
  'g',
);

function linkifySegment(text: string): string {
  return text
    .replace(LINK_TARGET, (_m, id: string) => `](${FILE_LINK_PREFIX}${id})`)
    .replace(FILE_URL, (m, id: string, offset: number, whole: string) => {
      // Inside a markdown link target that LINK_TARGET already rewrote? Leave it.
      if (whole.slice(Math.max(0, offset - 2), offset) === '](') return m;
      return `[Open file](${FILE_LINK_PREFIX}${id})`;
    });
}

/** Rewrite workspace file URLs in message markdown into in-app file links. Fenced code blocks are left alone. */
export function linkifyWorkspaceFileUrls(content: string): string {
  if (!content || !content.includes('/v1/files/')) return content;
  // Split on fenced blocks (``` or ~~~); odd-indexed parts are the fences themselves.
  const parts = content.split(/(^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$)/m);
  return parts.map((part, i) => (i % 2 === 1 ? part : linkifySegment(part))).join('');
}

/** The file id from an href produced by linkifyWorkspaceFileUrls, or null. */
export function fileIdFromHref(href: string | undefined): string | null {
  if (!href || !href.startsWith(FILE_LINK_PREFIX)) return null;
  const id = href.slice(FILE_LINK_PREFIX.length);
  return new RegExp('^' + UUID + '$').test(id) ? id : null;
}
