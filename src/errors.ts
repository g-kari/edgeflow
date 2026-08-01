// リトライしても無駄なエラー。Workflows の NonRetryableError に写像する。
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

// HTTP ステータスからリトライ可否を判定する。
// 429 は一時的な制限なのでリトライする。他の 4xx は投げ直しても結果が変わらない。
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500;
}
