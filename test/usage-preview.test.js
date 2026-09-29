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

test('seven-day preview moves below when the outer edge or second column is unavailable', () => {
  const left = context.usagePreviewPlacement({ ...leftCard, left: 22 }, { left: 22, width: 1196 }, 1240, true);
  const mobile = context.usagePreviewPlacement({ left: 14, right: 376, width: 362 }, { left: 14, width: 362 }, 390, false);
  assert.equal(left.side, 'bottom');
  assert.equal(mobile.side, 'bottom');
  assert.equal(mobile.width, 362);
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
