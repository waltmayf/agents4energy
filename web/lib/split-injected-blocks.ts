export interface InjectedBlock {
  tag: 'agents_md' | 'github_context' | 'github_access';
  label: string;
  content: string;
}

const KNOWN_TAGS: Array<{ tag: InjectedBlock['tag']; label: string }> = [
  { tag: 'agents_md', label: 'AGENTS.md' },
  { tag: 'github_context', label: 'GitHub context' },
  { tag: 'github_access', label: 'GitHub access' },
];

/**
 * Splits webhook-injected `<agents_md>`/`<github_context>`/`<github_access>`
 * blocks out of a user message's text (built in
 * agent-webhook-invoke-agent/handler.ts), so the chat UI can render them with
 * assistant-message Markdown styling and leave only the actual human/webhook
 * request text in the plain user bubble. Non-webhook messages have none of
 * these tags, so `blocks` comes back empty and `remainder` is the input
 * unchanged.
 */
export function splitInjectedBlocks(text: string): { blocks: InjectedBlock[]; remainder: string } {
  const blocks: InjectedBlock[] = [];
  let remainder = text;

  for (const { tag, label } of KNOWN_TAGS) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
    remainder = remainder.replace(re, (_match, inner: string) => {
      const content = inner.trim();
      if (content) blocks.push({ tag, label, content });
      return '';
    });
  }

  return { blocks, remainder: remainder.trim() };
}
