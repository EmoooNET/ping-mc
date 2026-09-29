import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMOTD } from '../dist/motd.js';

test('renders nested components, arrays, primitives and line breaks as plain text', () => {
  assert.equal(parseMOTD({
    text: 'Welcome',
    color: 'gold',
    extra: [
      { text: '\n', extra: [{ text: 'Players: ', bold: true }] },
      [12, '/', 20, ' ', false, null],
    ],
  }), 'Welcome\nPlayers: 12/20 false');
  assert.equal(parseMOTD('Simple MOTD'), 'Simple MOTD');
});

test('removes legacy styles and hex colors without removing normal section signs', () => {
  assert.equal(
    parseMOTD('§aGreen §LBold§r\n§x§F§F§0§0§A§AHex §#12AbEfRGB §zunknown'),
    'Green Bold\nHex RGB §zunknown',
  );
});

test('formats translated fallback text with nested arguments and positional placeholders', () => {
  assert.equal(parseMOTD({
    translate: 'server.greeting',
    fallback: '%2$s: %s / %1$s / %s / %% / %3$s',
    with: [
      { text: '§aAlice', extra: ['!'] },
      { translate: 'world.name', fallback: 'World' },
    ],
    extra: ['\nEnjoy!'],
  }), 'World: Alice! / Alice! / World / % / %3$s\nEnjoy!');
  assert.equal(parseMOTD({ translate: 'unknown.translation', with: ['Alice'] }), 'unknown.translation');
  assert.equal(parseMOTD({ translate: 'empty.translation', fallback: '' }), '');
});

test('uses available values for dynamic components', () => {
  assert.equal(parseMOTD([
    { score: { name: 'Alice', objective: 'kills', value: 0 } },
    '/',
    { score: { name: 'Bob', objective: 'kills' } },
    ' ',
    { keybind: 'key.jump' },
    ' ',
    { selector: '@a' },
    ' ',
    { nbt: 'CustomName', entity: '@s' },
  ]), '0/Bob key.jump @a CustomName');
});

test('tolerates malformed JSON shapes without throwing', () => {
  assert.equal(parseMOTD([
    undefined, null, {}, { extra: 'invalid' }, { text: { nested: 'invalid' } },
    { translate: 'example.key', with: {} }, { score: null }, { selector: {} },
    { text: 'valid', extra: [null, { text: 0 }] },
  ]), 'example.keyvalid0');
});

test('bounds deep, cyclic, wide and expanding input', () => {
  let deep = { text: 'unreachable' };
  for (let i = 0; i < 20_000; i += 1) deep = { extra: [deep] };
  assert.equal(parseMOTD(deep), '');

  const cyclic = { text: 'x' };
  cyclic.extra = [cyclic];
  assert.equal(parseMOTD(cyclic).length, 64);
  assert.equal(parseMOTD(Array.from({ length: 20_000 }, () => 'x')).length, 9_999);
  assert.equal(parseMOTD({
    translate: 'large',
    fallback: '%1$s%1$s%1$s',
    with: ['x'.repeat(800_000)],
  }).length, 1_048_576);
});
