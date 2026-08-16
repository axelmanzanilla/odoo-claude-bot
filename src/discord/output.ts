const FENCE = '```';

function scanFenceState(text: string, initial: string | undefined): string | undefined {
  let language = initial;
  for (const line of text.split('\n')) {
    const match = /^```([^`]*)/.exec(line.trimStart());
    if (!match) continue;
    language = language === undefined ? (match[1]?.trim().slice(0, 32) ?? '') : undefined;
  }
  return language;
}

export function splitDiscordOutput(text: string, limit = 2_000): string[] {
  if (limit < 16) throw new Error('Discord output limit is too small');
  if (text.length === 0) return ['(Claude returned an empty response.)'];

  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | undefined;
  while (remaining.length > 0) {
    const prefix = openFence === undefined ? '' : `${FENCE}${openFence}\n`;
    const reserve = 4;
    const capacity = limit - prefix.length - reserve;
    let take = Math.min(capacity, remaining.length);
    if (take < remaining.length) {
      const newline = remaining.lastIndexOf('\n', take);
      if (newline > Math.floor(capacity / 2)) take = newline + 1;
    }
    const body = remaining.slice(0, take);
    remaining = remaining.slice(take);
    const endFence = scanFenceState(body, openFence);
    const suffix = endFence === undefined ? '' : `\n${FENCE}`;
    chunks.push(`${prefix}${body}${suffix}`);
    openFence = endFence;
  }
  return chunks;
}
