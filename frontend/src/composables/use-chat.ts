import { ref, computed } from 'vue';
import { api } from '@/api/index';
import { io, Socket } from 'socket.io-client';
import type { Contact } from '@/composables/use-contacts';

interface ZaloAccount {
  id: string;
  displayName: string | null;
}

interface ConversationMessage {
  content: string | null;
  contentType: string;
  senderType: string;
  sentAt: string;
  isDeleted: boolean;
}

export interface Conversation {
  id: string;
  threadType: 'user' | 'group';
  contact: Contact | null;
  zaloAccount: ZaloAccount | null;
  lastMessageAt: string | null;
  unreadCount: number;
  isReplied: boolean;
  messages?: ConversationMessage[];
}

export interface Message {
  id: string;
  content: string | null;
  contentType: string;
  senderType: string;
  senderName: string | null;
  sentAt: string;
  isDeleted: boolean;
  zaloMsgId: string | null;
}

export function useChat() {
  const conversations = ref<Conversation[]>([]);
  const selectedConvId = ref<string | null>(null);
  const messages = ref<Message[]>([]);
  const loadingConvs = ref(false);
  const loadingMsgs = ref(false);
  const sendingMsg = ref(false);
  const searchQuery = ref('');
  const accountFilter = ref<string | null>(null);
  let socket: Socket | null = null;

  const selectedConv = computed(() =>
    conversations.value.find(c => c.id === selectedConvId.value) || null,
  );

  async function fetchConversations() {
    loadingConvs.value = true;
    try {
      const res = await api.get('/conversations', {
        params: { limit: 100, search: searchQuery.value, accountId: accountFilter.value || undefined },
      });
      conversations.value = res.data.conversations;
    } catch (err) {
      console.error('Failed to fetch conversations:', err);
    } finally {
      loadingConvs.value = false;
    }
  }

  async function selectConversation(convId: string) {
    selectedConvId.value = convId;
    await fetchMessages(convId);
    // Fetch full conversation detail to populate contact CRM fields
    try {
      const convDetail = await api.get(`/conversations/${convId}`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv && convDetail.data.contact) {
        conv.contact = convDetail.data.contact;
      }
    } catch {
      // Non-critical — panel will show partial data from list
    }
    // Mark as read
    try {
      await api.post(`/conversations/${convId}/mark-read`);
      const conv = conversations.value.find(c => c.id === convId);
      if (conv) conv.unreadCount = 0;
    } catch {
      // Ignore mark-read errors
    }
  }

  async function fetchMessages(convId: string) {
    loadingMsgs.value = true;
    try {
      const res = await api.get(`/conversations/${convId}/messages`, {
        params: { limit: 100 },
      });
      messages.value = res.data.messages;
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    } finally {
      loadingMsgs.value = false;
    }
  }

  async function sendMessage(content: string) {
    if (!selectedConvId.value || !content.trim()) return;
    sendingMsg.value = true;
    try {
      const res = await api.post(`/conversations/${selectedConvId.value}/messages`, { content });
      messages.value.push(res.data);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      sendingMsg.value = false;
    }
  }

  /**
   * Upload a file via multipart and have the backend forward it to Zalo.
   * Returns the persisted Message on success, or an error string.
   * Feature 0003.
   */
  async function sendAttachment(file: File): Promise<{ ok: true; message: Message } | { ok: false; error: string }> {
    if (!selectedConvId.value) return { ok: false, error: 'Chưa chọn cuộc trò chuyện' };
    sendingMsg.value = true;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await api.post(
        `/conversations/${selectedConvId.value}/attachments`,
        form,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      messages.value.push(res.data);
      return { ok: true, message: res.data };
    } catch (err: any) {
      const error = err.response?.data?.error || err.message || 'Gửi file thất bại';
      console.error('Failed to send attachment:', error);
      return { ok: false, error };
    } finally {
      sendingMsg.value = false;
    }
  }

  function initSocket() {
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('chat:message', (data: { message: Message; conversationId: string }) => {
      // Add to messages if viewing this conversation
      if (data.conversationId === selectedConvId.value) {
        // Avoid duplicates
        if (!messages.value.find(m => m.id === data.message.id)) {
          messages.value.push(data.message);
        }
      }
      // Refresh conversation list to update last message / unread count
      fetchConversations();
    });

    socket.on('chat:deleted', (data: { msgId: string }) => {
      const msg = messages.value.find(m => m.zaloMsgId === data.msgId);
      if (msg) {
        msg.isDeleted = true;
      }
    });
  }

  function destroySocket() {
    socket?.disconnect();
    socket = null;
  }

  /**
   * Create (or reuse) a conversation with a contact. Used by the "+ New chat"
   * dialog. Pushes the conversation to the head of the list and auto-selects
   * it. Returns the conversation id so callers can react.
   */
  async function createConversation(accountId: string, contactId: string): Promise<string | null> {
    try {
      const res = await api.post('/conversations', { accountId, contactId });
      const conv = res.data as Conversation;

      // De-dupe in the local list (idempotent endpoint may return existing)
      const idx = conversations.value.findIndex(c => c.id === conv.id);
      if (idx >= 0) {
        conversations.value.splice(idx, 1);
      }
      conversations.value.unshift(conv);

      await selectConversation(conv.id);
      return conv.id;
    } catch (err) {
      console.error('Failed to create conversation:', err);
      return null;
    }
  }

  return {
    conversations,
    selectedConvId,
    selectedConv,
    messages,
    loadingConvs,
    loadingMsgs,
    sendingMsg,
    searchQuery,
    accountFilter,
    fetchConversations,
    selectConversation,
    sendMessage,
    sendAttachment,
    createConversation,
    initSocket,
    destroySocket,
  };
}
