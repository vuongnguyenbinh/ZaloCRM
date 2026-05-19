/**
 * Integration test: POST /api/v1/conversations — feature 0002.
 * Real Postgres via testcontainers + Fastify inject for the HTTP boundary.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { setupDb, teardownDb, resetDb } from './setup-db.js';

let prisma: PrismaClient;

vi.mock('../../src/shared/database/prisma-client.js', async () => ({
  get prisma() {
    return prisma;
  },
}));
vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
  const org = await prisma.organization.create({ data: { name: 'Org' } });
  const user = await prisma.user.create({
    data: {
      orgId: org.id,
      email: `u-${Date.now()}-${Math.random()}@test.local`,
      passwordHash: 'h',
      fullName: 'U',
      role: 'admin',
    },
  });
  const account = await prisma.zaloAccount.create({
    data: { orgId: org.id, ownerUserId: user.id, status: 'connected' },
  });
  const contact = await prisma.contact.create({
    data: {
      orgId: org.id,
      zaloUid: `zalo-uid-${Date.now()}`,
      fullName: 'Khách A',
      phone: '0901234567',
    },
  });
  return { org, user, account, contact };
}

async function buildApp(user: { id: string; orgId: string; role: string }) {
  const app = Fastify();
  app.addHook('onRequest', async (req: any) => {
    req.user = user;
  });
  const { chatRoutes } = await import('../../src/modules/chat/chat-routes.js');
  await app.register(chatRoutes);
  return app;
}

describe('POST /api/v1/conversations (integration)', () => {
  beforeEach(async () => {
    await resetDb(prisma);
  });

  it('AC-0001: creates a conversation with valid account + contact', async () => {
    const { org, user, account, contact } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contact.id },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.id).toBeTruthy();
    expect(body.threadType).toBe('user');
    expect(body.externalThreadId).toBe(contact.zaloUid);
    expect(body.contact.id).toBe(contact.id);
    expect(body.zaloAccount.id).toBe(account.id);
    expect(body.messages).toEqual([]);

    const dbCount = await prisma.conversation.count();
    expect(dbCount).toBe(1);
    await app.close();
  });

  it('AC-0002: idempotent — second call returns existing conversation with HTTP 200', async () => {
    const { org, user, account, contact } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contact.id },
    });
    expect(r1.statusCode).toBe(201);
    const id1 = JSON.parse(r1.payload).id;

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contact.id },
    });
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.payload).id).toBe(id1);

    expect(await prisma.conversation.count()).toBe(1);
    await app.close();
  });

  it('AC-0003: missing accountId → 400', async () => {
    const { org, user, contact } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { contactId: contact.id },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/bắt buộc/);
    await app.close();
  });

  it('AC-0003: missing contactId → 400', async () => {
    const { org, user, account } = await seed();
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('AC-0004: contact without zaloUid → 400', async () => {
    const { org, user, account } = await seed();
    const contactNoUid = await prisma.contact.create({
      data: { orgId: org.id, fullName: 'No-Sync', zaloUid: null },
    });
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contactNoUid.id },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).error).toMatch(/chưa được sync/);
    await app.close();
  });

  it('AC-0005: member without ZaloAccountAccess → 403', async () => {
    const { org, account, contact } = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contact.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0005: member with read-only access → 403 (needs chat permission)', async () => {
    const { org, account, contact } = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'read' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contact.id },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('AC-0005: member with chat permission → 201', async () => {
    const { org, account, contact } = await seed();
    const member = await prisma.user.create({
      data: {
        orgId: org.id,
        email: `m-${Date.now()}@test.local`,
        passwordHash: 'h',
        fullName: 'Member',
        role: 'member',
      },
    });
    await prisma.zaloAccountAccess.create({
      data: { zaloAccountId: account.id, userId: member.id, permission: 'chat' },
    });
    const app = await buildApp({ id: member.id, orgId: org.id, role: 'member' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: contact.id },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('AC-0006: contact from a different org → 404', async () => {
    const { org, user, account } = await seed();
    const otherOrg = await prisma.organization.create({ data: { name: 'Other' } });
    const otherContact = await prisma.contact.create({
      data: { orgId: otherOrg.id, zaloUid: 'other-uid', fullName: 'Other' },
    });
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: account.id, contactId: otherContact.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('account from a different org → 404', async () => {
    const { org, user, contact } = await seed();
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
    const app = await buildApp({ id: user.id, orgId: org.id, role: 'admin' });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      payload: { accountId: otherAccount.id, contactId: contact.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
