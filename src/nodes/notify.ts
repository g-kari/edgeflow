import { isRetryableStatus, NonRetryableError } from '../errors';
import { requireParam, type NodeImpl } from './types';

// Slack / Discord の incoming webhook に POST する。
// 実体は http ノードのラッパだが、URL 形式を検証できる点で分けている。
export const notifyNode: NodeImpl = async (ctx) => {
  const webhookUrl = String(requireParam(ctx, 'webhookUrl'));
  const text = String(requireParam(ctx, 'text'));

  if (!webhookUrl.startsWith('https://')) {
    throw new NonRetryableError(`webhookUrl は https でなければなりません: ${webhookUrl}`);
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const message = `通知に失敗しました HTTP ${res.status}`;
    if (!isRetryableStatus(res.status)) throw new NonRetryableError(message);
    throw new Error(message);
  }

  return { output: { status: res.status } };
};
