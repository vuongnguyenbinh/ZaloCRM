/**
 * zalo-listener-factory.ts — sets up zca-js listener events for one Zalo account.
 * Handles message routing, undo events, and offline-message catch-up.
 * Heavy lifting (name resolution, message normalization) lives in zalo-message-helpers.
 */
import type { Server } from 'socket.io';
import { logger } from '../../shared/utils/logger.js';
import { handleMessageUndo } from '../chat/message-handler.js';
import {
  processZaloMessage,
  type UserInfoCacheEntry,
} from './zalo-message-helpers.js';

export type { UserInfoCacheEntry };

export interface ListenerContext {
  accountId: string;
  api: any;
  io: Server | null;
  userInfoCache: Map<string, UserInfoCacheEntry>;
  onDisconnected: (accountId: string) => void;
}

/**
 * Attach all zca-js listener events for the given account.
 * Calls listener.start() with retryOnClose at the end.
 */
export function attachZaloListener(ctx: ListenerContext): void {
  const { accountId, api, io, userInfoCache, onDisconnected } = ctx;
  const listener = api.listener;

  listener.on('connected', () => {
    logger.info(`[zalo:${accountId}] Listener connected`);
  });

  listener.on('message', async (message: any) => {
    try {
      const isGroup = message.type === 1;
      const result = await processZaloMessage({
        accountId,
        api,
        message,
        isGroup,
        userInfoCache,
      });
      if (result) {
        io?.emit('chat:message', {
          accountId,
          message: result.message,
          conversationId: result.conversationId,
        });
      }
    } catch (err) {
      logger.error(`[zalo:${accountId}] Message handler error:`, err);
    }
  });

  // Offline messages — Zalo pushes a batch of messages that arrived while the
  // WebSocket was disconnected. threadType: 0 = User (1-1), 1 = Group.
  listener.on('old_messages', async (msgs: any[], threadType: number) => {
    const isGroup = threadType === 1;
    let processed = 0;
    for (const message of msgs) {
      try {
        const result = await processZaloMessage({
          accountId,
          api,
          message,
          isGroup,
          userInfoCache,
        });
        if (result) {
          processed++;
          io?.emit('chat:message', {
            accountId,
            message: result.message,
            conversationId: result.conversationId,
          });
        }
      } catch (err) {
        logger.warn(`[zalo:${accountId}] old_messages item error:`, err);
      }
    }
    logger.info(
      `[zalo:${accountId}] old_messages processed ${processed}/${msgs.length} (${
        isGroup ? 'group' : 'user'
      })`,
    );
  });

  listener.on('undo', async (data: any) => {
    const msgId = data.data?.msgId || data.msgId;
    if (msgId) {
      await handleMessageUndo(accountId, String(msgId));
      io?.emit('chat:deleted', { accountId, msgId: String(msgId) });
    }
  });

  listener.on('closed', (code: number, reason: string) => {
    logger.warn(`[zalo:${accountId}] Listener closed: ${code} ${reason}`);
    onDisconnected(accountId);
    io?.emit('zalo:disconnected', { accountId, code, reason });
  });

  listener.on('error', (err: any) => {
    logger.error(`[zalo:${accountId}] Listener error:`, err);
  });

  listener.start({ retryOnClose: true });
}
