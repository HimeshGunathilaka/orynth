import type { Operation } from "./types.js";

/**
 * The operations an instance owns, one per ID. An operation claims its ID when it
 * starts executing (or is restored) and releases it only once it is resolved
 * and its stored record has been deleted, so a stored record never gets a
 * second handle while the first one is still around.
 */
export class Registry {
  readonly #owners = new Map<string, Operation>();
  /** IDs whose stored records were deleted during each `restore()` in progress. */
  readonly #restores = new Set<Set<string>>();

  get(id: string): Operation | undefined {
    return this.#owners.get(id);
  }

  values(): Operation[] {
    return [...this.#owners.values()];
  }

  /** Returns `false` if another operation owns the ID. */
  claim(operation: Operation): boolean {
    const owner = this.#owners.get(operation.id);
    if (owner && owner !== operation) return false;
    this.#owners.set(operation.id, operation);
    return true;
  }

  release(operation: Operation): void {
    if (this.#owners.get(operation.id) === operation) this.#owners.delete(operation.id);
  }

  /**
   * The stored record of `id` was deleted: a restore that read it earlier
   * holds a stale snapshot. (An operation that never stored a record, e.g.
   * because another one was already stored under its ID, must not call this.)
   */
  deleted(id: string): void {
    for (const deleted of this.#restores) deleted.add(id);
  }

  /**
   * Runs `restore` with the set of IDs whose records are deleted while it
   * runs: records it reads for those IDs may predate their deletion.
   */
  async whileRestoring<T>(restore: (deleted: ReadonlySet<string>) => Promise<T>): Promise<T> {
    const deleted = new Set<string>();
    this.#restores.add(deleted);
    try {
      return await restore(deleted);
    } finally {
      this.#restores.delete(deleted);
    }
  }
}
