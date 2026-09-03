import { randomUUID } from "crypto";
import { JobEvent } from "../contract/types.js";

export interface EventJournal {
  appendEvent(
    jobId: string,
    type: JobEvent["type"],
    payload?: any,
    payloadRef?: string
  ): Promise<JobEvent>;
  getEvents(jobId: string, afterSeq?: number): Promise<JobEvent[]>;
}

/**
 * In-memory reference implementation of the monotonic, typed Event Journal.
 * Guarantees:
 * - `seq` is strictly monotonic and starts at 1 per job.
 * - Unique `seq` constraint per job (append-only).
 * - Thread-safe (using simple async synchronization/queuing if needed, or JS single-thread execution guarantees).
 */
export class InMemoryEventJournal implements EventJournal {
  private journals = new Map<string, JobEvent[]>();

  public async appendEvent(
    jobId: string,
    type: JobEvent["type"],
    payload?: any,
    payloadRef?: string
  ): Promise<JobEvent> {
    let events = this.journals.get(jobId);
    if (!events) {
      events = [];
      this.journals.set(jobId, events);
    }

    const nextSeq = events.length + 1;
    const event: JobEvent = {
      jobId,
      seq: nextSeq,
      eventId: randomUUID(),
      type,
      createdAt: new Date().toISOString(),
      payloadRef,
      payload
    };

    // Ensure strict monotonicity/uniqueness
    if (events.length > 0 && events[events.length - 1].seq >= nextSeq) {
      throw new Error(`MonotonicityViolation: Duplicate or decreasing sequence number '${nextSeq}' for job '${jobId}'`);
    }

    events.push(event);
    return event;
  }

  public async getEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    const events = this.journals.get(jobId) || [];
    // filter returns events strictly AFTER afterSeq
    return events.filter((e) => e.seq > afterSeq);
  }

  public clear(jobId?: string) {
    if (jobId) {
      this.journals.delete(jobId);
    } else {
      this.journals.clear();
    }
  }
}
