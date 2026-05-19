import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPrismaMock, type PrismaMock } from '../helpers/prisma-mock.js';

const prismaMock: PrismaMock = createPrismaMock();

vi.mock('../../src/shared/database/prisma-client.js', () => ({
  prisma: prismaMock,
}));

vi.mock('../../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/api/webhook-service.js', () => ({
  emitWebhook: vi.fn(),
}));

// Import the SUT *after* mocks are set up
const { handleIncomingMessage } = await import('../../src/modules/chat/message-handler.js');

const ACCOUNT = { orgId: 'org-1', ownerUserId: 'user-1' };

function makeMsg(overrides: Partial<Parameters<typeof handleIncomingMessage>[0]> = {}) {
  return {
    accountId: 'acc-1',
    senderUid: 'uid-sender',
    senderName: 'Test Sender',
    content: 'Hello',
    contentType: 'text',
    msgId: 'zalo-msg-1',
    timestamp: Date.now(),
    isSelf: false,
    threadId: 'uid-sender',
    threadType: 'user' as const,
    attachments: [],
    ...overrides,
  };
}

describe('handleIncomingMessage — dedupe (BR-0001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.zaloAccount.findUnique.mockResolvedValue(ACCOUNT);
    prismaMock.contact.findFirst.mockResolvedValue(null);
    prismaMock.contact.create.mockResolvedValue({ id: 'contact-1', fullName: 'Test Sender' });
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    prismaMock.conversation.create.mockResolvedValue({ id: 'conv-1' });
    prismaMock.conversation.update.mockResolvedValue({});
    prismaMock.message.create.mockResolvedValue({
      id: 'msg-row-1',
      conversationId: 'conv-1',
      zaloMsgId: 'zalo-msg-1',
      content: 'Hello',
      sentAt: new Date(),
    });
  });

  it('inserts the message when zaloMsgId does not exist yet', async () => {
    prismaMock.message.findFirst.mockResolvedValue(null);

    const result = await handleIncomingMessage(makeMsg());

    expect(result).not.toBeNull();
    expect(prismaMock.message.findFirst).toHaveBeenCalledWith({
      where: { zaloMsgId: 'zalo-msg-1' },
      select: { id: true },
    });
    expect(prismaMock.message.create).toHaveBeenCalledOnce();
  });

  it('SKIPS insert when zaloMsgId already exists (dedupe)', async () => {
    prismaMock.message.findFirst.mockResolvedValue({ id: 'existing-row' });

    const result = await handleIncomingMessage(makeMsg());

    expect(result).toBeNull();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
    // Should also short-circuit before touching contacts/conversations
    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.conversation.create).not.toHaveBeenCalled();
  });

  it('does NOT dedupe when msgId is empty (EC-0001)', async () => {
    // No msgId → no dedupe attempt
    prismaMock.message.findFirst.mockResolvedValue(null);

    const result = await handleIncomingMessage(makeMsg({ msgId: '' }));

    expect(result).not.toBeNull();
    // findFirst should not be called when msgId is falsy
    expect(prismaMock.message.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.message.create).toHaveBeenCalledOnce();
  });

  it('returns null when account does not exist', async () => {
    prismaMock.zaloAccount.findUnique.mockResolvedValue(null);

    const result = await handleIncomingMessage(makeMsg());

    expect(result).toBeNull();
    expect(prismaMock.message.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.message.create).not.toHaveBeenCalled();
  });
});

describe('handleIncomingMessage — group thread handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.zaloAccount.findUnique.mockResolvedValue(ACCOUNT);
    prismaMock.message.findFirst.mockResolvedValue(null);
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    prismaMock.conversation.create.mockResolvedValue({ id: 'conv-grp' });
    prismaMock.conversation.update.mockResolvedValue({});
    prismaMock.message.create.mockResolvedValue({
      id: 'msg-grp-1',
      conversationId: 'conv-grp',
      zaloMsgId: 'zalo-msg-grp-1',
      content: 'Hi all',
      sentAt: new Date(),
    });
  });

  it('creates a group "contact" record on first group message', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);
    prismaMock.contact.create.mockResolvedValue({ id: 'group-contact-1', fullName: 'Team Sale' });

    await handleIncomingMessage(
      makeMsg({
        threadType: 'group',
        threadId: 'grp-1',
        groupName: 'Team Sale',
        msgId: 'zalo-msg-grp-1',
      }),
    );

    expect(prismaMock.contact.create).toHaveBeenCalledOnce();
    const createCall = prismaMock.contact.create.mock.calls[0][0];
    expect(createCall.data.zaloUid).toBe('grp-1');
    expect(createCall.data.fullName).toBe('Team Sale');
    expect(createCall.data.metadata).toEqual({ isGroup: true });
  });

  it('does NOT create a contact when isSelf is true on a user thread', async () => {
    prismaMock.contact.findFirst.mockResolvedValue(null);

    await handleIncomingMessage(
      makeMsg({ isSelf: true, threadType: 'user', msgId: 'zalo-self-1' }),
    );

    expect(prismaMock.contact.create).not.toHaveBeenCalled();
    expect(prismaMock.message.create).toHaveBeenCalledOnce();
  });
});
