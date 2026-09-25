import { describe, expect, it } from 'vitest';
import { FILE_LINK_PREFIX, fileIdFromHref, linkifyWorkspaceFileUrls } from './file-links';

const ID = 'fa5021f6-a93b-4c93-b066-13c301ec46d2';
const LINK = `[Open file](${FILE_LINK_PREFIX}${ID})`;

describe('linkifyWorkspaceFileUrls', () => {
  it('turns a backticked container-internal URL into an in-app file link', () => {
    const md = `**Download:** \`http://host.containers.internal:8080/v1/files/${ID}\``;
    expect(linkifyWorkspaceFileUrls(md)).toBe(`**Download:** ${LINK}`);
  });

  it('handles any host, a bare URL, and drops a query string (including a token)', () => {
    expect(linkifyWorkspaceFileUrls(`see http://localhost:8080/v1/files/${ID} now`)).toBe(`see ${LINK} now`);
    expect(linkifyWorkspaceFileUrls(`https://q-workspace.graphtintelligence.com/v1/files/${ID}?token=secret`)).toBe(LINK);
  });

  it('keeps the text of an existing markdown link and fixes only its target', () => {
    const md = `[the deck](http://host.containers.internal:8080/v1/files/${ID})`;
    expect(linkifyWorkspaceFileUrls(md)).toBe(`[the deck](${FILE_LINK_PREFIX}${ID})`);
  });

  it('leaves fenced code blocks untouched', () => {
    const md = `before http://x/v1/files/${ID}\n\`\`\`bash\ncurl http://x/v1/files/${ID}\n\`\`\`\nafter`;
    const out = linkifyWorkspaceFileUrls(md);
    expect(out).toContain(`before ${LINK}`);
    expect(out).toContain(`curl http://x/v1/files/${ID}\n`);
  });

  it('ignores non-file URLs and messages without file URLs', () => {
    const md = 'http://elrond:8800/aragorn/health and /v1/files/ listing';
    expect(linkifyWorkspaceFileUrls(md)).toBe(md);
  });
});

describe('fileIdFromHref', () => {
  it('extracts the id only from the in-app prefix', () => {
    expect(fileIdFromHref(`${FILE_LINK_PREFIX}${ID}`)).toBe(ID);
    expect(fileIdFromHref('https://example.com')).toBeNull();
    expect(fileIdFromHref(`${FILE_LINK_PREFIX}not-a-uuid`)).toBeNull();
  });
});
