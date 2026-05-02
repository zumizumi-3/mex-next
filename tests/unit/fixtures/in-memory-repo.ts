/**
 * In-memory `AccountRepo` for unit tests.
 *
 * Sequentializes calls under a simple promise-chain "lock" so the
 * `withStateLock` contract is preserved (concurrent callers see a
 * serialized view).
 */

import type {
  AccountJson,
  AccountRepo,
  StateJson,
} from '../../../src/account-state/types.js';

export interface InMemoryRepoOpts {
  account?: AccountJson;
  state?: StateJson;
  drafts?: Record<string, { text: string; topic?: string }>;
}

export class InMemoryAccountRepo implements AccountRepo {
  readonly accountRepoPath = '/in-memory';
  private account: AccountJson;
  private state: StateJson;
  private drafts: Record<string, { text: string; topic?: string }>;
  private lockChain: Promise<void> = Promise.resolve();

  constructor(opts: InMemoryRepoOpts = {}) {
    this.account = opts.account ?? {};
    this.state = opts.state ?? {};
    this.drafts = opts.drafts ?? {};
  }

  async loadAccount(): Promise<AccountJson> {
    return clone(this.account);
  }

  async saveAccount(account: AccountJson): Promise<void> {
    this.account = clone(account);
  }

  async loadState(): Promise<StateJson> {
    return clone(this.state);
  }

  async saveState(state: StateJson): Promise<void> {
    this.state = clone(state);
  }

  async loadDraftText(contentId: string): Promise<{ text: string; topic: string } | null> {
    const d = this.drafts[contentId];
    if (!d) return null;
    return { text: d.text, topic: d.topic ?? '' };
  }

  setDraft(contentId: string, draft: { text: string; topic?: string }): void {
    this.drafts[contentId] = draft;
  }

  /** Convenience: peek at the persisted state without going through lock. */
  peekState(): StateJson {
    return clone(this.state);
  }

  /** Convenience: peek at the persisted account. */
  peekAccount(): AccountJson {
    return clone(this.account);
  }

  async withStateLock<T>(
    mutator: (state: StateJson) => Promise<{ state: StateJson; result: T }>,
  ): Promise<T> {
    let release!: () => void;
    const wait = new Promise<void>((res) => (release = res));
    const prior = this.lockChain;
    this.lockChain = wait;
    await prior;
    try {
      const fresh = clone(this.state);
      const { state, result } = await mutator(fresh);
      this.state = clone(state);
      return result;
    } finally {
      release();
    }
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
