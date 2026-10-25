<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

// A looping picture of a pool with limit 2: the oldest holder releases,
// the queue head takes its slot, and a new agent joins the queue.
interface Agent {
  key: string;
  tool: string;
}

let next = 5;
const agent = (): Agent => ({ key: `ISS-${next}`, tool: next++ % 2 ? "claude" : "codex" });

const slots = ref<Agent[]>([agent(), agent()]);
const queue = ref<Agent[]>([agent(), agent()]);
const event = ref("waitlet acquire ISS-7   # position 1");
let timer: ReturnType<typeof setInterval> | undefined;

function step() {
  const done = slots.value.shift()!;
  const head = queue.value.shift()!;
  slots.value.push(head);
  queue.value.push(agent());
  event.value = `waitlet release ${done.key}   # ${head.key} acquired`;
}

onMounted(() => {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(step, 2600);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <figure class="pool" aria-label="A pool with two slots held by agents and two agents waiting in the queue">
    <header>
      <span>pool <b>default</b></span>
      <span>{{ slots.length }}/2 slots</span>
    </header>
    <TransitionGroup tag="ul" name="row" class="slots">
      <li v-for="a in slots" :key="a.key" class="held">
        <span class="dot" />
        <b class="key">{{ a.key }}</b>
        <span class="tool">{{ a.tool }}</span>
        <span class="state">working</span>
      </li>
    </TransitionGroup>
    <div class="label">queue</div>
    <TransitionGroup tag="ol" name="row" class="queue">
      <li v-for="(a, i) in queue" :key="a.key" class="waiting">
        <span class="pos">{{ i + 1 }}</span>
        <b class="key">{{ a.key }}</b>
        <span class="tool">{{ a.tool }}</span>
        <span class="state">0 tokens</span>
      </li>
    </TransitionGroup>
    <figcaption><span class="prompt">$</span> {{ event }}</figcaption>
  </figure>
</template>

<style scoped>
.pool {
  width: 100%;
  max-width: 400px;
  margin: 0 auto;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
  font-size: 13px;
  text-align: start;
  box-shadow: var(--vp-shadow-3);
}
header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  color: var(--vp-c-text-2);
}
header b {
  color: var(--vp-c-text-1);
}
ul,
ol {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
}
li {
  display: grid;
  grid-template-columns: 20px 64px 1fr auto;
  align-items: center;
  height: 40px;
  margin-bottom: 8px;
  padding: 0 12px;
  border-radius: 8px;
}
.held {
  background: var(--vp-c-brand-soft);
}
.waiting {
  border: 1px dashed var(--vp-c-divider);
  color: var(--vp-c-text-2);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
}
.pos {
  color: var(--vp-c-text-3);
}
.key {
  font-family: var(--vp-font-family-mono);
  font-weight: 600;
}
.tool,
.state {
  color: var(--vp-c-text-2);
}
.state {
  font-size: 12px;
}
.label {
  margin: 12px 0 8px;
  color: var(--vp-c-text-3);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
figcaption {
  margin-top: 12px;
  overflow: hidden;
  color: var(--vp-c-text-2);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  white-space: pre;
  text-overflow: ellipsis;
}
.prompt {
  color: var(--vp-c-brand-1);
}
.row-move,
.row-enter-active,
.row-leave-active {
  transition: all 0.5s ease;
}
.row-enter-from,
.row-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
/* Leaving rows stop taking space, so the rest slide up smoothly. */
.row-leave-active {
  position: absolute;
  width: 100%;
}
</style>
