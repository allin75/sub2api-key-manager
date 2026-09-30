import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const animationFunctions = source.slice(source.indexOf('function shouldRequireAnnouncement('), source.indexOf('function dockAnnouncement('));
const acknowledgementFunction = source.slice(source.indexOf('async function acknowledgeAnnouncement('), source.indexOf('elements.openAnnouncementButton.addEventListener('));

test('the viewport reserves scrollbar space while the announcement locks background scrolling', async () => {
  const styles = await fs.readFile(new URL('../public/overrides.css', import.meta.url), 'utf8');
  assert.match(styles, /(?:^|\n)html\s*\{[^}]*scrollbar-gutter:\s*stable\s*;/);
  assert.match(styles, /\.announcement-open\s*\{[^}]*overflow:\s*hidden\s*;/);
});

test('an announcement requires explicit acknowledgement of the current session version', () => {
  const context = vm.createContext({});
  vm.runInContext(animationFunctions, context);
  assert.equal(context.shouldRequireAnnouncement(null), false);
  assert.equal(context.shouldRequireAnnouncement({ version: 'current', acknowledged: false }), true);
  assert.equal(context.shouldRequireAnnouncement({ version: 'current', acknowledged: true }), false);
  assert.equal(context.shouldRequireAnnouncement({ version: 'current', acknowledged: 'true' }), true);
});

test('targeted announcements are queued before rules and acknowledgements leave the history intact', () => {
  const notice = { id: 'notice', version: 'notice', acknowledged: false };
  const policy = { version: 'policy', acknowledged: false };
  const context = vm.createContext({ state: { notices: [notice], policyAnnouncement: policy } });
  vm.runInContext(animationFunctions, context);
  assert.equal(context.pendingAnnouncement(), notice);
  notice.acknowledged = true;
  assert.equal(context.pendingAnnouncement(), policy);
  policy.acknowledged = true;
  assert.equal(context.pendingAnnouncement(), null);
  assert.equal(context.state.notices.length, 1);
});

function noticeComposerContext() {
  const pending = [];
  const context = vm.createContext({
    state: { role: 'superadmin', accessKeys: [{ id: 'first', secret: 'first' }, { id: 'second', secret: 'second' }] },
    noticeComposerAccessId: '', noticeComposerVersion: 0, noticeComposerBusy: false, viewVersion: 1,
    document: { body: { classList: { add() {}, remove() {} } } },
    elements: {
      noticeComposer: { open: false, close() { this.open = false; }, showModal() { this.open = true; } },
      noticeComposerForm: { reset() {} }, noticeComposerError: { textContent: '' },
      noticeHistory: { innerHTML: '', querySelectorAll: () => [] }, noticePublishButton: {},
      noticeRecipient: { textContent: '' }, noticeTitleInput: { value: '', focus() {} }, noticeBodyInput: { value: '' }
    },
    api: url => new Promise((resolve, reject) => { pending.push({ url, resolve, reject }); }),
    escapeHtml: value => String(value), formatTime: value => value, toast() {},
    setBusy: (button, busy, text) => { button.disabled = busy; button.textContent = text; }
  });
  vm.runInContext(source.slice(source.indexOf('function closeNoticeComposer('), source.indexOf("elements.noticeComposerForm.addEventListener('submit'")), context);
  return { context, pending };
}

test('late notice history never replaces a different administrator composer', async () => {
  const { context, pending } = noticeComposerContext();
  const first = context.openNoticeComposer('first');
  const second = context.openNoticeComposer('second');
  pending[1].resolve({ notices: [{ id: 'second-notice', title: 'second title', body: 'second body', publishedAt: 'now', acknowledged: false }] });
  await second;
  pending[0].resolve({ notices: [{ id: 'first-notice', title: 'first title', body: 'first body', publishedAt: 'now', acknowledged: false }] });
  await first;
  assert.equal(context.elements.noticeRecipient.textContent, 'second');
  assert.match(context.elements.noticeHistory.innerHTML, /second title/);
  assert.doesNotMatch(context.elements.noticeHistory.innerHTML, /first title/);
});

test('failed notice publishing retains the draft, prevents duplicate submits and releases retry', async () => {
  const { context, pending } = noticeComposerContext();
  const opened = context.openNoticeComposer('first');
  pending[0].resolve({ notices: [] }); await opened;
  context.elements.noticeTitleInput.value = 'draft title';
  context.elements.noticeBodyInput.value = 'draft body';
  const saved = context.saveTargetedNotice({ preventDefault() {} });
  await context.saveTargetedNotice({ preventDefault() {} });
  assert.equal(pending.length, 2);
  pending[1].reject(new Error('保存失败')); await saved;
  assert.equal(context.elements.noticeTitleInput.value, 'draft title');
  assert.equal(context.elements.noticeBodyInput.value, 'draft body');
  assert.equal(context.elements.noticeComposerError.textContent, '保存失败');
  assert.equal(context.elements.noticePublishButton.disabled, false);
  assert.equal(context.noticeComposerBusy, false);
});

