<template>
  <!-- Support incident ticket status ("Open" means unresolved ticket) -->
  <article>
    <span class="badge">{{ $t('status.openBadge') }}</span>
    <p>{{ $t('msg.assigned', { user, id }) }}</p>
  </article>
</template>
