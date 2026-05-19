/**
 * chat-routes.ts — REST API for conversations and messages.
 * All routes require JWT auth and are scoped to the user's org.
 */
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../shared/database/prisma-client.js';
import { authMiddleware } from '../auth/auth-middleware.js';
import { requireZaloAccess } from '../zalo/zalo-access-middleware.js';
import { zaloPool } from '../zalo/zalo-pool.js';
import { zaloRateLimiter } from '../zalo/zalo-rate-limiter.js';
import { logger } from '../../shared/utils/logger.js';
import { randomUUID } from 'node:crypto';
import type { Server } from 'socket.io';

type QueryParams = Record<string, string>;

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware);

  // ── List conversations (paginated) ──────────────────────────────────────
  app.get('/api/v1/conversations', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { page = '1', limit = '50', search = '', accountId = '' } = request.query as QueryParams;

    const where: any = { orgId: user.orgId };
    if (accountId) where.zaloAccountId = accountId;
    if (search) {
      where.contact = {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
        ],
      };
    }

    // Members can only see conversations from Zalo accounts they have access to
    if (user.role === 'member') {
      const accessibleAccounts = await prisma.zaloAccountAccess.findMany({
        where: { userId: user.id },
        select: { zaloAccountId: true },
      });
      where.zaloAccountId = { in: accessibleAccounts.map((a) => a.zaloAccountId) };
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where,
        include: {
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
          messages: {
            take: 1,
            orderBy: { sentAt: 'desc' },
            select: { content: true, contentType: true, senderType: true, sentAt: true, isDeleted: true },
          },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.conversation.count({ where }),
    ]);

    return { conversations, total, page: parseInt(page), limit: parseInt(limit) };
  });

  // ── Get single conversation ──────────────────────────────────────────────
  app.get('/api/v1/conversations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: {
        contact: true,
        zaloAccount: { select: { id: true, displayName: true, zaloUid: true, status: true } },
      },
    });
    if (!conversation) return reply.status(404).send({ error: 'Not found' });

    return conversation;
  });

  // ── List messages for a conversation (paginated, newest first) ──────────
  app.get('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('read') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { page = '1', limit = '50' } = request.query as QueryParams;

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      select: { id: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: { conversationId: id },
        orderBy: { sentAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit),
      }),
      prisma.message.count({ where: { conversationId: id } }),
    ]);

    return { messages: messages.reverse(), total, page: parseInt(page), limit: parseInt(limit) };
  });

  // ── Send message ─────────────────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/messages', { preHandler: requireZaloAccess('chat') }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };

    if (!content?.trim()) return reply.status(400).send({ error: 'Content required' });

    const conversation = await prisma.conversation.findFirst({
      where: { id, orgId: user.orgId },
      include: { zaloAccount: true },
    });
    if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

    const instance = zaloPool.getInstance(conversation.zaloAccountId);
    if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

    // Rate limit check — prevent account blocking
    const limits = zaloRateLimiter.checkLimits(conversation.zaloAccountId);
    if (!limits.allowed) {
      return reply.status(429).send({ error: limits.reason });
    }

    try {
      const threadId = conversation.externalThreadId || '';
      // zca-js sendMessage(message, threadId, type) — type: 0=User, 1=Group
      const threadType = conversation.threadType === 'group' ? 1 : 0;

      zaloRateLimiter.recordSend(conversation.zaloAccountId);
      await instance.api.sendMessage({ msg: content }, threadId, threadType);

      const message = await prisma.message.create({
        data: {
          id: randomUUID(),
          conversationId: id,
          senderType: 'self',
          senderUid: conversation.zaloAccount.zaloUid || '',
          senderName: 'Staff',
          content,
          contentType: 'text',
          sentAt: new Date(),
          repliedByUserId: user.id,
        },
      });

      await prisma.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
      });

      const io = (app as any).io as Server;
      io?.emit('chat:message', { accountId: conversation.zaloAccountId, message, conversationId: id });

      return message;
    } catch (err) {
      logger.error('[chat] Send message error:', err);
      return reply.status(500).send({ error: 'Failed to send message' });
    }
  });

  // ── Mark conversation as read ────────────────────────────────────────────
  app.post('/api/v1/conversations/:id/mark-read', async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    await prisma.conversation.updateMany({
      where: { id, orgId: user.orgId },
      data: { unreadCount: 0 },
    });

    return { success: true };
  });

  // ── Upload + send an attachment (image / file) — feature 0003 ────────────
  // Allowed MIME types — keep in sync with SPEC §3 BR-0004
  const ALLOWED_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'application/zip',
  ]);
  const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  app.post(
    '/api/v1/conversations/:id/attachments',
    { preHandler: requireZaloAccess('chat') },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };

      const conversation = await prisma.conversation.findFirst({
        where: { id, orgId: user.orgId },
        include: { zaloAccount: true },
      });
      if (!conversation) return reply.status(404).send({ error: 'Conversation not found' });

      const instance = zaloPool.getInstance(conversation.zaloAccountId);
      if (!instance?.api) return reply.status(400).send({ error: 'Zalo account not connected' });

      // Rate limit (shared with text send)
      const limits = zaloRateLimiter.checkLimits(conversation.zaloAccountId);
      if (!limits.allowed) return reply.status(429).send({ error: limits.reason });

      // Pull the single uploaded file from multipart form
      let file: Awaited<ReturnType<typeof request.file>> | undefined;
      try {
        file = await request.file();
      } catch (err: any) {
        // @fastify/multipart throws FST_REQ_FILE_TOO_LARGE when limit hit
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(413).send({ error: 'File quá lớn (tối đa 20MB)' });
        }
        return reply.status(400).send({ error: 'Upload không hợp lệ' });
      }
      if (!file) return reply.status(400).send({ error: 'Thiếu file trong form-data' });

      const mimeType = file.mimetype;
      if (!ALLOWED_MIME.has(mimeType)) {
        return reply.status(415).send({ error: `Loại tệp không cho phép: ${mimeType}` });
      }

      // Buffer the file. multipart may throw FST_REQ_FILE_TOO_LARGE here too.
      let buffer: Buffer;
      try {
        buffer = await file.toBuffer();
      } catch (err: any) {
        if (err?.code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.status(413).send({ error: 'File quá lớn (tối đa 20MB)' });
        }
        throw err;
      }
      if (buffer.length === 0) return reply.status(400).send({ error: 'File rỗng' });

      const isImage = IMAGE_MIME.has(mimeType);
      const filename = file.filename || 'attachment';
      // zca-js AttachmentSource requires filename to have an extension like `${string}.${string}`
      const safeFilename = filename.includes('.') ? filename : `${filename}.bin`;

      // Build the AttachmentSource buffer payload for zca-js
      const attachmentSource = {
        data: buffer,
        filename: safeFilename as `${string}.${string}`,
        metadata: { totalSize: buffer.length },
      };

      try {
        zaloRateLimiter.recordSend(conversation.zaloAccountId);
        const threadId = conversation.externalThreadId || '';
        const threadType = conversation.threadType === 'group' ? 1 : 0;
        const sendResult = await instance.api.sendMessage(
          { msg: '', attachments: [attachmentSource] },
          threadId,
          threadType,
        );

        const zaloMsgId =
          sendResult?.attachment?.[0]?.msgId !== undefined
            ? String(sendResult.attachment[0].msgId)
            : null;

        const message = await prisma.message.create({
          data: {
            id: randomUUID(),
            conversationId: id,
            zaloMsgId,
            senderType: 'self',
            senderUid: conversation.zaloAccount.zaloUid || '',
            senderName: 'Staff',
            content: safeFilename,
            contentType: isImage ? 'image' : 'file',
            attachments: [
              {
                filename: safeFilename,
                size: buffer.length,
                mimeType,
              },
            ],
            sentAt: new Date(),
            repliedByUserId: user.id,
          },
        });

        await prisma.conversation.update({
          where: { id },
          data: { lastMessageAt: new Date(), isReplied: true, unreadCount: 0 },
        });

        const io = (app as any).io as Server | undefined;
        io?.emit('chat:message', {
          accountId: conversation.zaloAccountId,
          message,
          conversationId: id,
        });

        return reply.status(201).send(message);
      } catch (err) {
        logger.error('[chat] Send attachment error:', err);
        return reply.status(502).send({ error: 'Gửi file qua Zalo thất bại' });
      }
    },
  );

  // ── Create new conversation with a contact (feature 0002) ────────────────
  app.post<{ Body: { accountId?: string; contactId?: string } }>(
    '/api/v1/conversations',
    async (request, reply) => {
      const user = request.user!;
      const { accountId, contactId } = request.body ?? {};

      if (!accountId || !contactId) {
        return reply.status(400).send({ error: 'accountId và contactId là bắt buộc' });
      }

      // Verify account belongs to user's org
      const account = await prisma.zaloAccount.findFirst({
        where: { id: accountId, orgId: user.orgId },
        select: { id: true },
      });
      if (!account) return reply.status(404).send({ error: 'Zalo account không tồn tại' });

      // Verify contact belongs to user's org + has a Zalo UID (synced)
      const contact = await prisma.contact.findFirst({
        where: { id: contactId, orgId: user.orgId },
        select: { id: true, zaloUid: true },
      });
      if (!contact) return reply.status(404).send({ error: 'Khách hàng không tồn tại' });
      if (!contact.zaloUid) {
        return reply
          .status(400)
          .send({ error: 'Khách hàng chưa được sync từ Zalo (chưa có zaloUid)' });
      }

      // Permission gate: members need 'chat' permission on the Zalo account
      if (!['owner', 'admin'].includes(user.role)) {
        const access = await prisma.zaloAccountAccess.findFirst({
          where: { zaloAccountId: accountId, userId: user.id },
        });
        const level = access?.permission;
        if (level !== 'chat' && level !== 'admin') {
          return reply
            .status(403)
            .send({ error: 'Không có quyền chat trên tài khoản Zalo này' });
        }
      }

      // Idempotent: return existing conversation if one already exists
      const existing = await prisma.conversation.findFirst({
        where: { zaloAccountId: accountId, externalThreadId: contact.zaloUid },
        include: {
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
        },
      });
      if (existing) {
        return reply.status(200).send({ ...existing, messages: [] });
      }

      const created = await prisma.conversation.create({
        data: {
          id: randomUUID(),
          orgId: user.orgId,
          zaloAccountId: accountId,
          contactId: contact.id,
          threadType: 'user',
          externalThreadId: contact.zaloUid,
          lastMessageAt: null,
        },
        include: {
          contact: { select: { id: true, fullName: true, phone: true, avatarUrl: true, zaloUid: true } },
          zaloAccount: { select: { id: true, displayName: true, zaloUid: true } },
        },
      });

      logger.info(
        `[chat] User ${user.id} created conversation ${created.id} with contact ${contact.id}`,
      );
      return reply.status(201).send({ ...created, messages: [] });
    },
  );
}
