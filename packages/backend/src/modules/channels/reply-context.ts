import type { SendOptions } from './providers/base.provider.js';

/** Snapshot only serializable routing metadata; never keep SDK objects or callbacks. */
export function replyContext(raw: Record<string, unknown> = {}, fallbackId = ''): SendOptions {
  const options: SendOptions = {};
  for (const key of [
    'chatId',
    'channel',
    'channelId',
    'guildId',
    'groupId',
    'groupOpenid',
    'isGroup',
    'msgType',
    'receiveIdType',
    'contextToken',
    'threadTs',
    'ts',
    'conversationType',
    'sessionWebhook',
    'sessionWebhookExpiredTime',
  ]) {
    const value = raw[key];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number')
      options[key] = value;
  }
  options.chatId = String(
    raw['chatId'] ||
      raw['channel'] ||
      raw['channelId'] ||
      raw['groupId'] ||
      raw['groupOpenid'] ||
      '',
  );
  options.msgId = String(
    raw['messageId'] || raw['message_id'] || raw['msgId'] || raw['ts'] || fallbackId,
  );
  options.replyMessageId = options.msgId;
  options.skipReply = !options.replyMessageId;
  if (raw['messageType'] === 'group') options.isGroup = true;
  return options;
}
export function replyThread(raw: Record<string, unknown> = {}, peer: string): string {
  const o = replyContext(raw);
  return JSON.stringify([o.chatId || raw['guildId'] || peer, raw['threadTs'] || '']);
}
