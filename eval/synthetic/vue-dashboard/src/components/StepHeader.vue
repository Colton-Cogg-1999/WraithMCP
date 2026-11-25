<template>
  <header>
    <h1>{{ $t('brand.title') }}</h1>
    <button>{{ $t('nav.backAction') }}</button>
    <nav role="tablist">
      <button class="w-24 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.tabMetrics') }}</button>
      <button class="w-24 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.tabLogs') }}</button>
      <button class="w-24 truncate whitespace-nowrap overflow-hidden">{{ $t('tight.tabAlerts') }}</button>
    </nav>
  </header>
</template>
