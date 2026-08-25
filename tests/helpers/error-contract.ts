/**
 * @fileoverview Reads a definition's declared error contract back, so a test can
 * assert what reaches the client against the contract itself rather than against
 * a second copy of its wording. A hint asserted as a string literal drifts the
 * moment the contract is reworded; one read off `errors[]` cannot.
 * @module tests/helpers/error-contract
 */

/** A declared contract entry, read structurally so tools and resources both fit. */
export interface DeclaredError {
  code: number;
  reason: string;
  recovery: string;
  retryable?: boolean | undefined;
  when: string;
}

/**
 * Any definition carrying a declared error contract. `errors` is optional on the
 * framework's definition types, so it is optional here too — a definition that
 * declares none still fits, and {@link declaredError} is what turns an absent
 * contract into a failed assertion rather than a silent undefined.
 */
export interface WithErrors {
  errors?: readonly DeclaredError[] | undefined;
}

/** The contract a definition declares, or an empty list when it declares none. */
export function declaredErrors(def: WithErrors): readonly DeclaredError[] {
  return def.errors ?? [];
}

/**
 * The entry a definition declares for a reason.
 *
 * Throws on a missing entry rather than returning undefined: a comparison
 * against undefined passes whenever the other side is also undefined, which is
 * exactly the false green this helper exists to prevent.
 */
export function declaredError(def: WithErrors, reason: string): DeclaredError {
  const entries = declaredErrors(def);
  const entry = entries.find((e) => e.reason === reason);
  if (!entry) {
    throw new Error(
      `No "${reason}" contract entry — declared: ${entries.map((e) => e.reason).join(', ')}`,
    );
  }
  return entry;
}

/** The recovery hint a definition declares for a reason. */
export function declaredRecovery(def: WithErrors, reason: string): string {
  return declaredError(def, reason).recovery;
}
