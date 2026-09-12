/**
 * 構造化ログ。
 *
 * このプロジェクトは「AIやVectorizeが落ちても会話は続ける」という設計方針で、
 * あちこちの catch で失敗を握りつぶしている。体験としてはそれが正しいのだが、
 * 何も記録しないと「なんとなく記憶が弱い気がする」といった不具合を後から追えない。
 * そこで、握りつぶす場所では必ずここを通して「どこで何が落ちたか」だけを残す。
 *
 * 大原則: **会話本文・ユーザーの入力・記憶の中身は絶対にログに出さない**。
 * 出してよいのは、処理の種別・所要時間・成否・エラーメッセージ・識別子（cid等）まで。
 * cid自体もURLに載る程度の識別子ではあるが、本文と結び付けないことで
 * ログから会話内容が読めない状態を保つ。
 */

export interface LogContext {
  /** 1リクエストを串刺しで追うためのID。Worker→DO→AIのログを紐付ける */
  requestId: string;
  /** どの経路の処理か（chat / call / transcribe など） */
  route: string;
  /** 対象キャラクター（本文とは結び付けない） */
  characterId?: string;
}

type Fields = Record<string, string | number | boolean | undefined>;

function emit(level: "info" | "warn" | "error", ctx: LogContext, event: string, fields?: Fields): void {
  // JSON1行で出す。Workers Logsはこの形式ならフィールド単位で検索できる。
  const payload = {
    level,
    event,
    requestId: ctx.requestId,
    route: ctx.route,
    ...(ctx.characterId ? { characterId: ctx.characterId } : {}),
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function logInfo(ctx: LogContext, event: string, fields?: Fields): void {
  emit("info", ctx, event, fields);
}

export function logWarn(ctx: LogContext, event: string, fields?: Fields): void {
  emit("warn", ctx, event, fields);
}

export function logError(ctx: LogContext, event: string, err: unknown, fields?: Fields): void {
  emit("error", ctx, event, {
    ...fields,
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? err.name : undefined,
  });
}

/** 握りつぶす処理を計測しつつ包む。失敗しても例外を投げず、fallbackを返す。 */
export async function tolerate<T>(
  ctx: LogContext,
  event: string,
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await fn();
    logInfo(ctx, event, { ok: true, ms: Date.now() - startedAt });
    return result;
  } catch (err) {
    logError(ctx, event, err, { ok: false, ms: Date.now() - startedAt });
    return fallback;
  }
}

export function newRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * requestIdを持てない場所（Durable Object内部のユーティリティなど）から使う簡易版。
 *
 * 本来は1リクエストを串刺しに追えるようrequestIdを引き回したいが、
 * memory.ts のような下位のユーティリティまで引数を通すと呼び出し側が煩雑になる。
 * 「どこで何が落ちたか」が分かるだけでも切り分けには十分効くため、
 * characterIdと事象名だけを持つ軽い版を用意している。
 */
export function logDetachedWarn(event: string, fields?: Fields): void {
  console.warn(JSON.stringify({ level: "warn", event, ...fields }));
}

export function logDetachedError(event: string, err: unknown, fields?: Fields): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      ...fields,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : undefined,
    })
  );
}