test('closing a publishing composer cannot write feedback into another account or session', async () => {
  const { context, pending } = noticeComposerContext();
  const opened = context.openNoticeComposer('first');
  pending[0].resolve({ notices: [] }); await opened;
  const saved = context.saveTargetedNotice({ preventDefault() {} });
  context.viewVersion++;
  context.closeNoticeComposer();
  const second = context.openNoticeComposer('second');
  pending[2].resolve({ notices: [] }); await second;
  pending[1].resolve({ notices: [{ id: 'old', title: 'old account title', body: 'old body', publishedAt: 'now', acknowledged: false }] });
  await saved;
  assert.equal(context.elements.noticeRecipient.textContent, 'second');
  assert.doesNotMatch(context.elements.noticeHistory.innerHTML, /old account title/);
  context.state.role = 'admin';
  await context.openNoticeComposer('first');
  await context.saveTargetedNotice({ preventDefault() {} });
  assert.equal(pending.length, 3);
});

test('opening an inbox cannot continue after its session changes during refresh', async () => {
  let finishRefresh;
  const context = vm.createContext({
    viewVersion: 1, announcementClosing: false, opened: 0,
    state: { csrfToken: 'first-session' }, elements: { announcementDialog: { open: false } },
    refreshOwnNotices: () => new Promise(resolve => { finishRefresh = resolve; }),
    pendingAnnouncement: () => null, openAnnouncement: () => { context.opened++; }
  });
  vm.runInContext(source.slice(source.indexOf('async function openAnnouncementInbox('), source.indexOf("elements.openAnnouncementButton.addEventListener('click'")), context);
  const pending = context.openAnnouncementInbox();
  context.viewVersion++;
  context.state.csrfToken = 'new-session';
  finishRefresh(); await pending;
  assert.equal(context.opened, 0);
});

test('UI transitions finish without an animation library or with reduced motion', async () => {
  let animated = 0;
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false }) },
    activeUiAnimations: new Set()
  });
  vm.runInContext(animationFunctions, context);
  await context.animateUi({}, {});
  context.anime = { animate: () => { animated++; } };
  context.window.matchMedia = () => ({ matches: true });
  await context.animateUi({}, {});
  assert.equal(animated, 0);
  assert.equal(context.activeUiAnimations.size, 0);
});

test('cancelling UI transitions restores styles and releases pending login steps', async () => {
  let reverted = 0;
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false }) },
    activeUiAnimations: new Set(),
    anime: { animate: () => ({ revert: () => { reverted++; } }) }
  });
  vm.runInContext(animationFunctions, context);
  const pending = context.animateUi({}, {});
  assert.equal(context.activeUiAnimations.size, 1);
  context.cancelUiAnimations();
  await pending;
  assert.equal(reverted, 1);
  assert.equal(context.activeUiAnimations.size, 0);
});

function animationContext(target) {
  let completion;
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false }) },
    activeUiAnimations: new Set(),
    reverted: 0,
    anime: {
      animate: (element, parameters) => {
        completion = parameters.onComplete;
        return { revert: () => { context.reverted++; element.style.opacity = '1'; } };
      }
    }
  });
  vm.runInContext(animationFunctions, context);
  return { context, complete: () => { target.style.opacity = '0'; completion(); } };
}

test('completed backdrop fade stays transparent until the longer layout transition finishes', async () => {
  const target = { style: { opacity: '1' } };
  const { context, complete } = animationContext(target);
  const pending = context.animateUi(target, { opacity: [1, 0] }, { restoreOnComplete: false });
  complete();
  await pending;
  assert.equal(target.style.opacity, '0');
  assert.equal(context.reverted, 0);
  assert.equal(context.activeUiAnimations.size, 0);
});

test('cancelling a persistent backdrop fade still restores styles and releases the transition', async () => {
  const target = { style: { opacity: '1' } };
  const { context } = animationContext(target);
  const pending = context.animateUi(target, { opacity: [1, 0] }, { restoreOnComplete: false });
  target.style.opacity = '.5';
  context.cancelUiAnimations();
  await pending;
  assert.equal(target.style.opacity, '1');
  assert.equal(context.reverted, 1);
  assert.equal(context.activeUiAnimations.size, 0);
});

test('ordinary completed UI animations still restore their original styles', async () => {
  const target = { style: { opacity: '1' } };
  const { context, complete } = animationContext(target);
  const pending = context.animateUi(target, { opacity: [1, 0] });
  complete();
  await pending;
  assert.equal(target.style.opacity, '1');
  assert.equal(context.reverted, 1);
});

