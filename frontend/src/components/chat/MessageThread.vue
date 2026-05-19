<template>
  <div
    class="message-thread d-flex flex-column flex-grow-1"
    style="height: 100%; position: relative;"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- Drag-over overlay -->
    <div v-if="isDragging" class="drag-overlay">
      <v-icon icon="mdi-cloud-upload-outline" size="64" color="primary" />
      <p class="text-h6 mt-2">Thả file để gửi</p>
    </div>

    <!-- Empty state -->
    <div v-if="!conversation" class="d-flex align-center justify-center flex-grow-1">
      <div class="text-center text-grey">
        <v-icon icon="mdi-chat-outline" size="96" color="grey-lighten-2" />
        <p class="text-h6 mt-4">Chọn cuộc trò chuyện</p>
      </div>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="pa-3 d-flex align-center" style="border-bottom: 1px solid var(--border-glow, rgba(0,242,255,0.1));">
        <v-avatar size="36" color="grey-lighten-2" class="mr-3">
          <v-icon v-if="conversation.threadType === 'group'" icon="mdi-account-group" />
          <v-img v-else-if="conversation.contact?.avatarUrl" :src="conversation.contact.avatarUrl" />
          <v-icon v-else icon="mdi-account" />
        </v-avatar>
        <div class="flex-grow-1">
          <div class="font-weight-medium">{{ conversation.contact?.fullName || 'Unknown' }}</div>
          <div class="text-caption text-grey">{{ conversation.zaloAccount?.displayName || 'Zalo' }}</div>
        </div>
        <v-btn
          :icon="showContactPanel ? 'mdi-account-details' : 'mdi-account-details-outline'"
          size="small" variant="text"
          :color="showContactPanel ? 'primary' : undefined"
          @click="$emit('toggle-contact-panel')"
        />
      </div>

      <!-- Messages -->
      <div ref="messagesContainer" class="flex-grow-1 overflow-y-auto pa-3 chat-messages-area">
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-2" />
        <div v-for="msg in messages" :key="msg.id" class="mb-2 d-flex" :class="msg.senderType === 'self' ? 'justify-end' : 'justify-start'">
          <div style="max-width: 70%;">
            <div v-if="conversation.threadType === 'group' && msg.senderType !== 'self'" class="text-caption mb-1" style="color: #00F2FF; font-weight: 500;">
              {{ msg.senderName || 'Unknown' }}
            </div>
            <div class="message-bubble pa-2 px-3 rounded-lg" :class="msg.senderType === 'self' ? 'bg-primary text-white' : 'bg-white'" style="word-wrap: break-word;">
              <!-- Deleted -->
              <div v-if="msg.isDeleted" class="text-decoration-line-through font-italic" style="opacity: 0.6;">
                {{ msg.content || '(tin nhắn)' }}<span class="text-caption"> (đã thu hồi)</span>
              </div>
              <!-- Image -->
              <div v-else-if="getImageUrl(msg)">
                <img :src="getImageUrl(msg)!" alt="Hình ảnh" class="chat-image" @click="previewImageUrl = getImageUrl(msg)!" />
              </div>
              <!-- File/PDF -->
              <div v-else-if="getFileInfo(msg)" class="file-card">
                <v-icon size="20" class="mr-2" color="info">mdi-file-document-outline</v-icon>
                <div class="flex-grow-1">
                  <div class="text-body-2 font-weight-medium">{{ getFileInfo(msg)!.name }}</div>
                  <div class="text-caption" style="opacity: 0.6;">{{ getFileInfo(msg)!.size }}</div>
                </div>
                <v-btn v-if="getFileInfo(msg)!.href" icon size="x-small" variant="text" @click="openFile(getFileInfo(msg)!.href)">
                  <v-icon size="16">mdi-download</v-icon>
                </v-btn>
              </div>
              <!-- Sticker/Video/Voice/GIF -->
              <div v-else-if="msg.contentType === 'sticker'">🏷️ Sticker</div>
              <div v-else-if="msg.contentType === 'video'">🎥 Video</div>
              <div v-else-if="msg.contentType === 'voice'">🎤 Tin nhắn thoại</div>
              <div v-else-if="msg.contentType === 'gif'">GIF</div>
              <!-- Reminder/Calendar -->
              <div v-else-if="isReminderMessage(msg)" class="reminder-card">
                <div class="d-flex align-center mb-1">
                  <v-icon size="16" color="warning" class="mr-1">mdi-calendar-clock</v-icon>
                  <span class="text-caption font-weight-bold" style="color: #FFB74D;">Nhắc hẹn</span>
                </div>
                <div class="text-body-2">{{ getReminderTitle(msg) }}</div>
                <div v-if="getReminderTime(msg)" class="text-caption mt-1" style="opacity: 0.7;">
                  <v-icon size="12" class="mr-1">mdi-clock-outline</v-icon>{{ getReminderTime(msg) }}
                </div>
                <v-btn size="x-small" variant="tonal" color="warning" class="mt-2" prepend-icon="mdi-calendar-sync" @click="syncAppointment(msg)">
                  Đồng bộ lịch
                </v-btn>
              </div>
              <!-- Default text -->
              <div v-else>{{ parseDisplayContent(msg.content) }}</div>
              <!-- Timestamp -->
              <div class="text-caption mt-1 msg-time" :class="msg.senderType === 'self' ? 'msg-time-self' : 'msg-time-contact'" style="font-size: 0.7rem;">
                {{ formatMessageTime(msg.sentAt) }}
              </div>
            </div>
          </div>
        </div>
        <div v-if="!loading && messages.length === 0" class="text-center pa-8 text-grey">Chưa có tin nhắn</div>
      </div>

      <!-- Pending attachment preview -->
      <div v-if="pendingFile" class="pa-2 pb-0">
        <v-card variant="outlined" class="pa-2 d-flex align-center">
          <img v-if="pendingPreviewUrl" :src="pendingPreviewUrl" alt="preview" class="attachment-thumb mr-3" />
          <v-icon v-else size="32" class="mr-3" color="info">mdi-file-document-outline</v-icon>
          <div class="flex-grow-1">
            <div class="text-body-2 font-weight-medium text-truncate" style="max-width: 320px;">{{ pendingFile.name }}</div>
            <div class="text-caption text-grey">{{ formatBytes(pendingFile.size) }}</div>
          </div>
          <v-btn icon size="small" variant="text" @click="clearPending" :disabled="sending">
            <v-icon>mdi-close</v-icon>
          </v-btn>
        </v-card>
      </div>

      <!-- Input -->
      <div class="pa-2 d-flex align-end chat-input-area">
        <v-btn
          icon size="small" variant="text" class="mr-1"
          title="Đính kèm ảnh hoặc file"
          :disabled="sending"
          @click="openFilePicker"
        ><v-icon>mdi-paperclip</v-icon></v-btn>
        <input
          ref="fileInputEl"
          type="file"
          :accept="ACCEPTED_TYPES"
          style="display: none"
          @change="onFilePicked"
        />
        <v-textarea
          v-model="inputText"
          :placeholder="pendingFile ? 'Thêm ghi chú (tuỳ chọn)...' : 'Nhập tin nhắn...'"
          variant="solo-filled" density="compact" hide-details auto-grow rows="1" max-rows="3"
          @keydown.enter.exact.prevent="handleSend"
          class="flex-grow-1 mr-2"
        />
        <v-btn
          icon color="primary"
          :loading="sending"
          :disabled="!inputText.trim() && !pendingFile"
          @click="handleSend"
        ><v-icon>mdi-send</v-icon></v-btn>
      </div>
    </template>

    <!-- Image preview dialog -->
    <v-dialog v-model="showImagePreview" max-width="900" content-class="elevation-0">
      <div class="text-center" @click="showImagePreview = false" style="cursor: pointer;">
        <img :src="previewImageUrl" alt="Preview" style="max-width: 100%; max-height: 85vh; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);" />
        <div class="text-caption mt-2" style="color: #aaa;">Nhấn để đóng</div>
      </div>
    </v-dialog>

    <!-- Sync snackbar -->
    <v-snackbar v-model="syncSnack.show" :color="syncSnack.color" timeout="3000">{{ syncSnack.text }}</v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue';
