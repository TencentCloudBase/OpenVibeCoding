import type { ExtendedSessionUpdate, StreamEvent } from '@coder/shared'
import { persistenceService } from './persistence.service.js'
import { getNextSeq } from './agent-registry.js'
import { v4 as uuidv4 } from 'uuid'

// ─── Milestone event types that trigger immediate flush ─────────────

const MILESTONE_SESSION_UPDATES = new Set(['tool_call', 'tool_call_update', 'ask_user', 'tool_confirm', 'artifact'])

// ─── EventBuffer ───────────────────────────────────────────────────────

export class EventBuffer {
  private buffer: StreamEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushPromise: Promise<void> | null = null
  private readonly MAX_BUFFER_SIZE = 10
  private readonly FLUSH_INTERVAL_MS = 500

  constructor(
    private conversationId: string,
    private turnId: string,
    private envId: string,
    private userId: string,
  ) {}

  push(event: ExtendedSessionUpdate): void {
    this.pushAndGetSeq(event)
  }

  pushAndGetSeq(event: ExtendedSessionUpdate): number {
    const seq = getNextSeq(this.conversationId)
    this.buffer.push({
      eventId: uuidv4(),
      conversationId: this.conversationId,
      turnId: this.turnId,
      envId: this.envId,
      userId: this.userId,
      event,
      seq,
      createTime: Date.now(),
    })

    const isMilestone = 'sessionUpdate' in event && MILESTONE_SESSION_UPDATES.has(event.sessionUpdate)

    if (isMilestone || this.buffer.length >= this.MAX_BUFFER_SIZE) {
      this.flush()
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.FLUSH_INTERVAL_MS)
    }

    return seq
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.buffer.length === 0) return

    const batch = this.buffer.splice(0)
    // Fire-and-forget write, but track the promise for close()
    this.flushPromise = persistenceService.appendStreamEvents(batch).catch((err) => {
      console.error('EventBuffer flush failed:', err)
    })
  }

  async close(): Promise<void> {
    this.flush()
    if (this.flushPromise) {
      await this.flushPromise
    }
  }
}
