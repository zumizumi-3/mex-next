import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_QUESTIONS,
  ONBOARDING_QUESTION_COUNT,
  findQuestionById,
  firstQuestion,
  indexOfQuestion,
  nextQuestion,
  resolveChoiceKey,
} from '../../../src/onboarding/questions.js';

describe('onboarding questions catalog', () => {
  it('ships at least 33 questions', () => {
    expect(ONBOARDING_QUESTION_COUNT).toBeGreaterThanOrEqual(33);
    expect(ONBOARDING_QUESTIONS.length).toBe(ONBOARDING_QUESTION_COUNT);
  });

  it('every question has a unique id', () => {
    const ids = ONBOARDING_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every question has a non-empty Japanese prompt', () => {
    for (const q of ONBOARDING_QUESTIONS) {
      expect(q.question.length).toBeGreaterThan(0);
    }
  });

  it('select / multi-select questions all carry options', () => {
    for (const q of ONBOARDING_QUESTIONS) {
      if (q.type === 'select' || q.type === 'multi-select') {
        expect(q.options).toBeDefined();
        expect((q.options ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  it('all six categories are represented', () => {
    const categories = new Set(ONBOARDING_QUESTIONS.map((q) => q.category));
    for (const c of ['persona', 'brand', 'goal', 'voice', 'cadence', 'targets']) {
      expect(categories.has(c as never)).toBe(true);
    }
  });

  it('findQuestionById / indexOfQuestion / nextQuestion', () => {
    const first = firstQuestion();
    expect(findQuestionById(first.id)).toEqual(first);
    expect(indexOfQuestion(first.id)).toBe(0);
    expect(indexOfQuestion('does-not-exist')).toBe(-1);
    expect(nextQuestion(first.id)?.id).toBe(ONBOARDING_QUESTIONS[1]?.id);
    const last = ONBOARDING_QUESTIONS[ONBOARDING_QUESTIONS.length - 1]!;
    expect(nextQuestion(last.id)).toBeNull();
  });

  it('resolveChoiceKey accepts label / key / case-insensitive', () => {
    const personaStyle = ONBOARDING_QUESTIONS.find((q) => q.id === 'persona_style');
    expect(personaStyle).toBeDefined();
    expect(resolveChoiceKey(personaStyle!, 'practical_operator')).toBe('practical_operator');
    expect(resolveChoiceKey(personaStyle!, '実務家')).toBe('practical_operator');
    expect(resolveChoiceKey(personaStyle!, 'PRACTICAL_OPERATOR')).toBe('practical_operator');
    expect(resolveChoiceKey(personaStyle!, 'unknown choice')).toBeNull();
  });
});
