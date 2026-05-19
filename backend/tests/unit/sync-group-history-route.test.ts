import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createPrismaMock, type PrismaMock } from '../helpers/prisma-mock.js';

const prismaMock: PrismaMock = createPrismaMock();
const processZaloMessageMock = vi.fn();
const zaloPoolMock = {
  getInstance: vi.fn(),
};

vi.mock('../../src/shared/database/prisma-client.js', () => ({ prisma: prismaMock }));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: zaloPoolMock }));
vi.mock('../../src/modules/zalo/zalo-message-helpers.js', () => ({
  processZaloMessage: processZaloMessageMock,
}));

// Stub auth middleware so we can inject a fake user
vi.mock('../../src/modules/auth/auth-middleware.js', () => ({
  authMiddleware: async (request: any) => {
    if (!request.user) request.user = { id: 'u1', orgId: 'org-1', role: 'admin' };
  },
}));

const { zaloSyncRoutes } = await import('../../src/modules/zalo/zalo-sync-routes.js');

async function buildApp(userOverride?: { id: string; orgId: string; role: string }): Promise<FastifyInstance> {
  const app = Fastify();
  if (userOverride) {
    app.addHook('onRequest', async (req: any) => {
      req.user = userOverride;
    });
  }
  await app.register(zaloSyncRoutes);
  return app;
}

const ACCOUNT_ID = 'acc-123';

describe('POST /api/v1/zalo-accounts/:id/sync-group-history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.zaloAccount.findFirst.mockResolvedValue({ id: ACCOUNT_ID });
  });

  it('rejects count > 200 with 400 (AC-0005)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { count: 500 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/count must be between 1 and 200/);
    await app.close();
  });

  it('rejects count < 1 with 400', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { count: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects member role with 403 (AC-0006)', async () => {
    const app = await buildApp({ id: 'u', orgId: 'org-1', role: 'member' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { count: 10 },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 404 when account does not belong to org', async () => {
    prismaMock.zaloAccount.findFirst.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { groupId: 'g1', count: 10 },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.payload).error).toBe('Account not found');
    await app.close();
  });

  it('returns 400 when zalo account is not connected', async () => {
    zaloPoolMock.getInstance.mockReturnValue({ api: null });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { groupId: 'g1', count: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/not connected/);
    await app.close();
  });

  it('syncs a single group: counts inserted vs skipped correctly', async () => {
    const fakeApi = {
      getGroupChatHistory: vi.fn().mockResolvedValue({
        groupMsgs: [
          { data: { msgId: 'm1' } },
          { data: { msgId: 'm2' } },
          { data: { msgId: 'm3' } },
        ],
      }),
    };
    zaloPoolMock.getInstance.mockReturnValue({ api: fakeApi });

    // 2 inserted, 1 deduped
    processZaloMessageMock
      .mockResolvedValueOnce({ message: {}, conversationId: 'c', orgId: 'o', contactId: null })
      .mockResolvedValueOnce({ message: {}, conversationId: 'c', orgId: 'o', contactId: null })
      .mockResolvedValueOnce(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { groupId: 'g1', count: 50 },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.totalInserted).toBe(2);
    expect(body.totalSkipped).toBe(1);
    expect(body.synced).toHaveLength(1);
    expect(body.synced[0].groupId).toBe('g1');
    expect(fakeApi.getGroupChatHistory).toHaveBeenCalledWith('g1', 50);
    await app.close();
  });

  it('uses default count of 50 when count is omitted', async () => {
    const fakeApi = {
      getGroupChatHistory: vi.fn().mockResolvedValue({ groupMsgs: [] }),
    };
    zaloPoolMock.getInstance.mockReturnValue({ api: fakeApi });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { groupId: 'g1' },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeApi.getGroupChatHistory).toHaveBeenCalledWith('g1', 50);
    await app.close();
  });

  it('iterates all groups when groupId is omitted', async () => {
    const fakeApi = {
      getAllGroups: vi.fn().mockResolvedValue({
        gridVerMap: { 'grp-a': 1, 'grp-b': 1 },
      }),
      getGroupChatHistory: vi.fn().mockResolvedValue({ groupMsgs: [] }),
    };
    zaloPoolMock.getInstance.mockReturnValue({ api: fakeApi });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/zalo-accounts/${ACCOUNT_ID}/sync-group-history`,
      payload: { count: 10 },
    });
    expect(res.statusCode).toBe(200);
    expect(fakeApi.getAllGroups).toHaveBeenCalled();
    expect(fakeApi.getGroupChatHistory).toHaveBeenCalledTimes(2);
    expect(fakeApi.getGroupChatHistory.mock.calls[0][0]).toBe('grp-a');
    expect(fakeApi.getGroupChatHistory.mock.calls[1][0]).toBe('grp-b');
    const body = JSON.parse(res.payload);
    expect(body.synced).toHaveLength(2);
    await app.close();
  }, 15_000);
});
