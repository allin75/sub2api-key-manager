import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = await fs.readFile(new URL('../public/overrides.css', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf('function usagePreviewPlacement('), source.indexOf('function positionUsagePreview(')), context);
vm.runInContext(source.slice(source.indexOf('function budgetNoticeKey('), source.indexOf('function checkBudgetNotification(')), context);

const grid = { left: 355, width: 1196 };
const leftCard = { left: 355, right: 945, width: 590 };
const rightCard = { left: 960, right: 1551, width: 591 };

test('seven-day preview attaches to the outer side of both cards at 1920px', () => {
  const left = context.usagePreviewPlacement(leftCard, grid, 1920, true);
  const right = context.usagePreviewPlacement(rightCard, grid, 1920, true);
  assert.equal(left.side, 'left');
  assert.equal(left.left, 15);
  assert.equal(left.width, 340);
  assert.equal(right.side, 'right');
  assert.equal(right.left, 1551);
  assert.equal(right.width, 340);
});

test('desktop previews turn inward when outer gutters are unavailable while phones stay below', () => {
  const left = context.usagePreviewPlacement({ left:22,right:612,width:590 }, { left:22,width:1196 }, 1240, true);
  const right = context.usagePreviewPlacement({ left:627,right:1218,width:591 }, { left:22,width:1196 }, 1240, true);
  const mobile = context.usagePreviewPlacement({ left: 14, right: 376, width: 362 }, { left: 14, width: 362 }, 390, false);
  assert.equal(left.side, 'right');
  assert.equal(left.left,612);
  assert.equal(right.side,'left');
  assert.equal(right.left,287);
  assert.equal(mobile.side, 'bottom');
  assert.equal(mobile.width, 362);
});

test('large-screen previews fit both outer gutters at their scaled reading width', () => {
  for (const [viewport, shellWidth, padding, previewWidth] of [[2560, 1560, 27.5, 425], [3840, 2200, 33, 510]]) {
    const left = (viewport - shellWidth) / 2 + padding;
    const right = viewport - left;
    const grid = { left, width: right - left };
    const box = { left, right: viewport / 2 - 10, top: 300, width: viewport / 2 - 10 - left, height: 450 };
    const other = { ...box, left: viewport / 2 + 10, right };
    for (const card of [box, other]) {
      const placement = context.usagePreviewPlacement(card, grid, viewport, true, previewWidth);
      assert.equal(placement.side, card === box ? 'left' : 'right');
      assert.equal(placement.width, previewWidth);
      const position = context.usagePreviewSidePosition(card, placement.side, viewport, 1440, previewWidth);
      assert.equal(position.width, previewWidth);
      assert.ok(position.left >= 12 && position.left + position.width <= viewport - 12);
    }
  }
});

test('scaled previews turn inward at insufficient outer space and keep detached gaps', () => {
  const card = { left: 420, right: 1200, top: 800, width: 780, height: 500 };
  assert.equal(context.usagePreviewPlacement(card, { left: 420, width: 1720 }, 2560, true, 425).side, 'right');
  const shifted = context.usagePreviewSidePosition({ ...card, left: 440 }, 'left', 2560, 1000, 425);
  assert.equal(shifted.detached, true);
  assert.equal(shifted.width, 412);
  assert.equal(shifted.left + shifted.width + shifted.gap, 440);
});

test('desktop window widths and zoom-equivalent viewports always produce bounded side previews',()=>{
  for(const viewport of [901,1024,1240,1280,1440,1512,1707,1760,1920,2048,2560,3072,3840]){
    const shell=Math.min(1240,viewport),left=(viewport-shell)/2+22,right=viewport-left;
    const grid={left,width:right-left};
    for(const card of [{left,right:viewport/2-8,width:viewport/2-8-left},{left:viewport/2+8,right,width:right-viewport/2-8}]){
      const placement=context.usagePreviewPlacement(card,grid,viewport,true,340);
      assert.ok(['left','right'].includes(placement.side));
      assert.ok(placement.left>=12&&placement.left+placement.width<=viewport-12);
      assert.ok(placement.width>250);
    }
  }
});

test('a narrow desktop column reserves room for a side preview instead of moving it below',()=>{
  for(const viewport of [681,768,900]){
    const width=Math.min(340,viewport*.42);
    const card={left:22,right:viewport-22-width,width:viewport-44-width};
    const placement=context.usagePreviewPlacement(card,{left:22,width:viewport-44},viewport,false,width);
    assert.equal(placement.side,'right');assert.equal(placement.width,width);
    assert.ok(placement.left+placement.width<=viewport-12);
  }
});

