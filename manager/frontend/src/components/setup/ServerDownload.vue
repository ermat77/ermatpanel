<script setup lang="ts">
import { ref, computed, onUnmounted, watch, nextTick } from 'vue'
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
  status: 'idle' as 'idle' | 'downloading-downloader' | 'extracting-downloader' | 'downloading-server' | 'extracting-server' | 'copying-to-container' | 'complete' | 'error',
  currentStep: '',
  stepProgress: 0,
  overallProgress: 0,
  message: '',
  error: undefined as string | undefined,
  stdoutLines: [] as string[],
  authUrl: undefined as string | undefined,
  downloadPercent: undefined as number | undefined,
  downloadMb: undefined as number | undefined,
  downloadTotalGb: undefined as number | undefined,
})

// Download complete state
const downloadComplete = ref(false)
const downloadSkipped = ref(false)
/** When manual copy is required, the docker cp command parts from the backend */
const dockerCpCommand = ref<{ sourcePath: string; containerName: string; containerPath: string } | null>(null)

// SSE cleanup function
let cleanupSSE: (() => void) | null = null

// Log container ref for auto-scroll
const logContainerRef = ref<HTMLElement | null>(null)
watch(
  () => downloadProgress.value.stdoutLines.length,
  () => {
    nextTick(() => {
      logContainerRef.value?.scrollTo({ top: logContainerRef.value.scrollHeight, behavior: 'smooth' })
    })
  }
)

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

  // Subscribe to SSE progress first so the GET /progress connection is open
  const { cleanup, ready } = subscribeToServerDownloadProgress(
    handleDownloadProgress,
    handleDownloadComplete,
    handleDownloadError
  )
  cleanupSSE = cleanup

  try {
    // Wait for the first SSE event so the connection is established and the backend has our listener
    await ready
    // Then trigger the download so progress updates are pushed to our open connection
    await setupApi.startServerDownload()
  } catch (err: unknown) {
    const axiosErr = err as { response?: { data?: { error?: string } }; message?: string; code?: string }
    const apiError = axiosErr?.response?.data?.error
    const message = apiError ?? (err instanceof Error ? err.message : t('setup.serverDownloadStartFailed'))
    // If the POST timed out, the backend may still be running – don't close SSE so we keep receiving progress
    const isTimeout = message.toLowerCase().includes('timeout') || axiosErr?.code === 'ECONNABORTED'
    if (isTimeout) {
      // Keep SSE open; show warning but progress will still stream until complete/error
      setupStore.setError(t('setup.serverDownloadRequestTimeout', 'Request timed out – download may still be in progress. Watch the progress below.'))
    } else {
      handleDownloadError(message)
    }
  }
}

