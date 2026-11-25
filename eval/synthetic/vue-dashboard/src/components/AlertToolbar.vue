<template>
  <div class="toolbar">
    <button>{{ $t('alerts.archiveAction') }}</button>
    <button class="w-28 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.btnExport') }}</button>
    <span>{{ $t('plural.alerts', count) }}</span>
  </div>
</template>