test('announcement has a centered SVG close icon and no logout action inside its dialog', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="closeAnnouncementButton"[^>]*>\s*<svg/);
  assert.doesNotMatch(html, /announcementLogoutButton/);
  assert.match(html, /id="logoutButton"/);
  const actions = html.match(/<div class="announcement-actions">(.*?)<\/div>/s)?.[1];
  assert.ok(actions);
  assert.equal((actions.match(/<button/g) || []).length, 1);
});

function acknowledgementContext(api) {
  const context = vm.createContext({
    state: { announcement: { version: 'current', acknowledged: false } },
    elements: { acknowledgeAnnouncementButton: {}, announcementError: { textContent: '' } },
    announcementSaving: false,
    announcementClosing: false,
    viewVersion: 1,
    folded: 0,
    api,
    foldAnnouncement: async () => { context.folded++; },
    setBusy: (button, busy, text) => { button.disabled = busy; button.textContent = text; }
  });
  vm.runInContext(animationFunctions + acknowledgementFunction, context);
  return context;
}

test('failed announcement saves retain the reminder and allow acknowledgement retry', async () => {
  let attempts = 0;
  const context = acknowledgementContext(async (url, options) => {
    assert.equal(url, '/api/announcement/acknowledge');
    assert.equal(options.body.version, 'current');
    if (++attempts === 1) throw new Error('保存失败，请重试');
    return { announcement: { version: 'current', acknowledged: true } };
  });
  await context.acknowledgeAnnouncement();
  assert.equal(context.folded, 0);
  assert.equal(context.state.announcement.acknowledged, false);
  assert.equal(context.elements.announcementError.textContent, '保存失败，请重试');
  assert.equal(context.elements.acknowledgeAnnouncementButton.disabled, false);
  await context.acknowledgeAnnouncement();
  assert.equal(context.folded, 1);
  assert.equal(context.state.announcement.acknowledged, true);
});

test('duplicate or expired-session acknowledgements cannot update a newer login view', async () => {
  let resolveRequest;
  let requests = 0;
  const context = acknowledgementContext(() => {
    requests++;
    return new Promise(resolve => { resolveRequest = resolve; });
  });
  const pending = context.acknowledgeAnnouncement();
  await context.acknowledgeAnnouncement();
  assert.equal(requests, 1);
  context.viewVersion++;
  context.state.announcement = null;
  resolveRequest({ announcement: { version: 'current', acknowledged: true } });
  await pending;
  assert.equal(context.folded, 0);
  assert.equal(context.state.announcement, null);
});

