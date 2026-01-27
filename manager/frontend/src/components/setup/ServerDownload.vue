<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import Button from '@/components/ui/Button.vue'
import { subscribeToServerDownloadProgress, setupApi, type ProgressEvent } from '@/api/setup'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Download option selection
type DownloadOption = 'download' | 'skip'
const downloadOption = ref<DownloadOption>('download')

// Current step within the download flow
type DownloadStep = 'select' | 'downloading' | 'complete'
const currentDownloadStep = ref<DownloadStep>('select')

// Download progress state
const isDownloading = ref(false)
const downloadProgress = ref({
  status: 'idle' as 'idle' | 'downloading-downloader' | 'extracting-downloader' | 'downloading-server' | 'extracting-server' | 'complete' | 'error',
  currentStep: '',
  stepProgress: 0,
  overallProgress: 0,
  message: '',
  error: undefined as string | undefined,
})

// Download complete state
const downloadComplete = ref(false)
const downloadSkipped = ref(false)

// SSE cleanup function
let cleanupSSE: (() => void) | null = null

// Handle option selection
function selectOption(option: DownloadOption) {
  downloadOption.value = option
}

// Proceed from option selection
async function proceedFromSelect() {
  if (downloadOption.value === 'skip') {
    downloadSkipped.value = true
    currentDownloadStep.value = 'complete'
    return
  }

  currentDownloadStep.value = 'downloading'
  await startDownload()
}

// Start download process
async function startDownload() {
  isDownloading.value = true

  // Subscribe to SSE progress updates
  cleanupSSE = subscribeToServerDownloadProgress(
    handleDownloadProgress,
    handleDownloadComplete,
    handleDownloadError
  )

  try {
    // Trigger the download on the backend
    await setupApi.startServerDownload()
  } catch (err) {
    handleDownloadError(err instanceof Error ? err.message : t('setup.serverDownloadStartFailed'))
  }
}

// Handle download progress events
function handleDownloadProgress(event: ProgressEvent & { status?: string; currentStep?: string; stepProgress?: number; overallProgress?: number; message?: string }) {
  downloadProgress.value = {
    status: (event.status || event.type || 'idle') as typeof downloadProgress.value.status,
    currentStep: event.currentStep || event.message || '',
    stepProgress: event.stepProgress || event.percent || 0,
    overallProgress: event.overallProgress || event.percent || 0,
    message: event.message || event.currentStep || '',
    error: event.error,
  }
}

// Handle download complete
function handleDownloadComplete() {
  isDownloading.value = false
  downloadComplete.value = true
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
  currentDownloadStep.value = 'complete'
}

// Handle download error
function handleDownloadError(error: string) {
  isDownloading.value = false
  setupStore.setError(error)
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
}

// Get step name for display
function getStepName(status: string): string {
  switch (status) {
    case 'downloading-downloader':
      return t('setup.serverDownloadStepDownloader')
    case 'extracting-downloader':
      return t('setup.serverDownloadStepExtractDownloader')
    case 'downloading-server':
      return t('setup.serverDownloadStepDownloadServer')
    case 'extracting-server':
      return t('setup.serverDownloadStepExtractServer')
    case 'complete':
      return t('setup.serverDownloadStepComplete')
    default:
      return t('setup.serverDownloadStepIdle')
  }
}

// Handle continue to next step
async function handleContinue() {
  // Save download settings
  const success = await setupStore.saveStep('server-download', {
    download: downloadOption.value === 'download' && downloadComplete.value,
    skip: downloadSkipped.value,
  })

  if (success) {
    emit('complete')
  }
}

function handleBack() {
  if (currentDownloadStep.value !== 'select' && !isDownloading.value) {
    currentDownloadStep.value = 'select'
    downloadComplete.value = false
    downloadSkipped.value = false
    downloadProgress.value = {
      status: 'idle',
      currentStep: '',
      stepProgress: 0,
      overallProgress: 0,
      message: '',
      error: undefined,
    }
    return
  }
  emit('back')
}