import type { Conversation, Message } from '@/composables/use-chat';
import { api } from '@/api/index';

const props = defineProps<{
  conversation: Conversation | null;
  messages: Message[];
  loading: boolean;
  sending: boolean;
  showContactPanel?: boolean;
}>();

const emit = defineEmits<{
  send: [content: string];
  'send-attachment': [file: File];
  'toggle-contact-panel': [];
}>();

const inputText = ref('');
const messagesContainer = ref<HTMLElement | null>(null);
const previewImageUrl = ref('');
const showImagePreview = computed({ get: () => !!previewImageUrl.value, set: (v) => { if (!v) previewImageUrl.value = ''; } });
const syncSnack = ref({ show: false, text: '', color: 'success' });

// ── Attachment upload state (feature 0003) ───────────────────────────────────
const ACCEPTED_TYPES =
  'image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv,application/zip';
const ACCEPTED_TYPES_SET = new Set(ACCEPTED_TYPES.split(','));
const MAX_FILE_SIZE = 20 * 1024 * 1024;

const fileInputEl = ref<HTMLInputElement | null>(null);
const pendingFile = ref<File | null>(null);
const pendingPreviewUrl = ref<string | null>(null);
const isDragging = ref(false);
let dragDepth = 0;

function openFilePicker() {
  fileInputEl.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  if (f) acceptFile(f);
  input.value = ''; // reset so picking the same file twice still fires
}

function acceptFile(file: File) {
  if (!ACCEPTED_TYPES_SET.has(file.type)) {
    syncSnack.value = { show: true, text: `Không hỗ trợ loại tệp: ${file.type || 'unknown'}`, color: 'error' };
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    syncSnack.value = { show: true, text: 'File quá lớn (tối đa 20MB)', color: 'error' };
    return;
  }
  pendingFile.value = file;
  if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
  pendingPreviewUrl.value = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
}

