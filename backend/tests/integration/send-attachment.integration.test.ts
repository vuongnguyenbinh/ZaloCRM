/**
 * Integration test: POST /api/v1/conversations/:id/attachments — feature 0003.
 * Real Postgres + Fastify multipart; mocks zca-js boundary only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

const sendMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: { sendMessage: sendMessageMock } })),
};

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
vi.mock('../../src/modules/zalo/zalo-rate-limiter.js', () => ({
  zaloRateLimiter: {
    checkLimits: vi.fn(() => ({ allowed: true })),
    recordSend: vi.fn(),
  },
}));
vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (req: any) => {
    if (!req.user) req.user = { id: 'test-user', orgId: 'org-stub', role: 'admin' };
  },
}));

beforeAll(async () => {
  prisma = await setupDb();
}, 90_000);

afterAll(async () => {
  await teardownDb();
});

async function seed() {
  const org = await prisma.organization.create({ data: { name: 'Att Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'A',
      role: 'admin',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected', zaloUid: 'self-uid' },
  });
  const contact = await prisma.contact.create({
    data: { orgId: org.id, zaloUid: 'remote-uid', fullName: 'K' },
  });
  const conv = await prisma.conversation.create({
    data: {
      orgId: org.id,
      zaloAccountId: account.id,
      contactId: contact.id,
      threadType: 'user',
      externalThreadId: 'remote-uid',
    },
  });
  return { org, user, account, contact, conv };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  await app.register(fastifyMultipart, {
    limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  });
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

// Build a minimal multipart/form-data body for a single file
function multipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  buffer: Buffer,
): { headers: Record<string, string>; payload: Buffer } {
  const boundary = '----testboundary' + Math.random().toString(16).slice(2);
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const payload = Buffer.concat([head, buffer, tail]);
  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(payload.length),
    },
    payload,
  };
}

const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG magic
  ...Array(100).fill(0xff), // padding so size > 0
]);

describe('POST .../conversations/:id/attachments (integration)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    sendMessageMock.mockResolvedValue({
      message: null,
      attachment: [{ msgId: 999_888 }],
    });
    zaloPoolMock.getInstance.mockReturnValue({ api: { sendMessage: sendMessageMock } });
  });

  it('AC-0001: uploads an image, persists Message with contentType=image and forwards to zca-js', async () => {
    const { org, user, conv } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });

    expect(res.statusCode).toBe(201);
    const msg = JSON.parse(res.payload);
    expect(msg.contentType).toBe('image');
    expect(msg.content).toBe('photo.png');
    expect(msg.zaloMsgId).toBe('999888');
    expect(msg.attachments).toEqual([
      expect.objectContaining({ filename: 'photo.png', mimeType: 'image/png' }),
    ]);

    expect(sendMessageMock).toHaveBeenCalledOnce();
    const [payload, threadId, threadType] = sendMessageMock.mock.calls[0];
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe('photo.png');
    expect(Buffer.isBuffer(payload.attachments[0].data)).toBe(true);
    expect(threadId).toBe('remote-uid');
    expect(threadType).toBe(0);

    const persisted = await prisma.message.findFirst();
    expect(persisted?.contentType).toBe('image');
    await app.close();
  });

  it('AC-0002: PDF upload → contentType=file', async () => {
    const { org, user, conv } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const pdf = Buffer.from('%PDF-1.4 fake content '.repeat(50));
    const body = multipartBody('file', 'report.pdf', 'application/pdf', pdf);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.payload).contentType).toBe('file');
    await app.close();
  });

  it('AC-0004: rejects unknown MIME with 415', async () => {
    const { org, user, conv } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'evil.exe', 'application/x-msdownload', Buffer.alloc(10));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(415);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(await prisma.message.count()).toBe(0);
    await app.close();
  });

  it('AC-0005: rejects missing file with 400', async () => {
    const { org, user, conv } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const boundary = '----empty';
    const payload = Buffer.from(`--${boundary}--\r\n`, 'utf8');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('EC-0001: rejects 0-byte file with 400', async () => {
    const { org, user, conv } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'empty.png', 'image/png', Buffer.alloc(0));

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/rỗng/);
    await app.close();
  });

  it('AC-0006: member without chat permission → 403', async () => {
    const { org, account, conv } = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'M',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(403);
    expect(sendMessageMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 404 when conversation belongs to a different org', async () => {
    const { user } = await seed();
    // Make a conversation in another org
    const otherOrg = await prisma.organization.create({ data: { name: 'O2' } });
    const otherUser = await prisma.user.create({
      data: {
        orgId: otherOrg.id,
        email: `o-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'O',
        role: 'admin',
      },
    });
    const otherAccount = await prisma.zaloAccount.create({
      data: { orgId: otherOrg.id, ownerUserId: otherUser.id, status: 'connected' },
    });
    const otherConv = await prisma.conversation.create({
      data: {
        orgId: otherOrg.id,
        zaloAccountId: otherAccount.id,
        threadType: 'user',
        externalThreadId: 'x',
      },
    });
    const app = await buildApp({ id: user.id, orgId: (await prisma.user.findUnique({ where: { id: user.id } }))!.orgId, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${otherConv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 502 when zca-js sendMessage throws', async () => {
    const { org, user, conv } = await seed();
    sendMessageMock.mockRejectedValueOnce(new Error('zalo timeout'));
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(502);
    expect(await prisma.message.count()).toBe(0); // no message persisted on Zalo failure
    await app.close();
  });

  it('returns 429 when rate limit is hit', async () => {
    const { org, user, conv } = await seed();
    const { zaloRateLimiter } = await import('../../src/modules/zalo/zalo-rate-limiter.js');
    vi.mocked(zaloRateLimiter.checkLimits).mockReturnValueOnce({
      allowed: false,
      reason: 'Đã vượt giới hạn 200 tin/ngày',
    } as any);
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(429);
    expect(sendMessageMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 400 when Zalo account is not connected (no live instance)', async () => {
    const { org, user, conv } = await seed();
    zaloPoolMock.getInstance.mockReturnValueOnce({ api: null });
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });
    const body = multipartBody('file', 'photo.png', 'image/png', FAKE_PNG);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conv.id}/attachments`,
      ...body,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/not connected/);
    await app.close();
  });
});