// Cleanup on unmount
onUnmounted(() => {
  if (cleanupSSE) {
    cleanupSSE()
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">
        {{ currentDownloadStep === 'downloading' ? t('setup.serverDownloadingTitle') :
           currentDownloadStep === 'complete' ? t('setup.serverDownloadCompleteTitle') :
           t('setup.serverDownloadTitle') }}
      </h2>
      <p class="text-gray-400">
        {{ currentDownloadStep === 'downloading' ? t('setup.serverDownloadingDescription') :
           currentDownloadStep === 'complete' ? (downloadSkipped ? t('setup.serverDownloadSkippedDescription') : t('setup.serverDownloadCompleteDescription')) :
           t('setup.serverDownloadDescription') }}
      </p>
    </div>

    <!-- Step 1: Download Option Selection -->
    <template v-if="currentDownloadStep === 'select'">
      <div class="space-y-4">
        <!-- Download Option -->
        <button
          @click="selectOption('download')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            downloadOption === 'download'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="downloadOption === 'download' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="downloadOption === 'download'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.serverDownloadOption') }}</p>
              <p class="text-sm text-gray-400 mb-3">{{ t('setup.serverDownloadOptionDesc') }}</p>
            </div>
          </div>
        </button>

        <!-- Skip Option -->
        <button
          @click="selectOption('skip')"
          class="w-full p-5 rounded-xl border-2 text-left transition-all duration-200"
          :class="[
            downloadOption === 'skip'
              ? 'border-hytale-orange bg-hytale-orange/10'
              : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
          ]"
        >
          <div class="flex items-start gap-4">
            <div class="flex-shrink-0 mt-1">
              <div
                class="w-5 h-5 rounded-full border-2 flex items-center justify-center"
                :class="downloadOption === 'skip' ? 'border-hytale-orange' : 'border-gray-500'"
              >
                <div
                  v-if="downloadOption === 'skip'"
                  class="w-2.5 h-2.5 rounded-full bg-hytale-orange"
                />
              </div>
            </div>
            <div class="flex-1">
              <p class="text-white font-semibold mb-1">{{ t('setup.skipServerDownloadOption') }}</p>
              <p class="text-sm text-gray-400">{{ t('setup.skipServerDownloadOptionDesc') }}</p>
            </div>
          </div>
        </button>
      </div>
    </template>

    <!-- Step 2: Download Progress -->
    <template v-else-if="currentDownloadStep === 'downloading'">
      <div class="card">
        <div class="card-body">
          <!-- Download status -->
          <div class="text-center py-8">
            <!-- Animated download icon -->
            <div class="inline-flex items-center justify-center w-20 h-20 bg-hytale-orange/20 rounded-2xl mb-6">
              <svg class="w-10 h-10 text-hytale-orange animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>

            <h3 class="text-xl font-semibold text-white mb-2">{{ t('setup.serverDownloadingTitle') }}</h3>
            <p class="text-gray-400 mb-2">{{ downloadProgress.message || t('setup.serverDownloadingDescription') }}</p>
            <p class="text-sm text-gray-500 mb-6">{{ getStepName(downloadProgress.status) }}</p>

            <!-- Progress bar -->
            <div class="max-w-md mx-auto">
              <div class="h-2 bg-dark-50 rounded-full overflow-hidden mb-2">
                <div
                  class="h-full bg-gradient-to-r from-hytale-orange to-hytale-yellow transition-all duration-300"
                  :style="{ width: `${downloadProgress.overallProgress}%` }"
                />
              </div>
              <div class="text-sm text-gray-400">
                {{ downloadProgress.overallProgress }}% {{ t('setup.complete') }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Info Notice -->
      <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
        <div class="flex items-start gap-3">
          <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p class="text-sm text-gray-400">{{ t('setup.serverDownloadInfoNotice') }}</p>
        </div>
      </div>
    </template>

    <!-- Download Complete -->
    <template v-else-if="currentDownloadStep === 'complete'">
      <div class="card">
        <div class="card-body">
          <!-- Success State -->
          <div v-if="!downloadSkipped" class="text-center py-4">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-success/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg mb-2">{{ t('setup.serverDownloadSuccess') }}</p>
            <p class="text-gray-400">{{ t('setup.serverDownloadSuccessDesc') }}</p>
          </div>

          <!-- Skipped State -->
          <div v-else class="text-center py-4">
            <div class="inline-flex items-center justify-center w-16 h-16 bg-status-warning/20 rounded-full mb-4">
              <svg class="w-8 h-8 text-status-warning" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <p class="text-white font-semibold text-lg mb-2">{{ t('setup.serverDownloadSkipped') }}</p>
            <p class="text-gray-400">{{ t('setup.serverDownloadSkippedInfo') }}</p>
          </div>
        </div>
      </div>
    </template>

    <!-- Error Message -->
    <div v-if="setupStore.error || downloadProgress.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error text-sm">{{ setupStore.error || downloadProgress.error }}</p>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-between pt-4">
      <Button
        variant="secondary"
        :disabled="isDownloading"
        @click="handleBack"
      >
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('common.back') }}
      </Button>

      <Button
        v-if="currentDownloadStep === 'select'"
        @click="proceedFromSelect"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <Button
        v-else-if="currentDownloadStep === 'complete'"
        :loading="setupStore.isLoading"
        @click="handleContinue"
      >
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      <div v-else>
        <!-- Empty div to maintain layout during download -->
      </div>
    </div>
  </div>
</template>