function clearPending() {
  if (pendingPreviewUrl.value) URL.revokeObjectURL(pendingPreviewUrl.value);
  pendingFile.value = null;
  pendingPreviewUrl.value = null;
}

function onDragEnter(e: DragEvent) {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  isDragging.value = true;
}
function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) isDragging.value = false;
}
function onDrop(e: DragEvent) {
  dragDepth = 0;
  isDragging.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) acceptFile(f);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function handleSend() {
  // Attachment path takes precedence — text caption can be sent separately afterwards
  if (pendingFile.value) {
    emit('send-attachment', pendingFile.value);
    clearPending();
    return;
  }
  if (!inputText.value.trim()) return;
  emit('send', inputText.value);
  inputText.value = '';
}
function formatMessageTime(d: string) { return new Date(d).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); }
function openFile(url: string) { window.open(url, '_blank'); }

/** Extract image URL from JSON content */
function getImageUrl(msg: Message): string | null {
  if (msg.contentType === 'image' && msg.content) {
    if (msg.content.startsWith('http')) return msg.content;
    try { const p = JSON.parse(msg.content); return p.href || p.thumb || p.hdUrl || null; } catch {}
  }
  if (msg.content?.startsWith('{')) {
    try {
      const p = JSON.parse(msg.content);
      const href = p.href || p.thumb || '';
      if (href && /\.(jpg|jpeg|png|webp|gif)/i.test(href)) return href;
      if (href && href.includes('zdn.vn') && !p.params?.includes('fileExt')) return href;
    } catch {}
  }
  return null;
}

/** Extract file info from JSON content (PDF, docs, etc.) */
function getFileInfo(msg: Message): { name: string; size: string; href: string } | null {
  if (!msg.content?.startsWith('{')) return null;
  try {
    const p = JSON.parse(msg.content);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    if (params?.fileExt || params?.fType === 1) {
      const bytes = parseInt(params.fileSize || '0');
      const size = bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
      return { name: p.title || `file.${params.fileExt || 'unknown'}`, size, href: p.href || '' };
    }
  } catch {}
  return null;
}

function parseDisplayContent(content: string | null): string {
  if (!content) return '';
  if (!content.startsWith('{')) return content;
  try {
    const p = JSON.parse(content);
    if (p.title && p.href) return `🔗 ${p.title}`;
    if (p.title) return p.title;
    if (p.href) return `🔗 ${p.description || p.href}`;
    return content;
  } catch { return content; }
}

function isReminderMessage(msg: Message): boolean {
  if (!msg.content) return false;
  try { const p = JSON.parse(msg.content); return p.action === 'msginfo.actionlist'; } catch { return false; }
}

function getReminderTitle(msg: Message): string {
  try { return JSON.parse(msg.content!).title || ''; } catch { return msg.content || ''; }
}

function getReminderTime(msg: Message): string | null {
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) return new Date(h.ts).toLocaleString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
  } catch {}
  return null;
}

/** Sync Zalo reminder to CRM appointments via API */
async function syncAppointment(msg: Message) {
  if (!props.conversation?.contact?.id) { syncSnack.value = { show: true, text: 'Không có thông tin khách hàng', color: 'error' }; return; }
  try {
    const p = JSON.parse(msg.content!);
    const params = typeof p.params === 'string' ? JSON.parse(p.params) : p.params;
    let appointmentDate: string | null = null;
    for (const h of (params?.highLightsV2 || [])) {
      if (h.ts > 1e12) { appointmentDate = new Date(h.ts).toISOString(); break; }
    }
    if (!appointmentDate) { syncSnack.value = { show: true, text: 'Không tìm thấy thời gian hẹn', color: 'warning' }; return; }
    await api.post('/appointments', {
      contactId: props.conversation.contact.id,
      appointmentDate,
      appointmentTime: new Date(appointmentDate).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
      type: 'tai_kham',
      notes: `[Zalo] ${p.title || ''}`,
    });
    syncSnack.value = { show: true, text: 'Đã đồng bộ lịch hẹn thành công!', color: 'success' };
  } catch (err: any) {
    syncSnack.value = { show: true, text: err.response?.data?.error || 'Đồng bộ thất bại', color: 'error' };
  }
}

watch(() => props.messages.length, async () => { await nextTick(); if (messagesContainer.value) messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight; });
</script>

<style scoped>
.message-bubble { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1); }
.reminder-card { padding: 8px 12px; border-left: 3px solid #FFB74D; border-radius: 8px; background: rgba(255, 183, 77, 0.08); }
.file-card { display: flex; align-items: center; padding: 8px 12px; border-radius: 8px; background: rgba(0, 242, 255, 0.05); border: 1px solid rgba(0, 242, 255, 0.1); }
.chat-image { max-width: 100%; max-height: 300px; border-radius: 12px; cursor: pointer; transition: transform 0.2s; }
.chat-image:hover { transform: scale(1.02); }
.attachment-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 8px;
}
.drag-overlay {
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(0, 242, 255, 0.12);
  border: 2px dashed rgba(0, 242, 255, 0.55);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  color: #00F2FF;
}
</style>