// Handle download progress events
function handleDownloadProgress(event: ProgressEvent & { status?: string; currentStep?: string; stepProgress?: number; overallProgress?: number; message?: string; stdoutLines?: string[]; authUrl?: string; dockerCp?: { sourcePath: string; containerName: string; containerPath: string } }) {
  const prev = downloadProgress.value
  const eventLines = Array.isArray(event.stdoutLines) ? event.stdoutLines : null
  // Only replace stdoutLines when server sends a longer or equal array (avoid overwriting with stale empty/short array)
  const stdoutLines =
    eventLines != null && eventLines.length >= (prev.stdoutLines?.length ?? 0)
      ? eventLines
      : prev.stdoutLines

  // Use ?? so we never overwrite with undefined; progress bars never go backwards
  const newOverall = event.overallProgress ?? event.percent ?? prev.overallProgress ?? 0;
  const newStepProgress = event.stepProgress ?? event.percent ?? prev.stepProgress ?? 0;
  const next = {
    status: (event.status ?? event.type ?? 'idle') as typeof downloadProgress.value.status,
    currentStep: event.currentStep ?? event.message ?? '',
    stepProgress: Math.max(newStepProgress, prev.stepProgress ?? 0),
    overallProgress: Math.max(newOverall, prev.overallProgress ?? 0),
    message: event.message ?? event.currentStep ?? prev.message ?? '',
    error: event.error,
    stdoutLines,
    authUrl: event.authUrl ?? prev.authUrl,
    downloadPercent: event.downloadPercent ?? prev.downloadPercent,
    downloadMb: event.downloadMb ?? prev.downloadMb,
    downloadTotalGb: event.downloadTotalGb ?? prev.downloadTotalGb,
  }
  downloadProgress.value = next
  if (event.dockerCp) {
    dockerCpCommand.value = event.dockerCp
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
  // Set progress to error state so the UI shows error (not stuck at last %)
  downloadProgress.value = {
    ...downloadProgress.value,
    status: 'error',
    error,
  }
  if (cleanupSSE) {
    cleanupSSE()
    cleanupSSE = null
  }
}

// Detect URL in text for clickable link (single line)
const URL_REGEX = /(https?:\/\/[^\s]+)/g
function lineToParts(line: string): { type: 'text' | 'url'; value: string }[] {
  const parts: { type: 'text' | 'url'; value: string }[] = []
  let lastIndex = 0
  let m: RegExpExecArray | null
  URL_REGEX.lastIndex = 0
  while ((m = URL_REGEX.exec(line)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ type: 'text', value: line.slice(lastIndex, m.index) })
    }
    parts.push({ type: 'url', value: m[1] })
    lastIndex = m.index + m[1].length
  }
  if (lastIndex < line.length) {
    parts.push({ type: 'text', value: line.slice(lastIndex) })
  }
  return parts.length ? parts : [{ type: 'text', value: line }]
}

// Four sub-steps within "Download server files", each with state and step-specific display
type SubstepState = 'pending' | 'active' | 'done'
const SUBSTEP_ORDER = ['download-downloader', 'authenticate', 'download-game', 'extract', 'copy-to-container'] as const
type SubstepId = (typeof SUBSTEP_ORDER)[number]

