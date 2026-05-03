import type { Handler, HandlerArgs, HandlerContext } from './types.js';
import {
  handleAutomationEnableAll,
  handleAutomationStatus,
  handleCadenceSkipToday,
  handleHelpShow,
  handleOnboardCancel,
  handleOnboardStart,
  handleOnboardStatus,
  handlePhaseQuestionnaireStart,
  handlePhaseQuestionnaireStatus,
  handlePostCreate,
  handleQueueSummary,
  handleScheduleCancel,
  handleScheduleDetail,
  handleScheduleList,
  handleSchedulePublishNow,
  handleSeedRun,
  handleStatusShow,
  handleSystemRegenerateKnowledge,
  handleSystemUpdate,
  handleTargetAdd,
  handleTargetList,
  handleTargetRemove,
  handleTrainingRun,
  makeCadenceSetHandler,
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

const setCadenceToolHandler: Handler = async (ctx, args) => {
  const level = String(args.level ?? '').trim();
  if (level !== 'light' && level !== 'standard' && level !== 'aggressive') {
    return { content: '⚠️ level は light/standard/aggressive のいずれか。' };
  }
  return makeCadenceSetHandler(level)(ctx, {});
};

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
  {
    name: 'add_target_handle',
    description:
      'X の追跡対象 handle を追加する。顧客が「@tanaka を追跡して」「ターゲットに追加」と言ったら使う。handle は @ なし。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'X handle。@ は付けない。' },
      },
      required: ['handle'],
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handleTargetAdd,
  },
  {
    name: 'list_targets',
    description:
      '追跡対象 handle の一覧を返す。顧客が「ターゲット一覧」「追跡対象見せて」と言ったら使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: emptyArgs,
    handler: handleTargetList,
  },
  {
    name: 'remove_target_handle',
    description:
      'X の追跡対象 handle を削除する。顧客が「@tanaka を外して」「追跡対象から削除」と言ったら使う。handle は @ なし。',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'X handle。@ は付けない。' },
      },
      required: ['handle'],
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handleTargetRemove,
  },
  {
    name: 'get_automation_status',
    description:
      '自動運用 gate の状態を返す。顧客が「自動運用どうなってる」「automation status」と聞いたら使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: emptyArgs,
    handler: handleAutomationStatus,
  },
  {
    name: 'enable_all_automation',
    description:
      '全 automation gate を auto に切り替える。自動運用を一括 ON にする operator 向け操作。',
    inputSchema: { type: 'object', properties: {} },
    destructive: true,
    buildHandlerArgs: emptyArgs,
    handler: handleAutomationEnableAll,
  },
  {
    name: 'skip_today',
    description:
      "今日の予約をスキップする (= 今日の active を全部 cancel する)。cancel_publish_items{scope:'today_all'} の同義。LLM はどちらを使ってもよいが、「今日の予約スキップ」と顧客が明示した場合のみこちら、より広い「全部」「いらない」表現は cancel_publish_items を使うこと。",
    inputSchema: { type: 'object', properties: {} },
    destructive: true,
    buildHandlerArgs: emptyArgs,
    handler: handleCadenceSkipToday,
  },
  {
    name: 'set_cadence',
    description: '投稿ペースを変更する。light=2/日, standard=4/日, aggressive=6/日。',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['light', 'standard', 'aggressive'],
          description: '投稿ペース。light=2/日, standard=4/日, aggressive=6/日。',
        },
      },
      required: ['level'],
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: setCadenceToolHandler,
  },
  {
    name: 'create_post_draft',
    description: 'テーマから投稿 draft を 1 件生成する。承認後に X に投稿される。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '投稿 draft のテーマ。' },
      },
      required: ['topic'],
    },
    destructive: false,
    buildHandlerArgs: passThrough,
    handler: handlePostCreate,
  },
  {
    name: 'start_onboarding',
    description:
      '33 問オンボーディングを開始する。途中で「やめる」と言えば中断可能。/mex update 後の初回 setup に使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: true,
    buildHandlerArgs: emptyArgs,
    handler: handleOnboardStart,
  },
  {
    name: 'get_onboarding_status',
    description:
      'オンボーディングの進行状況を返す。顧客が「オンボーディング状況」「今どこまで」と聞いたら使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: false,
    buildHandlerArgs: emptyArgs,
    handler: handleOnboardStatus,
  },
  {
    name: 'cancel_onboarding',
    description:
      '進行中のオンボーディングを中断する。顧客が「オンボーディングやめる」「中止」と言ったら使う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: true,
    buildHandlerArgs: emptyArgs,
    handler: handleOnboardCancel,
  },
  {
    name: 'run_seed',
    description:
      '複数の投稿 draft をまとめて生成する。count は 1-13、topics は任意テーマ配列、approve_all=true なら全件 schedule に流す。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', minimum: 1, maximum: 13 },
        topics: { type: 'array', items: { type: 'string' } },
        approve_all: { type: 'boolean' },
      },
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handleSeedRun,
  },
  {
    name: 'run_training',
    description:
      'X の過去投稿を取り込み、voice 学習用 exemplar を作る。count は 5-200。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', minimum: 5, maximum: 200 },
      },
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handleTrainingRun,
  },
  {
    name: 'start_phase_questionnaire',
    description:
      '週次・月次・四半期の phase questionnaire を開始する。cadence 省略時は monthly。',
    inputSchema: {
      type: 'object',
      properties: {
        cadence: { type: 'string', enum: ['weekly', 'monthly', 'quarterly'] },
      },
    },
    destructive: true,
    buildHandlerArgs: passThrough,
    handler: handlePhaseQuestionnaireStart,
  },
  {
    name: 'get_phase_questionnaire_status',
    description:
      'phase questionnaire の最近のセッションや進行状況を返す。cadence で絞り込み可能。',
    inputSchema: {
      type: 'object',
      properties: {
        cadence: { type: 'string', enum: ['weekly', 'monthly', 'quarterly'] },
      },
    },
    destructive: false,
    buildHandlerArgs: passThrough,
    handler: handlePhaseQuestionnaireStatus,
  },
  {
    name: 'run_system_update',
    description:
      'mex bot の自己更新を開始する。operator 専用。プロセス再起動を伴う。',
    inputSchema: { type: 'object', properties: {} },
    destructive: true,
    operatorOnly: true,
    buildHandlerArgs: emptyArgs,
    handler: handleSystemUpdate,
  },
  {
    name: 'regenerate_knowledge',
    description:
      'account.json から knowledge files を再生成する。operator 専用。既存 knowledge files を上書きする。',
    inputSchema: { type: 'object', properties: {} },
    destructive: true,
    operatorOnly: true,
    buildHandlerArgs: emptyArgs,
    handler: handleSystemRegenerateKnowledge,
  },
];
