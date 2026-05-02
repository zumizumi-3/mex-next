/**
 * Repo adapter.
 *
 * The codebase has TWO `AccountRepo` shapes:
 *  - `src/account-state/repo.ts` — the concrete class that zod-parses.
 *  - `src/account-state/types.ts` and `src/posting/types.ts` —
 *    structural interfaces used by posting/settings/x-api modules.
 *
 * The interfaces in *types.ts* expose `loadAccount`/`loadState`/
 * `withStateLock`/`saveAccount`/`saveState`/`loadDraftText`. The class
 * implements all of these (compat aliases were added to `repo.ts`)
 * but TypeScript still flags incompatibility because the inferred
 * zod return type is wider than the structural `AccountJson` interface.
 *
 * `asPostingRepo` casts a real `AccountRepo` instance into the
 * structural interface so it can be passed into posting/settings APIs
 * without TypeScript noise. The runtime shape is the same — only the
 * compile-time descriptor narrows.
 */

import type { AccountRepo as AccountRepoClass } from '../account-state/repo.js';
import type { AccountRepo as PostingRepo } from '../account-state/types.js';
import type { AccountRepo as PostingMachineRepo } from '../posting/types.js';

export function asPostingRepo(repo: AccountRepoClass): PostingRepo {
  return repo as unknown as PostingRepo;
}

export function asPostingMachineRepo(repo: AccountRepoClass): PostingMachineRepo {
  return repo as unknown as PostingMachineRepo;
}
