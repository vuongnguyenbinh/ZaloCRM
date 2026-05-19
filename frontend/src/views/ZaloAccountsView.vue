<template>
  <div>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h4">Tài khoản Zalo</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" @click="showAddDialog = true">Thêm Zalo</v-btn>
    </div>

    <v-card>
      <v-data-table :headers="headers" :items="accounts" :loading="loading" no-data-text="Chưa có tài khoản Zalo nào">
        <template #item.status="{ item }">
          <v-chip :color="statusColor(item.liveStatus || item.status)" size="small" variant="flat">
            {{ statusText(item.liveStatus || item.status) }}
          </v-chip>
        </template>
        <template #item.actions="{ item }">
          <v-btn v-if="authStore.isAdmin" icon size="small" color="cyan" title="Phân quyền truy cập" @click="openAccess(item)">
            <v-icon>mdi-shield-account</v-icon>
          </v-btn>
          <v-btn icon size="small" color="success" @click="syncContacts(item.id)" title="Đồng bộ danh bạ Zalo" :loading="syncing === item.id">
            <v-icon>mdi-account-sync</v-icon>
          </v-btn>
          <v-btn
            v-if="authStore.isAdmin"
            icon size="small" color="warning"
            @click="openHistoryDialog(item)"
            title="Đồng bộ lịch sử nhóm chat"
            :disabled="item.liveStatus !== 'connected'"
            :loading="syncingHistory === item.id">
            <v-icon>mdi-history</v-icon>
          </v-btn>
          <v-btn v-if="item.liveStatus !== 'connected'" icon size="small" color="primary" @click="loginAccount(item.id)" title="Đăng nhập QR">
            <v-icon>mdi-qrcode</v-icon>
          </v-btn>
          <v-btn v-if="item.liveStatus === 'disconnected' && item.sessionData" icon size="small" color="info" @click="reconnectAccount(item.id)" title="Kết nối lại">
            <v-icon>mdi-refresh</v-icon>
          </v-btn>
          <v-btn icon size="small" color="error" @click="confirmDelete(item)" title="Xóa">
            <v-icon>mdi-delete</v-icon>
          </v-btn>
        </template>
      </v-data-table>
    </v-card>

    <!-- Add account dialog -->
    <v-dialog v-model="showAddDialog" max-width="400">
      <v-card>
        <v-card-title>Thêm tài khoản Zalo</v-card-title>
        <v-card-text>
          <v-text-field v-model="newAccountName" label="Tên hiển thị (VD: Zalo Sale Hương)" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showAddDialog = false">Hủy</v-btn>
          <v-btn color="primary" :loading="adding" @click="handleAddAccount">Thêm</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- QR Code dialog -->
    <v-dialog v-model="showQRDialog" max-width="400" persistent>
      <v-card class="text-center pa-4">
        <v-card-title>Quét QR để đăng nhập Zalo</v-card-title>
        <v-card-text>
          <div v-if="qrImage" class="mb-4">
            <img :src="'data:image/png;base64,' + qrImage" alt="QR Code" style="max-width: 280px;" />
          </div>
          <div v-else-if="qrScanned" class="mb-4">
            <v-icon icon="mdi-check-circle" size="64" color="success" />
            <p class="text-h6 mt-2">Đã quét! Xác nhận trên điện thoại...</p>
            <p v-if="scannedName" class="text-body-2">{{ scannedName }}</p>
          </div>
          <div v-else class="mb-4">
            <v-progress-circular indeterminate color="primary" size="64" />
            <p class="mt-2">Đang tạo QR code...</p>
          </div>
          <v-alert v-if="qrError" type="error" density="compact" class="mt-2">{{ qrError }}</v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelQR">Đóng</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Delete confirm dialog -->
    <v-dialog v-model="showDeleteDialog" max-width="400">
      <v-card>
        <v-card-title>Xác nhận xóa</v-card-title>
        <v-card-text>Bạn có chắc muốn xóa tài khoản "{{ deleteTarget?.displayName || deleteTarget?.id }}"?</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showDeleteDialog = false">Hủy</v-btn>
          <v-btn color="error" :loading="deleting" @click="handleDeleteAccount">Xóa</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Access control dialog -->
    <ZaloAccessDialog
      v-model="showAccessDialog"
      :account-id="accessTarget?.id ?? ''"
      :account-name="accessTarget?.displayName ?? accessTarget?.id ?? ''"
    />

    <!-- Sync group history dialog -->
    <v-dialog v-model="showHistoryDialog" max-width="480">
      <v-card>
        <v-card-title>Đồng bộ lịch sử nhóm chat</v-card-title>
        <v-card-text>
          <p class="mb-3 text-body-2">
            Tải <strong>{{ historyCount }}</strong> tin nhắn gần nhất của
            <strong>{{ historyGroupId ? '1 nhóm' : 'TẤT CẢ nhóm' }}</strong>
            trên tài khoản <strong>{{ historyTarget?.displayName }}</strong>.
            Có thể mất vài chục giây nếu có nhiều nhóm.
          </p>
          <v-text-field
            v-model="historyGroupId"
            label="Group ID (bỏ trống = tất cả nhóm)"
            density="compact" variant="outlined" hide-details
            placeholder="VD: 1234567890"
            class="mb-3"
          />
          <v-text-field
            v-model.number="historyCount"
            label="Số tin nhắn / nhóm (1–200)"
            type="number" min="1" max="200"
            density="compact" variant="outlined" hide-details
          />
          <v-alert
            v-if="historyResult"
            :type="historyResult.success ? 'success' : 'error'"
            density="compact" class="mt-3" closable
            @click:close="historyResult = null"
          >
            <div v-if="historyResult.success">
              Đã insert <strong>{{ historyResult.totalInserted }}</strong> tin mới,
              skip <strong>{{ historyResult.totalSkipped }}</strong> (đã tồn tại).
              Sync qua {{ historyResult.synced?.length ?? 0 }} nhóm.
            </div>
            <div v-else>{{ historyResult.error }}</div>
          </v-alert>
          <p class="text-caption mt-3 text-grey">
            💡 Lưu ý: zca-js không hỗ trợ lịch sử chat 1-1. Endpoint này chỉ sync nhóm.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="showHistoryDialog = false">Đóng</v-btn>
          <v-btn
            color="primary" :loading="syncingHistory === historyTarget?.id"
            :disabled="!historyCount || historyCount < 1 || historyCount > 200"
            @click="runSyncHistory"
          >Đồng bộ</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useZaloAccounts, type ZaloAccount } from '@/composables/use-zalo-accounts';
