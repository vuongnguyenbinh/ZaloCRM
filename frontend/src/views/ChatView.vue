<template>
  <div class="chat-container d-flex" style="height: calc(100vh - 64px);">
    <!-- Conversation list — resizable -->
    <div class="chat-panel-left" :style="{ width: leftWidth + 'px' }">
      <ConversationList
        :conversations="conversations"
        :selected-id="selectedConvId"
        :loading="loadingConvs"
        v-model:search="searchQuery"
        @select="selectConversation"
        @filter-account="onFilterAccount"
        @new-chat="showNewChatDialog = true"
      />
      <!-- Resize handle -->
      <div class="resize-handle" @mousedown="startResize('left', $event)" />
    </div>

    <!-- Message thread — flexible center -->
    <MessageThread
      :conversation="selectedConv"
      :messages="messages"
      :loading="loadingMsgs"
      :sending="sendingMsg"
      @send="sendMessage"
      @send-attachment="onSendAttachment"
      @toggle-contact-panel="showContactPanel = !showContactPanel"
      :show-contact-panel="showContactPanel"
      style="flex: 1; min-width: 300px;"
    />

    <!-- Contact panel — resizable -->
    <div v-if="showContactPanel && selectedConv?.contact" class="chat-panel-right" :style="{ width: rightWidth + 'px' }">
      <div class="resize-handle resize-handle-left" @mousedown="startResize('right', $event)" />
      <ChatContactPanel
        :contact-id="selectedConv.contact.id"
        :contact="selectedConv.contact"
        @close="showContactPanel = false"
        @saved="fetchConversations()"
      />
    </div>

    <!-- New chat dialog -->
    <NewChatDialog
      v-model="showNewChatDialog"
      @created="onCreateConversation"
    />

    <!-- Attachment upload error toast -->
    <v-snackbar v-model="attachmentToast.show" :color="attachmentToast.color" timeout="4000">
      {{ attachmentToast.text }}
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import ConversationList from '@/components/chat/ConversationList.vue';
import MessageThread from '@/components/chat/MessageThread.vue';
import ChatContactPanel from '@/components/chat/ChatContactPanel.vue';
import NewChatDialog from '@/components/chat/NewChatDialog.vue';
import { useChat } from '@/composables/use-chat';

const {
  conversations, selectedConvId, selectedConv, messages,
  loadingConvs, loadingMsgs, sendingMsg, searchQuery, accountFilter,
  fetchConversations, selectConversation, sendMessage, sendAttachment, createConversation,
  initSocket, destroySocket,
} = useChat();

const attachmentToast = ref<{ show: boolean; text: string; color: string }>({
  show: false, text: '', color: 'success',
});

async function onSendAttachment(file: File) {
  const result = await sendAttachment(file);
  if (!result.ok) {
    attachmentToast.value = { show: true, text: result.error, color: 'error' };
  }
}

function onFilterAccount(id: string | null) {
  accountFilter.value = id;
  fetchConversations();
}

const showContactPanel = ref(false);
const showNewChatDialog = ref(false);

async function onCreateConversation(params: { accountId: string; contactId: string }) {
  await createConversation(params.accountId, params.contactId);
}

// Resizable panel widths (restored from localStorage)
const leftWidth = ref(parseInt(localStorage.getItem('chat-left-width') || '320'));
const rightWidth = ref(parseInt(localStorage.getItem('chat-right-width') || '320'));

let resizing: 'left' | 'right' | null = null;
let startX = 0;
let startWidth = 0;

function startResize(panel: 'left' | 'right', e: MouseEvent) {
  resizing = panel;
  startX = e.clientX;
  startWidth = panel === 'left' ? leftWidth.value : rightWidth.value;
  document.addEventListener('mousemove', onResize);
  document.addEventListener('mouseup', stopResize);
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function onResize(e: MouseEvent) {
  if (!resizing) return;
  const diff = e.clientX - startX;
  if (resizing === 'left') {
    leftWidth.value = Math.max(200, Math.min(500, startWidth + diff));
  } else {
    rightWidth.value = Math.max(250, Math.min(500, startWidth - diff));
  }
}

function stopResize() {
  if (resizing) {
    localStorage.setItem('chat-left-width', String(leftWidth.value));
    localStorage.setItem('chat-right-width', String(rightWidth.value));
  }
  resizing = null;
  document.removeEventListener('mousemove', onResize);
  document.removeEventListener('mouseup', stopResize);
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onMounted(() => { fetchConversations(); initSocket(); });
onUnmounted(() => { destroySocket(); });

let searchTimeout: ReturnType<typeof setTimeout>;
watch(searchQuery, () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchConversations(), 300);
});
</script>

<style scoped>
.chat-container {
  margin: -12px;
}

.chat-panel-left {
  position: relative;
  flex-shrink: 0;
  min-width: 200px;
  max-width: 500px;
}

.chat-panel-right {
  position: relative;
  flex-shrink: 0;
  min-width: 250px;
  max-width: 500px;
}

/* Resize handle — thin vertical line on the edge */
.resize-handle {
  position: absolute;
  top: 0;
  right: -2px;
  width: 5px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
  background: transparent;
  transition: background 0.2s;
}

.resize-handle:hover,
.resize-handle:active {
  background: rgba(0, 242, 255, 0.3);
}

.resize-handle-left {
  right: auto;
  left: -2px;
}
</style>
