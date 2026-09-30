export const announcement = Object.freeze({
  version: 'quota-rules-2026-09-30',
  title: '使用前，请先了解额度规则',
  items: [
    { title: '周刷新与月刷新', text: '周刷新重置 API Key 用量，月刷新恢复账号总额度。两项可在账号卡片独立开关，关闭后不会自动刷新。' },
    { title: '一次性体验额度', text: '体验额度不参与周刷新或月刷新，用完后不会自动恢复。' },
    { title: '奖励优先抵扣', text: '有效奖励优先抵扣，不计入原额度；发放奖励不会启用已停用的 Key。' },
    { title: '用量按实际消费统计', text: '用量统计展示实际消费，包含奖励抵扣的消费；周刷新不会清零历史统计或账号总额度的已用量。' }
  ]
});

export function announcementView(acknowledgement) {
  return { ...announcement, acknowledged: acknowledgement?.version === announcement.version };
}

export function noticeInput(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('公告标题需为 1–100 个字符');
  if (!text || text.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('公告内容需为 1–4000 个字符');
  return { title, body: text };
}

export function targetedNoticeView(notice) {
  return { ...notice, version: notice.id, acknowledged: !!notice.acknowledgedAt, items: [{ title: '管理员通知', text: notice.body }] };
}

export function validTargetedNotices(notices, accessKeys) {
  if (!Array.isArray(notices)) return false;
  const ids = new Set();
  return notices.every(notice => {
    if (!notice || typeof notice.id !== 'string' || !notice.id || notice.id.length > 128 || ids.has(notice.id) ||
        !accessKeys?.some(account => account.id === notice.accessKeyId) ||
        typeof notice.publishedAt !== 'string' || !Number.isFinite(Date.parse(notice.publishedAt)) ||
        (notice.acknowledgedAt !== null && (typeof notice.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(notice.acknowledgedAt))))) return false;
    try {
      const input = noticeInput(notice);
      if (input.title !== notice.title || input.body !== notice.body) return false;
    } catch { return false; }
    ids.add(notice.id);
    return true;
  });
}