import { useAuthStore } from '@/stores/auth';
import ZaloAccessDialog from '@/components/settings/ZaloAccessDialog.vue';
import { api } from '@/api/index';

const {
  accounts, loading, adding, deleting,
  showQRDialog, qrImage, qrScanned, scannedName, qrError,
  statusColor, statusText,
  fetchAccounts, addAccount, loginAccount, reconnectAccount, deleteAccount,
  cancelQR, setupSocket,
} = useZaloAccounts();

const authStore = useAuthStore();

const showAddDialog = ref(false);
const syncing = ref<string | null>(null);
const syncingHistory = ref<string | null>(null);
const showDeleteDialog = ref(false);
const showAccessDialog = ref(false);
const showHistoryDialog = ref(false);
const newAccountName = ref('');
const deleteTarget = ref<ZaloAccount | null>(null);
const accessTarget = ref<ZaloAccount | null>(null);
const historyTarget = ref<ZaloAccount | null>(null);
const historyGroupId = ref('');
const historyCount = ref(50);
const historyResult = ref<
  | { success: true; totalInserted: number; totalSkipped: number; synced: unknown[] }
  | { success: false; error: string }
  | null
>(null);

const headers = [
  { title: 'Tên', key: 'displayName', sortable: true },
  { title: 'Zalo UID', key: 'zaloUid' },
  { title: 'SĐT', key: 'phone' },
  { title: 'Trạng thái', key: 'status', sortable: true },
  { title: 'Hành động', key: 'actions', sortable: false, align: 'end' as const },
];

async function syncContacts(accountId: string) {
  syncing.value = accountId;
  try {
    const res = await api.post(`/zalo-accounts/${accountId}/sync-contacts`);
    alert(`Đồng bộ thành công: ${res.data.created} mới, ${res.data.updated} cập nhật`);
  } catch (err: any) {
    alert('Đồng bộ thất bại: ' + (err.response?.data?.error || err.message));
  } finally {
    syncing.value = null;
  }
}

function openHistoryDialog(account: ZaloAccount) {
  historyTarget.value = account;
  historyGroupId.value = '';
  historyCount.value = 50;
  historyResult.value = null;
  showHistoryDialog.value = true;
}

async function runSyncHistory() {
  if (!historyTarget.value) return;
  const accountId = historyTarget.value.id;
  syncingHistory.value = accountId;
  historyResult.value = null;
  try {
    const payload: { count: number; groupId?: string } = { count: historyCount.value };
    if (historyGroupId.value.trim()) payload.groupId = historyGroupId.value.trim();
    const res = await api.post(`/zalo-accounts/${accountId}/sync-group-history`, payload);
    historyResult.value = {
      success: true,
      totalInserted: res.data.totalInserted,
      totalSkipped: res.data.totalSkipped,
      synced: res.data.synced ?? [],
    };
  } catch (err: any) {
    historyResult.value = {
      success: false,
      error: err.response?.data?.error || err.message || 'Đồng bộ thất bại',
    };
  } finally {
    syncingHistory.value = null;
  }
}

async function handleAddAccount() {
  const ok = await addAccount(newAccountName.value);
  if (ok) {
    showAddDialog.value = false;
    newAccountName.value = '';
  }
}

function confirmDelete(account: ZaloAccount) {
  deleteTarget.value = account;
  showDeleteDialog.value = true;
}

function openAccess(account: ZaloAccount) {
  accessTarget.value = account;
  showAccessDialog.value = true;
}

async function handleDeleteAccount() {
  if (!deleteTarget.value) return;
  const ok = await deleteAccount(deleteTarget.value);
  if (ok) {
    showDeleteDialog.value = false;
    deleteTarget.value = null;
  }
}

onMounted(() => {
  fetchAccounts();
  setupSocket();
});
</script>
