import type { Operation } from "./types.js";

/**
 * The operations a guard owns, one per ID. An operation claims its ID when it
 * starts executing (or is restored) and releases it only once it is resolved
 * and its stored record has been deleted, so a stored record never gets a
 * second handle while the first one is still around.
 */
export class Registry {
  readonly #owners = new Map<string, Operation>();
  /** IDs released during each `restore()` in progress. */
  readonly #restores = new Set<Set<string>>();

  get(id: string): Operation | undefined {
    return this.#owners.get(id);
  }

  /** Returns `false` if another operation owns the ID. */
  claim(operation: Operation): boolean {
    const owner = this.#owners.get(operation.id);
    if (owner && owner !== operation) return false;
    this.#owners.set(operation.id, operation);
    return true;
  }

  release(operation: Operation): void {
    if (this.#owners.get(operation.id) !== operation) return;
    this.#owners.delete(operation.id);
    for (const released of this.#restores) released.add(operation.id);
  }

  /**
   * Runs `restore` with the set of IDs released while it runs: records it
   * reads for those IDs may predate their deletion.
   */
  async whileRestoring<T>(restore: (released: ReadonlySet<string>) => Promise<T>): Promise<T> {
    const released = new Set<string>();
    this.#restores.add(released);
    try {
      return await restore(released);
    } finally {
      this.#restores.delete(released);
    }
  }
}
