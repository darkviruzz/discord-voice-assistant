// Discord caps a message at 2000 characters. A longer content is rejected
// ("Invalid Form Body") — the send/edit fails, and since the bot's chat posts
// and status edits are fire-and-forget, the text is silently lost.
export const DISCORD_MAX_CHARS = 2000;

// Cut `text` to at most `max` chars without splitting a surrogate pair.
export function clampDiscordText(text, max = DISCORD_MAX_CHARS) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  let end = Math.max(0, max - 1);
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // don't leave a lone high surrogate
  return `${t.slice(0, end)}…`;
}

// Split `text` into pieces of at most `max` chars, preferring a line break,
// then a space near the end of each piece; a word longer than a piece is
// hard-cut (never inside a surrogate pair). Empty input → [].
export function splitDiscordMessage(text, max = DISCORD_MAX_CHARS) {
  let rest = String(text ?? '');
  const parts = [];
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = head.lastIndexOf('\n');
    if (cut < max * 0.5) cut = Math.max(cut, head.lastIndexOf(' '));
    if (cut < max * 0.5) {
      cut = max;
      const c = rest.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
    }
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^[ \n]+/, '');
  }
  if (rest.trim()) parts.push(rest);
  return parts.filter((p) => p.length > 0);
}

// Server chat_message → the text the bot posts (question + answer, or the
// stop notice). May exceed one Discord message — post it via
// splitDiscordMessage().
export function chatMessageText(msg = {}) {
  const speaker = msg.userDisplayName || 'Spieler';
  const assistant = msg.assistantName || 'Rabenauge';
  if (msg.isStop) return `**[${speaker}]** ${msg.question}\n⏹ *Wiedergabe unterbrochen.*`;
  return `**[${speaker}]** ${msg.question}\n**[${assistant}]** ${msg.answer ?? ''}`;
}
