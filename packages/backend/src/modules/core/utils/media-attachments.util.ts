import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { deduplicateAttachments, type Attachment, type ChatMessage } from '@skyalyticwing/shared';

const hashes = new Map<string, Promise<string>>();

/** Read only authorized local media. File copies may have entirely different names/URLs. */
export async function deduplicateLocalMedia(
  attachments: readonly Attachment[], allowed: (path: string) => boolean,
): Promise<Attachment[]> {
  const unique = deduplicateAttachments(attachments);
  const seen = new Set<string>();
  const result: Attachment[] = [];
  for (const attachment of unique) {
    if (['video', 'audio', 'image'].includes(attachment.type) && attachment.path) {
      try {
        const path = await realpath(attachment.path);
        if (allowed(path)) {
          const before = await stat(path);
          if (before.isFile()) {
            const key = JSON.stringify([path, before.size, before.mtimeMs, before.ctimeMs]);
            let digest = hashes.get(key);
            if (!digest) {
              digest = (async () => {
                const hash = createHash('sha256');
                for await (const chunk of createReadStream(path)) hash.update(chunk);
                const after = await stat(path);
                if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Media changed while hashing');
                return hash.digest('hex');
              })();
              if (hashes.size >= 512) hashes.delete(hashes.keys().next().value!);
              hashes.set(key, digest);
              void digest.catch(() => { hashes.delete(key); });
            }
            const identity = `${attachment.type}:${before.size}:${await digest}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
          }
        }
      } catch { /* Missing/unreadable files must never hide an attachment or break history. */ }
    }
    result.push(attachment);
  }
  return result;
}

export async function deduplicateMessageMedia(messages: ChatMessage[], allowed: (path: string) => boolean): Promise<ChatMessage[]> {
  return Promise.all(messages.map(async message => message.attachments?.length
    ? { ...message, attachments: await deduplicateLocalMedia(message.attachments, allowed) }
    : message));
}
