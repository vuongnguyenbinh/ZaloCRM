<template>
  <v-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)" max-width="480">
    <v-card>
      <v-card-title>Bắt đầu cuộc trò chuyện mới</v-card-title>
      <v-card-text>
        <v-select
          v-model="accountId"
          :items="accounts"
          item-title="text"
          item-value="value"
          label="Tài khoản Zalo"
          density="compact" variant="outlined"
          :rules="[v => !!v || 'Chọn tài khoản Zalo']"
          class="mb-3"
        />

        <v-autocomplete
          v-model="contactId"
          :items="contacts"
          item-title="text"
          item-value="value"
          label="Khách hàng (đã sync danh bạ)"
          :loading="searchingContacts"
          :search="contactSearch"
          @update:search="onSearchContacts"
          density="compact" variant="outlined"
          no-data-text="Không tìm thấy khách hàng đã sync"
          :rules="[v => !!v || 'Chọn khách hàng']"
          class="mb-2"
        />
        <p class="text-caption text-grey">
          💡 Chỉ hiện khách hàng đã có Zalo UID (đã sync từ danh bạ). Nếu thiếu, vào <strong>Tài khoản Zalo</strong> → bấm 👥 để sync.
        </p>

        <v-alert v-if="error" type="error" density="compact" closable @click:close="error = ''" class="mt-3">
          {{ error }}
        </v-alert>
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn @click="$emit('update:modelValue', false)">Hủy</v-btn>
        <v-btn
          color="primary" :loading="creating"
          :disabled="!accountId || !contactId"
          @click="onSubmit"
        >Bắt đầu</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { api } from '@/api/index';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  created: [params: { accountId: string; contactId: string }];
}>();

const accounts = ref<{ text: string; value: string }[]>([]);
const contacts = ref<{ text: string; value: string }[]>([]);
const accountId = ref<string | null>(null);
const contactId = ref<string | null>(null);
const contactSearch = ref('');
const searchingContacts = ref(false);
const creating = ref(false);
const error = ref('');

onMounted(async () => {
  // Pre-load Zalo accounts the user can access
  try {
    const res = await api.get('/zalo-accounts');
    const list = Array.isArray(res.data) ? res.data : res.data.accounts || [];
    accounts.value = list
      .filter((a: any) => a.liveStatus === 'connected' || a.status === 'connected')
      .map((a: any) => ({
        text: a.displayName || a.zaloUid || a.id,
        value: a.id,
      }));
  } catch (err: any) {
    error.value = 'Không tải được danh sách Zalo: ' + (err.response?.data?.error || err.message);
  }
  // Initial contact list (recent synced)
  await loadContacts('');
});

let searchTimer: ReturnType<typeof setTimeout>;
function onSearchContacts(q: string) {
  contactSearch.value = q;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadContacts(q), 300);
}

async function loadContacts(q: string) {
  searchingContacts.value = true;
  try {
    const res = await api.get('/contacts', { params: { search: q, limit: 50 } });
    const list = res.data.contacts || res.data || [];
    contacts.value = list
      .filter((c: any) => !!c.zaloUid)
      .map((c: any) => ({
        text: `${c.fullName || 'Unknown'}${c.phone ? ' · ' + c.phone : ''}`,
        value: c.id,
      }));
  } catch (err: any) {
    error.value = 'Tìm khách hàng thất bại: ' + (err.response?.data?.error || err.message);
  } finally {
    searchingContacts.value = false;
  }
}

async function onSubmit() {
  if (!accountId.value || !contactId.value) return;
  creating.value = true;
  error.value = '';
  try {
    emit('created', { accountId: accountId.value, contactId: contactId.value });
    emit('update:modelValue', false);
  } finally {
    creating.value = false;
  }
}

// Reset form when dialog closes
watch(
  () => props.modelValue,
  (v) => {
    if (!v) {
      accountId.value = null;
      contactId.value = null;
      contactSearch.value = '';
      error.value = '';
    }
  },
);
</script>