test('Escape never dismisses a required announcement but can fold a reviewed one', () => {
  let cancelHandler;
  let prevented = 0;
  let folded = 0;
  const context = vm.createContext({
    state: { announcement: { version: 'current', acknowledged: false } },
    elements: { announcementDialog: { addEventListener: (event, handler) => { cancelHandler = handler; } } },
    announcementSaving: false,
    foldAnnouncement: () => { folded++; }
  });
  vm.runInContext(animationFunctions + source.slice(source.indexOf("elements.announcementDialog.addEventListener('cancel'"), source.indexOf("document.addEventListener('visibilitychange'")), context);
  cancelHandler({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(folded, 0);
  context.state.announcement.acknowledged = true;
  cancelHandler({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(folded, 1);
});

function animatedFoldContext() {
  let finishLayout;
  let finishReveal;
  const layoutFinished = new Promise(resolve => { finishLayout = resolve; });
  const revealFinished = new Promise(resolve => { finishReveal = resolve; });
  const classList = () => ({ add() {}, remove() {} });
  const style = () => ({ removeProperty(property) { delete this[property]; } });
  const context = vm.createContext({
    state: { announcement: { version: 'current', acknowledged: true } },
    viewVersion: 1,
    announcementClosing: false,
    announcementSaving: false,
    announcementLayout: null,
    announcementFlight: null,
    focused: 0,
    animations: [],
    elements: {
      announcementDialog: { open: true, close() { this.open = false; } },
      announcementSurface: { classList: classList(), getBoundingClientRect: () => ({}) },
      announcementSlot: { append() {}, getBoundingClientRect: () => ({}) },
      announcementShade: { classList: classList(), style: style() },
      announcementDot: { classList: classList() },
      announcementError: { textContent: '' },
      topbar: { classList: classList() },
      openAnnouncementButton: { style: style(), setAttribute() {}, focus: () => { context.focused++; } }
    },
    document: {
      body: { append() {}, classList: classList() },
      createElement: () => ({ style: style(), append() {}, remove() {} })
    },
    canAnimateUi: () => true,
    cancelUiAnimations() {},
    animateUi: (target, parameters, options) => {
      context.animations.push({ target, parameters, options });
      return target === context.elements.openAnnouncementButton ? revealFinished : Promise.resolve();
    },
    anime: {
      createLayout: () => {
        context.opacityAtLayoutStart = context.elements.openAnnouncementButton.style.opacity;
        return { revert() {}, update: callback => { callback(); return { then: () => layoutFinished }; } };
      }
    }
  });
  vm.runInContext(source.slice(source.indexOf('function shouldRequireAnnouncement('), source.indexOf('function canAnimateUi(')) + source.slice(source.indexOf('function dockAnnouncement('), source.indexOf('async function acknowledgeAnnouncement(')), context);
  return { context, finishLayout, finishReveal };
}

test('the docked announcement icon stays hidden during folding and then fades and scales in', async () => {
  const styles = await fs.readFile(new URL('../public/overrides.css', import.meta.url), 'utf8');
  assert.match(styles, /\.announcement-flight\s+\.announcement-nav-button\s*\{[^}]*transition:\s*none\s*;/);
  const { context, finishLayout, finishReveal } = animatedFoldContext();
  const pending = context.foldAnnouncement();
  assert.equal(context.opacityAtLayoutStart, '0');
  assert.equal(context.animations.length, 1);
  finishLayout();
  await new Promise(setImmediate);
  const reveal = context.animations[1];
  assert.equal(reveal.target, context.elements.openAnnouncementButton);
  assert.deepEqual(Array.from(reveal.parameters.opacity), [0, 1]);
  assert.deepEqual(Array.from(reveal.parameters.scale), [.88, 1]);
  assert.equal(reveal.parameters.duration, 180);
  assert.equal(reveal.parameters.ease, 'inOut(2)');
  assert.equal(reveal.options.restoreOnComplete, false);
  assert.equal(context.announcementClosing, true);
  assert.equal(context.focused, 0);
  await context.foldAnnouncement();
  assert.equal(context.animations.length, 2);
  context.elements.openAnnouncementButton.style.opacity = '1';
  context.elements.openAnnouncementButton.style.transform = 'scale(1)';
  finishReveal();
  await pending;
  assert.equal(context.elements.openAnnouncementButton.style.opacity, undefined);
  assert.equal(context.elements.openAnnouncementButton.style.transform, undefined);
  assert.equal(context.announcementClosing, false);
  assert.equal(context.focused, 1);
});

test('an interrupted fold cannot reveal the announcement icon in a newer session', async () => {
  const { context, finishLayout } = animatedFoldContext();
  const pending = context.foldAnnouncement();
  context.viewVersion++;
  context.resetAnnouncement();
  finishLayout();
  await pending;
  assert.equal(context.animations.length, 1);
  assert.equal(context.elements.openAnnouncementButton.style.opacity, undefined);
  assert.equal(context.focused, 0);
});

test('resetting during the icon reveal removes temporary styles and never restores old focus', async () => {
  const { context, finishLayout, finishReveal } = animatedFoldContext();
  const pending = context.foldAnnouncement();
  finishLayout();
  await new Promise(setImmediate);
  context.elements.openAnnouncementButton.style.transform = 'scale(.94)';
  context.viewVersion++;
  context.resetAnnouncement();
  finishReveal();
  await pending;
  assert.equal(context.elements.openAnnouncementButton.style.opacity, undefined);
  assert.equal(context.elements.openAnnouncementButton.style.transform, undefined);
  assert.equal(context.focused, 0);
});

test('folding cannot bypass acknowledgement and reduced motion docks without a temporary layer', async () => {
  let closed = 0;
  let docked = 0;
  let focused = 0;
  const context = vm.createContext({
    state: { announcement: { version: 'current', acknowledged: false } },
    elements: {
      announcementDialog: { open: true, close: () => { closed++; } },
      announcementSurface: { getBoundingClientRect: () => ({}) },
      announcementDot: { classList: { add() {} } },
      openAnnouncementButton: { focus: () => { focused++; } }
    },
    viewVersion: 1,
    announcementClosing: false,
    canAnimateUi: () => false,
    cancelUiAnimations() {},
    dockAnnouncement: () => { docked++; },
    resetAnnouncement: () => { context.announcementClosing = false; }
  });
  vm.runInContext(source.slice(source.indexOf('function shouldRequireAnnouncement('), source.indexOf('function canAnimateUi(')) + source.slice(source.indexOf('async function foldAnnouncement('), source.indexOf('async function acknowledgeAnnouncement(')), context);
  await context.foldAnnouncement();
  assert.equal(closed, 0);
  assert.equal(docked, 0);
  context.state.announcement.acknowledged = true;
  await context.foldAnnouncement();
  assert.equal(closed, 1);
  assert.equal(docked, 1);
  assert.equal(focused, 1);
});
