<script setup>
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';

const props = defineProps({ roadmap: { type: Object, required: true } });
const stage = ref('Next');
const area = ref('All');
const query = ref('');
const order = ['In progress', 'Next', 'Later', 'Done'];
const stages = computed(() => ['All', ...order.filter((name) => props.roadmap.board.some((item) => item.col === name))]);
const filtered = computed(() => {
  const search = query.value.trim().toLocaleLowerCase();
  return props.roadmap.board.filter((item) =>
    (stage.value === 'All' || item.col === stage.value) &&
    (area.value === 'All' || item.area === area.value) &&
    (!search || [item.text, item.detail, item.doneWhen, item.area].join(' ').toLocaleLowerCase().includes(search)),
  );
});
const groups = computed(() => order.map((name) => ({ name, items: filtered.value.filter((item) => item.col === name) })).filter((group) => group.items.length));
const total = (name) => name === 'All' ? props.roadmap.board.length : props.roadmap.board.filter((item) => item.col === name).length;
function clear() { stage.value = 'All'; area.value = 'All'; query.value = ''; }
</script>

<template>
  <div class="roadmap-tracker">
    <div class="roadmap-filters">
      <div class="roadmap-stage-filters" role="group" aria-label="Filter roadmap by stage">
        <button v-for="name in stages" :key="name" type="button" :aria-pressed="stage === name" @click="stage = name">
          {{ name === 'Done' ? 'Implemented' : name }} <span>{{ total(name) }}</span>
        </button>
      </div>
      <div class="roadmap-search-filters">
        <label for="roadmap-search">Search work
          <input id="roadmap-search" v-model="query" type="search" placeholder="Chat, Docker, accessibility…" />
        </label>
        <label for="roadmap-area">Area
          <select id="roadmap-area" v-model="area">
            <option value="All">All areas</option>
            <option v-for="name in roadmap.areas" :key="name">{{ name }}</option>
          </select>
        </label>
      </div>
    </div>
    <p class="roadmap-result-count" role="status" aria-live="polite">{{ filtered.length }} of {{ roadmap.board.length }} items</p>
    <section v-for="group in groups" :key="group.name" class="roadmap-work-group" :aria-label="group.name === 'Done' ? 'Implemented work' : group.name + ' work'">
      <h3>{{ group.name === 'Done' ? 'Implemented' : group.name }} <span>{{ group.items.length }}</span></h3>
      <div class="roadmap-work-grid">
        <article v-for="item in group.items" :key="item.id" class="roadmap-work-card" :data-stage="item.col">
          <div class="roadmap-work-meta"><span>{{ item.area }}</span><span>{{ item.col === 'Done' ? 'Implemented' : item.col }}{{ item.release === 'Unreleased' ? ' / Unreleased' : '' }}</span></div>
          <h4>{{ item.text }}</h4>
          <p>{{ item.detail }}</p>
          <div v-if="item.doneWhen" class="roadmap-criteria"><strong>Complete when</strong><p>{{ item.doneWhen }}</p></div>
          <a v-if="item.href" :href="withBase(item.href)">Related docs <span class="roadmap-sr-only">for {{ item.text }}</span><span aria-hidden="true"> →</span></a>
        </article>
      </div>
    </section>
    <div v-if="!filtered.length" class="roadmap-empty">
      <p>No work matches these filters.</p>
      <button type="button" @click="clear">Clear filters</button>
    </div>
  </div>
</template>
