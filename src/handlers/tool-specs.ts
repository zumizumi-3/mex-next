import type { Handler, HandlerArgs, HandlerContext } from './types.js';
import {
  handleHelpShow,
  handleQueueSummary,
  handleScheduleCancel,
  handleScheduleDetail,
  handleScheduleList,
  handleSchedulePublishNow,
  handleStatusShow,
} from './index.js';

export interface ToolSpec {
  /** Anthropic tool name (snake_case, MUST match `^[a-z][a-z0-9_]{0,63}$`). */
  name: string;
  /** Customer-facing English description that tells the LLM when to call the tool. */
  description: string;
  /** Anthropic input_schema (JSON schema dialect that Anthropic accepts). */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Whether the tool mutates state. Destructive tools require user confirmation. */
  destructive: boolean;
  /** Operator only? */
  operatorOnly?: boolean;
  /** Build HandlerArgs from LLM-provided tool input. */
  buildHandlerArgs: (input: Record<string, unknown>) => HandlerArgs;
  /** The actual handler. */
  handler: Handler;
  /**
   * Optional pre-execution summary the LLM should weave into its
   * confirmation question.
   */
  summarize?: (input: Record<string, unknown>, ctx: HandlerContext) => Promise<string>;
}

const idOrTimeProperties = {
  publish_id: {
    type: 'string',
    description: '予約投稿の publish_id。顧客が pub_xxx を指定した場合に使う。',
  },
  time_hint: {
    type: 'string',
    description: '顧客が指定した時刻。HH:MM 形式。例: "08:32"',
    pattern: '^\\d{1,2}:\\d{2}$',
  },
} as const;

function passThrough(input: Record<string, unknown>): HandlerArgs {
  return input;
}

function emptyArgs(): HandlerArgs {
  return {};
}

async function summarizeCancel(
  input: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<string> {
  const scope = typeof input.scope === 'string' ? input.scope : '';
  if (scope === 'all' || scope === 'today_all') {
    const summary = await handleQueueSummary(ctx, {});
    const parsed = parseQueueSummary(summary.content);
    if (scope === 'today_all') {
      return `今日 ${parsed.today_active} 件`;
    }
    return `今日 ${parsed.today_active} 件 + 過去 ${parsed.past_active} 件 = 計 ${parsed.total_active} 件`;
  }
  const publishId = typeof input.publish_id === 'string' ? input.publish_id.trim() : '';
  if (publishId) return `予約 ${publishId} 1 件`;
  const timeHint = typeof input.time_hint === 'string' ? input.time_hint.trim() : '';
  if (timeHint) return `${timeHint} の予約 1 件`;
  return '対象の予約';
}

function parseQueueSummary(raw: string): {
  today_active: number;
  past_active: number;
  total_active: number;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      today_active: numberField(parsed.today_active),
      past_active: numberField(parsed.past_active),
      total_active: numberField(parsed.total_active),
    };
  } catch {
    return { today_active: 0, past_active: 0, total_active: 0 };
  }
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_scheduled_posts',
    description:
      "予約済みの投稿一覧を返す。顧客が「予約見せて」「今日の予約」「キュー確認」と言ったら呼ぶ。全 active 予約を、過去時刻・今日・明日・以降に分けて返す。",
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active'],
          description: "active の予約のみを見る。省略時も active と同じ。",
        },
      },
    },
    destructive: false,
    buildHandlerArgs: passThrough,
    handler: handleScheduleList,
  },
  {
    name: 'get_queue_summary',
    description:
      '予約 queue の概要を返す。active 件数を today / past / total で分類。cancel 系の前にこれを呼んで件数を顧客に伝えるべき。',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: emptyArgs,
    handler: handleQueueSummary,
  },
  {
    name: 'cancel_publish_items',
    description:
      "予約投稿を取り消す。顧客が「取り消して」「全部取り消して」「今日だけ消して」と言ったら使う。scope='all' は過去残りを含む active 全件、scope='today_all' は今日の active のみ、publish_id/time_hint は単体取消。",
    inputSchema: {
      type: 'object',
      properties: {
        ...idOrTimeProperties,
        scope: {
          type: 'string',
          enum: ['one', 'today_all', 'all'],
          description:
            "取り消し範囲。'全部'/'過去含めて' は all、'今日だけ' は today_all、単体指定は one または省略。",
        },
      },
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handleScheduleCancel,
    summarize: summarizeCancel,
  },
  {
    name: 'publish_now',
    description:
      '予約投稿を今すぐ X に投稿する。顧客が「今すぐ投稿」「すぐ出して」と言ったら使う。publish_id か time_hint で対象を指定する。',
    inputSchema: {
      type: 'object',
      properties: idOrTimeProperties,
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handleSchedulePublishNow,
  },
  {
    name: 'get_publish_detail',
    description:
      '予約投稿 1 件の詳細と本文プレビューを返す。顧客が「この予約の中身」「08:32 の詳細」「pub_xxx 見せて」と言ったら使う。',
    inputSchema: {
      type: 'object',
      properties: idOrTimeProperties,
    },
    destructive: false,
    buildHandlerArgs: passThrough,
    handler: handleScheduleDetail,
  },
  {
    name: 'get_account_status',
    description:
      'アカウント運用状態を返す。cadence、予約数、skip dates など。顧客が「状態確認」「今どうなってる」と言ったら使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: emptyArgs,
    handler: handleStatusShow,
  },
  {
    name: 'get_help',
    description:
      'MeX bot の使い方を返す。顧客が「使い方」「ヘルプ」「何ができる」と聞いたら使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: emptyArgs,
    handler: handleHelpShow,
  },
];
