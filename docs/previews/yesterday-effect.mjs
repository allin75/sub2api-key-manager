export const yesterdayEffectDuration = 10000;

export function yesterdayEffectFrame(cost, startedAt, now) {
  if (!Number.isFinite(cost) || cost <= 10) return null;
  const elapsed = Math.max(0, now - startedAt);
  if (!Number.isFinite(elapsed)) return null;
  const phase = elapsed % yesterdayEffectDuration;
  return { tone: cost > 20 ? 'hot' : 'warm', delayMs: phase === 0 ? 0 : -phase };
}

export function mountYesterdayEffects(document, now = () => performance.now()) {
  const grid = document.getElementById('keyGrid');
  const starts = new Map();
  const classes = ['usage-yesterday-warm', 'usage-yesterday-hot'];
  const clear = tile => {
    tile.classList.remove(...classes);
    tile.style.removeProperty('--usage-yesterday-delay');
  };
  const decorate = () => {
    for (const card of grid.querySelectorAll('.key-card[data-sort-id]')) {
      const tile = card.querySelector('[data-usage-period="yesterday"]');
      if (!tile) continue;
      const cost = Number(tile.dataset.usageCost);
      const id = card.dataset.sortId;
      const at = now();
      if (!starts.has(id) && yesterdayEffectFrame(cost, at, at)) starts.set(id, at);
      const frame = starts.has(id) ? yesterdayEffectFrame(cost, starts.get(id), at) : null;
      if (!frame) { clear(tile); continue; }
      const className = `usage-yesterday-${frame.tone}`;
      if (tile.classList.contains(className)) continue;
      clear(tile);
      tile.style.setProperty('--usage-yesterday-delay', `${frame.delayMs}ms`);
      tile.classList.add(className);
    }
  };
  // Retain start times outside the replaceable card DOM, including quiet phases.
  const observer = new MutationObserver(decorate);
  observer.observe(grid, { childList: true });
  decorate();
  const replay = document.createElement('button');
  replay.id = 'replayYesterdayEffect';
  replay.type = 'button';
  replay.className = 'secondary';
  replay.textContent = '重播昨日特效';
  replay.addEventListener('click', () => {
    for (const tile of grid.querySelectorAll('[data-usage-period="yesterday"]')) clear(tile);
    // Flush the removed animation before explicitly starting a new preview run.
    void grid.offsetWidth;
    starts.clear();
    decorate();
  });
  document.querySelector('.hero-actions').prepend(replay);
  return { decorate, disconnect: () => observer.disconnect() };
}

if (typeof document !== 'undefined') mountYesterdayEffects(document);
