/**
 * Handler barrel.
 *
 * Exposes:
 *   - HandlerContext / HandlerResult shared types
 *   - one handler function per intent
 *   - `buildHandlers()` — assemble the intent-name → handler map
 *
 * Both the natural-language conversation runner and the slash command
 * dispatcher use this same map so the surfaces never diverge.
 */

import {
  handleScheduleList,
  handleScheduleCancel,
  handleSchedulePublishNow,
  handleScheduleDetail,
} from './schedule.js';
import { handlePostCreate } from './post.js';
import { handleTargetAdd, handleTargetList, handleTargetRemove } from './target.js';
import { handleAutomationStatus, handleAutomationEnableAll } from './automation.js';
import { handleCadenceSkipToday, makeCadenceSetHandler } from './cadence.js';
export { makeCadenceSetHandler } from './cadence.js';
import { handleStatusShow, handleHelpShow, handleUnknown } from './status.js';
import {
  handleOnboardStart,
  handleOnboardStatus,
  handleOnboardCancel,
} from './onboarding.js';
import { handleSeedRun } from './seeding.js';
import { handleTrainingRun } from './training.js';
import {
  handlePhaseQuestionnaireStart,
  handlePhaseQuestionnaireStatus,
  handlePhaseQuestionnaireSubmit,
} from './phase.js';
import type { Handler, HandlersMap } from './types.js';

export type { HandlerContext, HandlerResult, HandlerArgs, Handler, HandlersMap } from './types.js';
export {
  handleScheduleList,
  handleScheduleCancel,
  handleSchedulePublishNow,
  handleScheduleDetail,
  handlePostCreate,
  handleTargetAdd,
  handleTargetList,
  handleTargetRemove,
  handleAutomationStatus,
  handleAutomationEnableAll,
  handleCadenceSkipToday,
  handleStatusShow,
  handleHelpShow,
  handleUnknown,
  handleOnboardStart,
  handleOnboardStatus,
  handleOnboardCancel,
  handleSeedRun,
  handleTrainingRun,
  handlePhaseQuestionnaireStart,
  handlePhaseQuestionnaireStatus,
  handlePhaseQuestionnaireSubmit,
};

/**
 * Build the intent-name → handler map. Intent names match
 * `IntentName` from `conversation/intent-router.ts` — the slash command
 * dispatcher translates command names into the same intent space.
 */
export function buildHandlers(): HandlersMap {
  const map: Record<string, Handler> = {
    'schedule.list': handleScheduleList,
    'schedule.cancel': handleScheduleCancel,
    'schedule.publish_now': handleSchedulePublishNow,
    'schedule.detail': handleScheduleDetail,
    'post.create': handlePostCreate,
    'target.add': handleTargetAdd,
    'target.list': handleTargetList,
    'target.remove': handleTargetRemove,
    'automation.status': handleAutomationStatus,
    'automation.enable_all': handleAutomationEnableAll,
    'cadence.set_light': makeCadenceSetHandler('light'),
    'cadence.set_standard': makeCadenceSetHandler('standard'),
    'cadence.set_aggressive': makeCadenceSetHandler('aggressive'),
    'cadence.skip_today': handleCadenceSkipToday,
    'status.show': handleStatusShow,
    'help.show': handleHelpShow,
    'onboard.start': handleOnboardStart,
    'onboard.status': handleOnboardStatus,
    'onboard.cancel': handleOnboardCancel,
    'seed.run': handleSeedRun,
    'training.run': handleTrainingRun,
    'phase.questionnaire_start': handlePhaseQuestionnaireStart,
    'phase.questionnaire_status': handlePhaseQuestionnaireStatus,
    'phase.questionnaire_submit': handlePhaseQuestionnaireSubmit,
    unknown: handleUnknown,
  };
  return map;
}
