/**
 * zalo-sync-routes.ts — Endpoints to sync Zalo data (friends, history) to CRM.
 * Requires owner or admin role.
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireRole } from '../auth/role-middleware.js';
import { zaloPool } from './zalo-pool.js';
import { processZaloMessage, type UserInfoCacheEntry } from './zalo-message-helpers.js';
import { logger } from '../../shared/utils/logger.js';
import { randomUUID } from 'node:crypto';

const MAX_HISTORY_COUNT = 200;
const DEFAULT_HISTORY_COUNT = 50;
const SYNC_DELAY_MS = 1000;

export async function zaloSyncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // Sync all friends from a Zalo account to contacts
  app.post('/api/v1/zalo-accounts/:id/sync-contacts', { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const instance = zaloPool.getInstance(id);
      if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

      try {
        const result = await instance.api.getAllFriends();
        // getAllFriends returns object with profiles
        const friends = Object.values(result || {}) as any[];
        let created = 0, updated = 0;

        for (const friend of friends) {
          const uid = friend.userId || friend.uid || '';
          if (!uid) continue;

          const zaloName = friend.zaloName || friend.zalo_name || friend.displayName || friend.display_name || '';
          const avatar = friend.avatar || '';
          const phone = friend.phoneNumber || '';

          const existing = await prisma.contact.findFirst({
            where: { zaloUid: uid, orgId: user.orgId },
          });

          if (existing) {
            await prisma.contact.update({
              where: { id: existing.id },
              data: {
                fullName: zaloName || existing.fullName,
                avatarUrl: avatar || existing.avatarUrl,
                phone: phone || existing.phone,
              },
            });
            updated++;
          } else {
            await prisma.contact.create({
              data: {
                id: randomUUID(),
                orgId: user.orgId,
                zaloUid: uid,
                fullName: zaloName || 'Unknown',
                avatarUrl: avatar || null,
                phone: phone || null,
              },
            });
            created++;
          }
        }

        logger.info(`[sync] Zalo contacts: ${created} created, ${updated} updated`);
        return { success: true, created, updated, total: friends.length };
      } catch (err) {
        logger.error('[sync] Zalo contacts error:', err);
        return reply.status(500).send({ error: 'Sync failed: ' + String(err) });
      }
    }
  );

  // Sync historical messages of GROUP conversations.
  // 1-1 (user) history is not supported by zca-js 2.x — see SPEC 0001.
  app.post<{
    Params: { id: string };
    Body: { groupId?: string; count?: number };
  }>(
    '/api/v1/zalo-accounts/:id/sync-group-history',
    { preHandler: requireRole('owner', 'admin') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params;
      const { groupId, count = DEFAULT_HISTORY_COUNT } = request.body ?? {};

      if (count > MAX_HISTORY_COUNT || count < 1) {
        return reply.status(400).send({
          error: `count must be between 1 and ${MAX_HISTORY_COUNT}`,
        });
      }

      const account = await prisma.zaloAccount.findFirst({
        where: { id, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: 'Account not found' });

      const instance = zaloPool.getInstance(id);
      if (!instance?.api) {
        return reply.status(400).send({ error: 'Zalo account not connected' });
      }
      const api = instance.api;

      // Resolve target group list
      let targets: { groupId: string; groupName: string }[] = [];
      try {
        if (groupId) {
          targets = [{ groupId, groupName: '' }];
        } else {
          // getAllGroups returns { gridVerMap: {groupId: version} } in zca-js 2.x
          const result = await api.getAllGroups();
          const ids = Object.keys(result?.gridVerMap || result || {});
          targets = ids.map((gId) => ({ groupId: gId, groupName: '' }));
        }
      } catch (err) {
        logger.error('[sync-history] getAllGroups error:', err);
        return reply.status(500).send({ error: 'Failed to list groups: ' + String(err) });
      }

      // Share the userInfoCache scoped to this request (group sync is one-shot)
      const userInfoCache = new Map<string, UserInfoCacheEntry>();
      const synced: { groupId: string; groupName: string; inserted: number; skipped: number }[] = [];
      let totalInserted = 0;
      let totalSkipped = 0;

      for (const target of targets) {
        let inserted = 0;
        let skipped = 0;
        try {
          const history = await api.getGroupChatHistory(target.groupId, count);
          const msgs: any[] = history?.groupMsgs || [];
          for (const message of msgs) {
            try {
              const result = await processZaloMessage({
                accountId: id,
                api,
                message,
                isGroup: true,
                userInfoCache,
              });
              if (result) inserted++;
              else skipped++;
            } catch (err) {
              logger.warn(`[sync-history] message process error in ${target.groupId}:`, err);
              skipped++;
            }
          }
        } catch (err) {
          logger.warn(`[sync-history] getGroupChatHistory failed for ${target.groupId}:`, err);
        }

        synced.push({ ...target, inserted, skipped });
        totalInserted += inserted;
        totalSkipped += skipped;

        // Rate-limit between groups
        if (targets.length > 1) await new Promise((r) => setTimeout(r, SYNC_DELAY_MS));
      }

      logger.info(
        `[sync-history] Account ${id}: ${totalInserted} inserted, ${totalSkipped} skipped across ${targets.length} group(s)`,
      );
      return { success: true, synced, totalInserted, totalSkipped };
    },
  );
}
