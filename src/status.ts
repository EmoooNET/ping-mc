import { parseMOTD } from './motd.js';
import type { MCChatComponent } from './motd.js';
import type { MCServerPlayer, MCServerStatus } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** 网络 JSON 先验证结构，再收敛为库的稳定接口。 */
export function parseStatus(value: unknown): MCServerStatus {
  if (!isRecord(value) || !isRecord(value.version) || !isRecord(value.players)) {
    throw new Error('Status response must contain version and players objects');
  }
  const { version, players } = value;
  if (typeof version.name !== 'string' || !isInteger(version.protocol)) {
    throw new Error('Invalid server version in status response');
  }
  if (!isInteger(players.online) || players.online < 0 || !isInteger(players.max) || players.max < 0) {
    throw new Error('Invalid player counts in status response');
  }
  if (value.description === undefined || value.description === null) {
    throw new Error('Status response is missing its MOTD description');
  }

  const status: MCServerStatus = {
    version: { name: version.name, protocol: version.protocol },
    players: { online: players.online, max: players.max },
    motd: parseMOTD(value.description as MCChatComponent),
  };

  if (players.sample !== undefined) {
    if (!Array.isArray(players.sample)) throw new Error('Invalid player sample in status response');
    status.players.sample = players.sample.map((player: unknown): MCServerPlayer => {
      if (!isRecord(player) || typeof player.name !== 'string' || typeof player.id !== 'string') {
        throw new Error('Invalid player sample entry in status response');
      }
      return { name: player.name, id: player.id };
    });
  }

  if (value.favicon !== undefined) {
    if (typeof value.favicon !== 'string') throw new Error('Invalid favicon in status response');
    const match = /^data:image\/png;base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/.exec(value.favicon);
    if (!match?.[1]) throw new Error('Favicon must be a PNG Base64 data URI');
    status.icon = match[1];
  }

  return status;
}
