/**
 * One owner for browser tab lifetime.
 *
 * Automation tabs are temporary: a tab created during a turn closes when the
 * turn ends unless the agent marks it as a deliverable (shown to the user) or a
 * handoff (continued in a later turn). Tabs the user opened or claimed are
 * never closed here. Marks are turn-scoped; a tab that survives a turn becomes
 * persistent and is only closed explicitly afterwards.
 */
export type TabMark = "deliverable" | "handoff";
export type TabOrigin = "user" | "agent" | "background" | "headless";
export type ClaimedTab = { tabId: string; title?: string; url?: string };

export type TabLifecycleRecord = {
  sessionId: string;
  tabId: string;
  origin: TabOrigin;
  /** Turn that created the tab; undefined once it became persistent. */
  turnId?: string;
  marks: Set<TabMark>;
  claimed: boolean;
  createdAt: number;
};

const keyOf = (sessionId: string, tabId: string) => `${sessionId}\u0000${tabId}`;

export class TabLifecycle {
  private readonly tabs = new Map<string, TabLifecycleRecord>();
  private readonly turns = new Map<string, string>();
  /** One owner for the session's claimed tab (CUA and tools read this). */
  private readonly claims = new Map<string, ClaimedTab>();

  noteTurnStarted(sessionId: string, turnId: string): void {
    if (sessionId) this.turns.set(sessionId, turnId);
  }

  noteTurnEnded(sessionId: string, turnId?: string): void {
    const current = this.turns.get(sessionId);
    if (!turnId || !current || current === turnId) this.turns.delete(sessionId);
  }

  currentTurn(sessionId: string): string | undefined {
    return this.turns.get(sessionId);
  }

  register(sessionId: string, tabId: string, origin: TabOrigin = "agent"): TabLifecycleRecord {
    const key = keyOf(sessionId, tabId);
    const existing = this.tabs.get(key);
    if (existing) {
      if (origin !== existing.origin && origin !== "agent") existing.origin = origin;
      return existing;
    }
    const record: TabLifecycleRecord = {
      sessionId,
      tabId,
      origin,
      ...(this.turns.get(sessionId) ? { turnId: this.turns.get(sessionId) } : {}),
      marks: new Set(),
      claimed: false,
      createdAt: Date.now(),
    };
    this.tabs.set(key, record);
    return record;
  }

  has(sessionId: string, tabId: string): boolean {
    return this.tabs.has(keyOf(sessionId, tabId));
  }

  record(sessionId: string, tabId: string): TabLifecycleRecord | undefined {
    return this.tabs.get(keyOf(sessionId, tabId));
  }

  mark(sessionId: string, tabId: string, mark: TabMark): void {
    this.register(sessionId, tabId).marks.add(mark);
  }

  unmark(sessionId: string, tabId: string, mark: TabMark): void {
    this.record(sessionId, tabId)?.marks.delete(mark);
  }

  isMarked(sessionId: string, tabId: string, mark: TabMark): boolean {
    return this.record(sessionId, tabId)?.marks.has(mark) === true;
  }

  marks(sessionId: string, tabId: string): TabMark[] {
    return [...(this.record(sessionId, tabId)?.marks ?? [])];
  }

  claim(sessionId: string, claim: string | ClaimedTab): void {
    const value = typeof claim === "string" ? { tabId: claim } : claim;
    const tabId = value.tabId.trim();
    if (!tabId) throw new Error("claim requires a tab id");
    this.register(sessionId, tabId, "user").claimed = true;
    this.claims.set(sessionId, {
      tabId,
      ...(value.title ? { title: value.title } : {}),
      ...(value.url ? { url: value.url } : {}),
    });
  }

  release(sessionId: string, tabId?: string): void {
    if (tabId) {
      const record = this.record(sessionId, tabId);
      if (record) record.claimed = false;
      if (this.claims.get(sessionId)?.tabId === tabId) this.claims.delete(sessionId);
      return;
    }
    for (const record of this.tabs.values()) {
      if (record.sessionId === sessionId) record.claimed = false;
    }
    this.claims.delete(sessionId);
  }

  claimedTab(sessionId: string): ClaimedTab | undefined {
    return this.claims.get(sessionId);
  }

  claimedTabId(sessionId: string): string | undefined {
    return this.claims.get(sessionId)?.tabId ?? this.claimedRecordId(sessionId);
  }

  private claimedRecordId(sessionId: string): string | undefined {
    for (const record of this.tabs.values()) {
      if (record.sessionId === sessionId && record.claimed) return record.tabId;
    }
    return undefined;
  }

  close(sessionId: string, tabId: string): void {
    this.tabs.delete(keyOf(sessionId, tabId));
  }

  clearSession(sessionId: string): void {
    for (const [key, record] of [...this.tabs]) {
      if (record.sessionId === sessionId) this.tabs.delete(key);
    }
    this.turns.delete(sessionId);
    this.claims.delete(sessionId);
  }

  /** This session's records, for diagnostics and tests. */
  list(sessionId?: string): TabLifecycleRecord[] {
    return [...this.tabs.values()].filter((record) => !sessionId || record.sessionId === sessionId);
  }

  /**
   * Close candidates for the end of a turn: automation tabs created in that
   * turn without a deliverable/handoff mark. The caller closes them and then
   * calls `settleTurn`.
   */
  tabsToCloseOnTurnEnd(sessionId: string, turnId?: string): string[] {
    const turn = turnId ?? this.turns.get(sessionId);
    return [...this.tabs.values()]
      .filter((record) => record.sessionId === sessionId)
      .filter((record) => record.origin !== "user" && !record.claimed)
      .filter((record) => !record.marks.size)
      .filter((record) => (turn ? record.turnId === turn : record.turnId !== undefined))
      .map((record) => record.tabId);
  }

  /**
   * After a turn ends, surviving automation tabs become persistent and their
   * turn-scoped marks are cleared, matching Codex: the next turn must mark a
   * tab again for it to survive that turn.
   */
  settleTurn(sessionId: string, turnId?: string): void {
    const turn = turnId ?? this.turns.get(sessionId);
    for (const record of this.tabs.values()) {
      if (record.sessionId !== sessionId) continue;
      if (turn && record.turnId !== turn) continue;
      record.marks.clear();
      record.turnId = undefined;
    }
  }
}