test('a vertically shifted preview leaves a gap and points only to its source card', () => {
  const thirdCard = { left: 355, right: 945, top: 732, width: 590, height: 371 };
  const shifted = context.usagePreviewSidePosition(thirdCard, 'left', 1920, 945);
  assert.equal(shifted.detached, true);
  assert.equal(shifted.top, 562);
  assert.equal(shifted.left + shifted.width + shifted.gap, thirdCard.left);
  assert.equal(shifted.gap, 16);
  assert.ok(shifted.anchorY >= thirdCard.top);
  assert.ok(shifted.anchorY > 717);

  const aligned = context.usagePreviewSidePosition({ ...thirdCard, top: 346 }, 'left', 1920, 945);
  assert.equal(aligned.detached, false);
  assert.equal(aligned.gap, 0);
});

test('the inline preview keeps its natural height and the left drawer reveals from its attached edge', () => {
  assert.match(styles, /\.usage-preview-slot\s*\{[^}]*align-items:flex-start/);
  assert.match(styles, /\.usage-popover\[data-side="left"\]\s*\{[^}]*clip-path:inset\(0 0 0 100%\)/);
  assert.doesNotMatch(styles, /animation:usage-line-reveal/);
});

test('switching cards cancels the prior reveal and starts from the new side', () => {
  const animations = [];
  const animationContext = vm.createContext({
    usagePreview: { animation: null },
    usagePopover: {
      dataset: { side: 'left' },
      animate(frames) {
        const animation = { frames, cancelled: false, cancel() { this.cancelled = true; } };
        animations.push(animation);
        return animation;
      }
    },
    matchMedia: () => ({ matches: false })
  });
  vm.runInContext(source.slice(source.indexOf('function usageClosedClip('), source.indexOf('function closeUsagePreview(')), animationContext);

  animationContext.animateUsagePreview(true);
  animationContext.usagePopover.dataset.side = 'right';
  animationContext.animateUsagePreview(true);
  assert.equal(animations[0].frames[0].clipPath, 'inset(0 0 0 100%)');
  assert.equal(animations[0].cancelled, true);
  assert.equal(animations[1].frames[0].clipPath, 'inset(0 100% 0 0)');
  animations[0].onfinish();
  assert.equal(animations[1].cancelled, false);
});

test('monthly balance notice uses the accounting cycle and excludes stale or trial data', () => {
  const budget = { type: 'monthly', limit: 100, balance: 10, month: '2026-10', cycleMonth: '2026-09', monthlyResetEnabled: false, stale: false };
  assert.equal(context.budgetNoticeKey('account-a', budget), 'sub2api-budget-notified:account-a:2026-09');
  assert.equal(context.shouldNotifyBudget(budget, 'account-a', false), true);
  assert.equal(context.shouldNotifyBudget({ ...budget, balance: 10.01 }, 'account-a', false), false);
  assert.equal(context.shouldNotifyBudget({ ...budget, stale: true }, 'account-a', false), false);
  assert.equal(context.shouldNotifyBudget({ ...budget, type: 'trial' }, 'account-a', false), false);
  assert.equal(context.shouldNotifyBudget(budget, 'account-a', true), false);
  assert.equal(context.budgetNoticeKey('account-a', { ...budget, monthlyResetEnabled: true }), 'sub2api-budget-notified:account-a:2026-10');
});

test('monthly balance notice sends once per cycle and falls back to an in-page message', () => {
  const stored = new Map();
  const notices = [];
  const messages = [];
  const Notification = class {
    static permission = 'granted';
    constructor(title, options) { notices.push([title, options.body]); }
  };
  Object.assign(context, {
    state: { budget: { type: 'monthly', limit: 100, balance: 8, month: '2026-09', monthlyResetEnabled: true, stale: false } },
    currentAccess: () => ({ id: 'account-a' }),
    budgetNotified: new Set(),
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    money: value => `$${value.toFixed(2)}`,
    toast: message => messages.push(message),
    Notification,
    window: { Notification },
    document: { hidden: false }
  });
  vm.runInContext(source.slice(source.indexOf('function checkBudgetNotification('), source.indexOf('function closeBudget(')), context);

  context.checkBudgetNotification();
  context.checkBudgetNotification();
  assert.equal(notices.length, 1);
  assert.equal(stored.get('sub2api-budget-notified:account-a:2026-09'), '1');

  context.state.budget.month = '2026-10';
  context.window = {};
  context.document.hidden = true;
  context.checkBudgetNotification();
  assert.equal(messages.length, 0);
  assert.equal(stored.has('sub2api-budget-notified:account-a:2026-10'), false);

  context.document.hidden = false;
  context.checkBudgetNotification();
  context.checkBudgetNotification();
  assert.equal(messages.length, 1);
  assert.equal(stored.get('sub2api-budget-notified:account-a:2026-10'), '1');
});
