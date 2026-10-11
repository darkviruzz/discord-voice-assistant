import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISCORD_MAX_CHARS, splitDiscordMessage, clampDiscordText, chatMessageText } from '../src/discordText.js';

// A /recap answer is a summary of a whole session: question + answer easily
// pass Discord's 2000-char limit, and an oversized send was rejected — the
// answer to a typed question was silently lost.
test('a long typed answer is posted as several messages, each within the Discord limit, nothing lost', () => {
  const answer = 'Die Gruppe erreichte Burg Rabenstein und verhandelte mit Baron Kelthur über das Lösegeld. '.repeat(40);
  const text = chatMessageText({ userDisplayName: 'Anna', question: 'Fasse kurz zusammen, was in unserer letzten Sitzung passiert ist.', answer, assistantName: 'Rabenauge' });
  assert.ok(text.length > DISCORD_MAX_CHARS, 'fixture must exceed one message');
  const parts = splitDiscordMessage(text);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length > 0 && p.length <= DISCORD_MAX_CHARS, `part of ${p.length} chars`);
  // Cut at word boundaries: re-joining with a space restores every word.
  assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim());
  assert.ok(parts[0].startsWith('**[Anna]** Fasse kurz zusammen'));
});

test('short messages stay one piece; stop notices render as before', () => {
  assert.deepEqual(splitDiscordMessage('kurz'), ['kurz']);
  assert.deepEqual(splitDiscordMessage(''), []);
  assert.equal(chatMessageText({ userDisplayName: 'Bert', question: 'stopp', isStop: true }), '**[Bert]** stopp\n⏹ *Wiedergabe unterbrochen.*');
  assert.equal(chatMessageText({ question: 'Wer?', answer: 'Kelthur.' }), '**[Spieler]** Wer?\n**[Rabenauge]** Kelthur.');
});

test('an unbreakable run is hard-cut, never inside a surrogate pair', () => {
  const s = `${'x'.repeat(9)}😀${'y'.repeat(20)}`; // emoji straddles position 10
  const parts = splitDiscordMessage(s, 10);
  for (const p of parts) assert.ok(p.length <= 10);
  assert.equal(parts.join(''), s);
  assert.ok(!/[\ud800-\udbff]$/.test(parts[0]), 'no lone high surrogate at a cut');
  const c = clampDiscordText(s, 11);
  assert.ok(c.length <= 11 && c.endsWith('…') && !/[\ud800-\udbff]…$/.test(c));
  assert.equal(clampDiscordText('kurz', 10), 'kurz');
});
