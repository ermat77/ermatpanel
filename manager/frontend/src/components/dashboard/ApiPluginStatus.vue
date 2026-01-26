<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { serverApi, type PluginStatus } from '@/api/server'

const { t } = useI18n()

const pluginStatus = ref<PluginStatus | null>(null)
const loading = ref(true)
const uploading = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

async function loadPluginStatus() {
  try {
    loading.value = true
    error.value = null
    successMessage.value = null
    pluginStatus.value = await serverApi.getPluginStatus()
  } catch (err) {
    console.error('Failed to load plugin status:', err)
    error.value = err instanceof Error ? err.message : 'Failed to load plugin status'
  } finally {
    loading.value = false
  }
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (file) {
    uploadPlugin(file)
  }
}

function triggerFileInput() {
  fileInput.value?.click()
}

async function uploadPlugin(file: File) {
  // Validate file type
  if (!file.name.toLowerCase().endsWith('.jar')) {
    error.value = 'Only .jar files are allowed'
    return
  }

  try {
    uploading.value = true
    error.value = null
    successMessage.value = null

    const result = await serverApi.uploadPlugin(file)

    if (result.success) {
      successMessage.value = result.message || 'Plugin uploaded successfully. Restart the server to activate.'
      // Reload status to show the new filename
      await loadPluginStatus()
      // Reset file input
      if (fileInput.value) {
        fileInput.value.value = ''
      }
    } else {
      error.value = result.error || 'Failed to upload plugin'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to upload plugin'
  } finally {
    uploading.value = false
  }
}

onMounted(() => {
  loadPluginStatus()
})
</script>

<template>
  <div class="card">
    <div class="card-header">
      <h3 class="text-lg font-semibold text-white">API Plugin Status</h3>
    </div>
    <div class="card-body">
      <!-- Loading state -->
      <div v-if="loading" class="flex items-center gap-2 text-gray-400">
        <svg class="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <span>Loading plugin status...</span>
      </div>

      <!-- Plugin installed -->
      <div v-else-if="pluginStatus?.installed && pluginStatus?.filename" class="space-y-3">
        <div class="flex items-center gap-3">
          <div class="flex-shrink-0">
            <div class="w-10 h-10 rounded-lg bg-status-success/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-xs text-gray-400 mb-0.5">API Plugin Installed</p>
            <p class="text-sm font-medium text-white truncate" :title="pluginStatus.filename">
              {{ pluginStatus.filename }}
            </p>
            <p v-if="pluginStatus.version" class="text-xs text-gray-400 mt-1">
              Version: {{ pluginStatus.version }}
            </p>
          </div>
        </div>

        <!-- Success message -->
        <div v-if="successMessage" class="p-2 bg-status-success/10 border border-status-success/20 rounded text-sm text-status-success">
          {{ successMessage }}
        </div>
      </div>

      <!-- Plugin not installed -->
      <div v-else class="space-y-3">
        <div class="flex items-center gap-3">
          <div class="flex-shrink-0">
            <div class="w-10 h-10 rounded-lg bg-status-warning/20 flex items-center justify-center">
              <svg class="w-5 h-5 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          </div>
          <div class="flex-1">
            <p class="text-xs text-gray-400 mb-0.5">API Plugin Not Found</p>
            <p class="text-sm text-gray-300">Upload the API plugin JAR file to enable socket functionality</p>
          </div>
        </div>

        <!-- Error message -->
        <div v-if="error" class="p-2 bg-status-error/10 border border-status-error/20 rounded text-sm text-status-error">
          {{ error }}
        </div>

        <!-- Success message -->
        <div v-if="successMessage" class="p-2 bg-status-success/10 border border-status-success/20 rounded text-sm text-status-success">
          {{ successMessage }}
        </div>

        <!-- Upload button -->
        <div>
          <input
            ref="fileInput"
            type="file"
            accept=".jar"
            class="hidden"
            @change="handleFileSelect"
          />
          <button
            @click="triggerFileInput"
            :disabled="uploading"
            class="btn btn-primary w-full inline-flex items-center justify-center gap-2"
          >
            <svg
              v-if="uploading"
              class="animate-spin h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <svg
              v-else
              class="h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            {{ uploading ? 'Uploading...' : 'Upload Plugin JAR' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
