<template>
  <!-- Cluster memory & disk capacity ("Free" means unoccupied capacity) -->
  <section>
    <span>{{ $t('quota.freeLabel') }}</span>
    <p>{{ $t('plural.nodes', count) }}</p>
    <p>{{ $t('msg.latency', { ms, window }) }}</p>
  </section>
</template>
