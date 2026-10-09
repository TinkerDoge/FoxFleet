<script setup>
import { computed } from 'vue';

const props = defineProps({ roadmap: { type: Object, required: true } });
const count = (stage) => props.roadmap.board.filter((item) => item.col === stage).length;
const stats = computed(() => [
  { value: count('Done'), label: 'Implemented', note: 'In the current source' },
  { value: count('Next') + count('In progress'), label: 'Next priorities', note: 'Validation before expansion' },
  { value: count('Later'), label: 'Future items', note: 'No dates committed' },
]);
</script>

<template>
  <section class="roadmap-snapshot" aria-label="Current project stage">
    <div class="roadmap-snapshot-top">
      <div class="roadmap-versions">
        <span class="roadmap-release">Released v{{ roadmap.releasedVersion ?? roadmap.version }}</span>
        <span v-if="roadmap.nextVersion" class="roadmap-next-version">{{ roadmap.nextVersion }} / Unreleased</span>
      </div>
      <span class="roadmap-reviewed">Reviewed <time :datetime="roadmap.updated">{{ roadmap.updated }}</time></span>
    </div>
    <p class="roadmap-eyebrow">Current stage</p>
    <h2>{{ roadmap.stage }}</h2>
    <p class="roadmap-focus">{{ roadmap.focus }}</p>
    <div class="roadmap-stats">
      <div v-for="stat in stats" :key="stat.label">
        <strong>{{ stat.value }}</strong>
        <span>{{ stat.label }}</span>
        <small>{{ stat.note }}</small>
      </div>
    </div>
  </section>
</template>