const downloadSubsteps = computed(() => {
  const p = downloadProgress.value
  const status = p.status
  const steps: { id: SubstepId; labelKey: string; state: SubstepState; detail?: string }[] = []

  const step1Active = status === 'downloading-downloader' || status === 'extracting-downloader'
  const step1Done = ['downloading-server', 'extracting-server', 'copying-to-container', 'complete'].includes(status)
  steps.push({
    id: 'download-downloader',
    labelKey: 'setup.serverDownloadSubstepDownloadDownloader',
    state: step1Done ? 'done' : step1Active ? 'active' : 'pending',
    detail: step1Active ? p.message : undefined,
  })

  const inDownloadServer = status === 'downloading-server'
  const authNeeded = inDownloadServer && p.authUrl && (p.downloadPercent == null || p.downloadPercent === 0)
  const step2Done = (inDownloadServer && (p.downloadPercent != null && p.downloadPercent > 0)) || ['extracting-server', 'copying-to-container', 'complete'].includes(status)
  steps.push({
    id: 'authenticate',
    labelKey: 'setup.serverDownloadSubstepAuthenticate',
    state: step2Done ? 'done' : authNeeded ? 'active' : 'pending',
    detail: authNeeded ? (p.authUrl ? t('setup.downloaderAuthClickToOpen') : p.message) : undefined,
  })

  const step3Active = inDownloadServer && p.downloadPercent != null
  const step3Done = ['extracting-server', 'copying-to-container', 'complete'].includes(status)
  steps.push({
    id: 'download-game',
    labelKey: 'setup.serverDownloadSubstepDownloadGame',
    state: step3Done ? 'done' : step3Active ? 'active' : 'pending',
    detail: step3Active && p.downloadPercent != null
      ? `${p.downloadPercent.toFixed(1)}%${p.downloadMb != null && p.downloadTotalGb != null ? ` (${p.downloadMb.toFixed(1)} MB / ${p.downloadTotalGb.toFixed(1)} GB)` : ''}`
      : undefined,
  })

  const extractMatch = p.message?.match(/\((\d+)\/(\d+)\s+files\)/)
  const extractCurrent = extractMatch ? parseInt(extractMatch[1], 10) : null
  const extractTotal = extractMatch ? parseInt(extractMatch[2], 10) : null
  const step4Active = status === 'extracting-server'
  const step4Done = status === 'copying-to-container' || status === 'complete'
  steps.push({
    id: 'extract',
    labelKey: 'setup.serverDownloadSubstepExtract',
    state: step4Done ? 'done' : step4Active ? 'active' : 'pending',
    detail: step4Active && extractCurrent != null && extractTotal != null
      ? `${extractCurrent}/${extractTotal} ${t('setup.files', 'files')}`
      : step4Active
        ? p.message
        : undefined,
  })

  const step5Active = status === 'copying-to-container'
  const step5Done = status === 'complete'
  steps.push({
    id: 'copy-to-container',
    labelKey: 'setup.serverDownloadSubstepCopyToContainer',
    state: step5Done ? 'done' : step5Active ? 'active' : 'pending',
    detail: step5Active ? p.message : undefined,
  })

  return steps
})

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
    dockerCpCommand.value = null
    downloadProgress.value = {
      status: 'idle',
      currentStep: '',
      stepProgress: 0,
      overallProgress: 0,
      message: '',
      error: undefined,
      stdoutLines: [],
      authUrl: undefined,
      downloadPercent: undefined,
      downloadMb: undefined,
      downloadTotalGb: undefined,
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

    <!-- Step 2: Download Progress – four sub-steps with distinct components -->
    <template v-else-if="currentDownloadStep === 'downloading'">
      <div class="card">
        <div class="card-body">
          <h3 class="text-xl font-semibold text-white mb-6">{{ t('setup.serverDownloadingTitle') }}</h3>

          <!-- Sub-step stepper -->
          <div class="space-y-4 max-w-2xl mx-auto">
            <div
              v-for="(step, idx) in downloadSubsteps"
              :key="step.id"
              class="rounded-lg border transition-colors"
              :class="{
                'border-hytale-orange/50 bg-hytale-orange/5': step.state === 'active',
                'border-dark-50/50 bg-dark-300/50': step.state === 'pending',
                'border-status-success/30 bg-status-success/5': step.state === 'done',
              }"
            >
              <div class="px-4 py-3 flex items-center gap-3">
                <!-- Step indicator -->
                <div
                  class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium"
                  :class="{
                    'bg-hytale-orange text-white': step.state === 'active',
                    'bg-dark-50 text-gray-500': step.state === 'pending',
                    'bg-status-success/20 text-status-success': step.state === 'done',
                  }"
                >
                  <svg v-if="step.state === 'done'" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                  <span v-else>{{ idx + 1 }}</span>
                </div>
                <div class="min-w-0 flex-1">
                  <p
                    class="font-medium"
                    :class="{
                      'text-hytale-orange': step.state === 'active',
                      'text-gray-500': step.state === 'pending',
                      'text-status-success': step.state === 'done',
                    }"
                  >
                    {{ t(step.labelKey) }}
                  </p>
                  <p v-if="step.detail" class="text-sm text-gray-400 mt-0.5 truncate">
                    {{ step.detail }}
                  </p>
                </div>
              </div>

              <!-- Step 1: Download downloader – message only -->
              <div
                v-if="step.id === 'download-downloader' && step.state === 'active' && step.detail"
                class="px-4 pb-3 pt-0 text-sm text-gray-400"
              >
                {{ step.detail }}
              </div>

              <!-- Step 2: Authenticate – auth URL card -->
              <div
                v-if="step.id === 'authenticate' && step.state === 'active' && downloadProgress.authUrl"
                class="px-4 pb-4 pt-0"
              >
                <p class="text-sm text-gray-300 mb-3">
                  {{ t('setup.downloaderAuthClickToOpen') }}
                </p>
                <a
                  :href="downloadProgress.authUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-hytale-orange text-white font-medium hover:bg-hytale-orange/90 transition-colors"
                >
                  {{ t('setup.downloaderAuthOpenLink') }}
                </a>
                <p class="mt-2 text-xs text-gray-500 break-all">
                  {{ downloadProgress.authUrl }}
                </p>
              </div>

              <!-- Step 3: Download game files – progress bar + MB/GB -->
              <div
                v-if="step.id === 'download-game' && step.state === 'active'"
                class="px-4 pb-4 pt-0"
              >
                <div
                  v-if="downloadProgress.downloadPercent != null"
                  class="space-y-2"
                >
                  <div class="h-3 bg-dark-50 rounded-full overflow-hidden">
                    <div
                      class="h-full bg-gradient-to-r from-hytale-orange to-hytale-yellow transition-all duration-300"
                      :style="{ width: `${Math.min(100, downloadProgress.downloadPercent ?? 0)}%` }"
                    />
                  </div>
                  <p class="text-sm text-gray-400">
                    {{ (downloadProgress.downloadPercent ?? 0).toFixed(1) }}%
                    <template v-if="downloadProgress.downloadMb != null && downloadProgress.downloadTotalGb != null">
                      ({{ downloadProgress.downloadMb.toFixed(1) }} MB / {{ downloadProgress.downloadTotalGb.toFixed(1) }} GB)
                    </template>
                  </p>
                </div>
                <p v-else class="text-sm text-gray-500 italic">
                  {{ t('setup.downloaderWaiting') }}
                </p>
              </div>

              <!-- Step 4: Extract files – file count progress -->
              <div
                v-if="step.id === 'extract' && step.state === 'active'"
                class="px-4 pb-4 pt-0"
              >
                <p class="text-sm text-gray-400">
                  {{ downloadProgress.message || t('setup.serverDownloadStepExtractServer') }}
                </p>
              </div>

              <!-- Step 5: Copy to game container – last sub-step -->
              <div
                v-if="step.id === 'copy-to-container' && step.state === 'active'"
                class="px-4 pb-4 pt-0"
              >
                <p class="text-sm text-gray-400">
                  {{ downloadProgress.message || t('setup.serverDownloadSubstepCopyToContainer') }}
                </p>
              </div>
            </div>
          </div>

          <!-- Downloader stdout (during download-game or authenticate) -->
          <div
            v-if="downloadProgress.status === 'downloading-server' && downloadProgress.stdoutLines.length > 0"
            class="max-w-2xl mx-auto mt-6 rounded-lg bg-dark-300 border border-dark-50/50 overflow-hidden"
          >
            <div class="px-3 py-2 text-xs text-gray-500 border-b border-dark-50/50">
              {{ t('setup.downloaderOutput') }}
            </div>
            <div
              class="p-3 font-mono text-sm text-gray-300 overflow-y-auto max-h-32 scroll-smooth"
              ref="logContainerRef"
            >
              <div
                v-for="(line, lineIdx) in downloadProgress.stdoutLines"
                :key="lineIdx"
                class="leading-relaxed break-all"
              >
                <template v-for="(part, i) in lineToParts(line)" :key="i">
                  <a
                    v-if="part.type === 'url'"
                    :href="part.value"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-hytale-orange hover:underline"
                  >
                    {{ part.value }}
                  </a>
                  <span v-else>{{ part.value }}</span>
                </template>
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

            <!-- Manual copy: docker cp helper command -->
            <div
              v-if="dockerCpCommand"
              class="mt-6 p-4 rounded-lg bg-dark-300 border border-dark-50/50 text-left"
            >
              <p class="text-gray-300 text-sm font-medium mb-2">{{ t('setup.serverDownloadManualCopyTitle') }}</p>
              <p class="text-gray-400 text-sm mb-3">{{ t('setup.serverDownloadManualCopyDesc') }}</p>
              <code class="block p-3 rounded bg-dark-200 text-gray-200 text-sm font-mono break-all select-all">
                docker cp '{{ dockerCpCommand.sourcePath }}' '{{ dockerCpCommand.containerName }}:{{ dockerCpCommand.containerPath }}/'
              </code>
            </div>
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
