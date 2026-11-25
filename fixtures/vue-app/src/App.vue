<script setup lang="ts">
import { useI18n } from "vue-i18n";
const { t } = useI18n();
const count = 3;
const banner = "You have " + count + " alerts";
</script>

<template>
  <section>
    <h1>{{ $t("welcome", { name: "Colton" }) }}</h1>
    <button aria-label="Dismiss alert">Close panel</button>
    <p>{{ $t("post") }}</p>
    <p>{{ banner }}</p>
  </section>
</template>
