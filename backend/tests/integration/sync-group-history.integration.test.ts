/**
 * Integration test: POST /api/v1/zalo-accounts/:id/sync-group-history
 * Full HTTP roundtrip with a real Fastify instance + real Postgres,
 * mocking only the zca-js api boundary.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;
const fakeApi = {
  getGroupChatHistory: vi.fn(),
  getAllGroups: vi.fn(),
  getUserInfo: vi.fn().mockResolvedValue({}),
  getGroupInfo: vi.fn().mockResolvedValue({ gridInfoMap: {} }),
};

const zaloPoolMock = {
  getInstance: vi.fn(() => ({ api: fakeApi })),
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
  const org = await prisma.organization.create({ data: { name: 'IT Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${Date.now()}@test.local`,
      passwordHash: 'h',
      fullName: 'Admin',
      role: 'admin',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected' },
  });
  return { org, user, account };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { zaloSyncRoutes } = await import('../../src/modules/zalo/zalo-sync-routes.js');
  await app.register(zaloSyncRoutes);
  return app;
}

function makeZaloMessage(msgId: string, content = 'hi'): any {
  return {
    type: 1,
    threadId: 'grp-1',
    isSelf: false,
    data: {
      msgId,
      uidFrom: 'uid-sender',
      dName: 'Sender',
      content,
      msgType: 'webchat',
      ts: String(Date.now()),
    },
  };
}

describe('POST .../sync-group-history (integration)', () => {
  let app: FastifyInstance;
  let accountId: string;
  let orgId: string;

  beforeEach(async () => {
    await resetDb(prisma);
    vi.clearAllMocks();
    zaloPoolMock.getInstance.mockReturnValue({ api: fakeApi });

    const { org, user, account } = await seed();
    accountId = account.id;
    orgId = org.id;
    app = await buildApp({ id: user.id, orgId, role: 'admin' });
  });

  it('AC-0003: first sync inserts new messages and counts skipped existing ones', async () => {
    // Pre-insert 1 existing message with the same zaloMsgId
    const contact = await prisma.contact.create({
      data: { orgId, zaloUid: 'grp-1', fullName: 'Team Sale', metadata: { isGroup: true } },
    });
    const conv = await prisma.conversation.create({
      data: {
        orgId,
        zaloAccountId: accountId,
        contactId: contact.id,
        threadType: 'group',
        externalThreadId: 'grp-1',
      },
    });
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        zaloMsgId: 'mid-existing',
        senderType: 'contact',
        senderUid: 'uid-x',
        content: 'old',
        contentType: 'text',
        sentAt: new Date(),
      },
    });

    fakeApi.getGroupChatHistory.mockResolvedValueOnce({
      groupMsgs: [
        makeZaloMessage('mid-existing', 'old'),
        makeZaloMessage('mid-new-1', 'new-1'),
        makeZaloMessage('mid-new-2', 'new-2'),
      ],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountId}/sync-group-history`,
      payload: { groupId: 'grp-1', count: 50 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.totalInserted).toBe(2);
    expect(body.totalSkipped).toBe(1);

    const all = await prisma.message.findMany({ orderBy: { sentAt: 'asc' } });
    expect(all).toHaveLength(3);
    const ids = all.map((m) => m.zaloMsgId).sort();
    expect(ids).toEqual(['mid-existing', 'mid-new-1', 'mid-new-2']);

    await app.close();
  });

  it('AC-0004: second sync with the same data inserts zero new rows', async () => {
    fakeApi.getGroupChatHistory.mockResolvedValue({
      groupMsgs: [makeZaloMessage('mid-1'), makeZaloMessage('mid-2')],
    });

    const r1 = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountId}/sync-group-history`,
      payload: { groupId: 'grp-1', count: 50 },
    });
    expect(JSON.parse(r1.payload).totalInserted).toBe(2);

    const r2 = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountId}/sync-group-history`,
      payload: { groupId: 'grp-1', count: 50 },
    });
    expect(r2.statusCode).toBe(200);
    const body2 = JSON.parse(r2.payload);
    expect(body2.totalInserted).toBe(0);
    expect(body2.totalSkipped).toBe(2);

    expect(await prisma.message.count()).toBe(2);
    await app.close();
  });

  it('AC-0005: rejects count > 200 without touching the api', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountId}/sync-group-history`,
      payload: { count: 500 },
    });
    expect(res.statusCode).toBe(400);
    expect(fakeApi.getGroupChatHistory).not.toHaveBeenCalled();
    await app.close();
  });

  it('AC-0006: rejects member role with 403', async () => {
    const memberApp = await buildApp({ id: 'm-user', orgId, role: 'member' });
    const res = await memberApp.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountId}/sync-group-history`,
      payload: { count: 10 },
    });
    expect(res.statusCode).toBe(403);
    await memberApp.close();
    await app.close();
  });

  it('returns 400 when zalo account is not connected (no api)', async () => {
    zaloPoolMock.getInstance.mockReturnValue({ api: null });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${accountId}/sync-group-history`,
      payload: { groupId: 'grp-1', count: 10 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
