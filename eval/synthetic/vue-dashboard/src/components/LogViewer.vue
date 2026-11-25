<template>
  <!-- Raw log viewer toolbar ("Open" is verb to open log file) -->
  <section>
    <button>{{ $t('file.openAction') }}</button>
    <button class="w-28 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.btnReset') }}</button>
    <p>{{ $t('general.emptyLogs') }}</p>
  </section>
</template>
