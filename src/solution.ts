import { DateTime } from "luxon";
import {
    ICampaign,
    CampaignConfig,
    CallHandler,
    IClock,
    CampaignStatus,
    CampaignState,
} from "./interrfaces/interfaces";

interface QueueItem {
  phoneNumber: string;
  attempts: number;
}

export class Campaign implements ICampaign {
  private state: CampaignState = "idle";
  
  private totalProcessed = 0;
  private totalFailed = 0;
  private activeCalls = 0;
  private pendingRetries = 0;
  private dailyMinutesUsed = 0;

  private queue: QueueItem[] = [];
  
  private currentDayString: string = "";

  private wakeupTimerId: number | null = null;
  private scheduledRetries: Array<{ task: QueueItem; executeAt: number; timerId: number | null }> = [];

  constructor(
    private config: CampaignConfig,
    private callHandler: CallHandler,
    private clock: IClock
  ) {
    this.queue = this.config.customerList.map(num => ({
      phoneNumber: num,
      attempts: 0,
    }));
  }

  public start(): void {
    if (this.state === "running" || this.state === "completed") return;
    this.state = "running";
    this.tryDispatch();
  }

  public pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    
    if (this.wakeupTimerId !== null) {
      this.clock.clearTimeout(this.wakeupTimerId);
      this.wakeupTimerId = null;
    }
    for (const retry of this.scheduledRetries) {
      if (retry.timerId !== null) {
        this.clock.clearTimeout(retry.timerId);
        retry.timerId = null;
      }
    }
  }

  public resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    
    const now = this.clock.now();
    const remainingRetries = [];
    
    for (const retry of this.scheduledRetries) {
      if (retry.executeAt <= now) {
        this.enqueueRetry(retry.task);
      } else {
        retry.timerId = this.clock.setTimeout(() => {
          const idx = this.scheduledRetries.indexOf(retry);
          if (idx !== -1) this.scheduledRetries.splice(idx, 1);
          this.enqueueRetry(retry.task);
        }, retry.executeAt - now);
        remainingRetries.push(retry);
      }
    }
    this.scheduledRetries = remainingRetries;
    this.tryDispatch();
  }

  private enqueueRetry(task: QueueItem): void {
    this.pendingRetries--;
    this.queue.unshift(task);
    this.tryDispatch();
  }

  public getStatus(): CampaignStatus {
    return {
      state: this.state,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      activeCalls: this.activeCalls,
      pendingRetries: this.pendingRetries,
      dailyMinutesUsed: this.dailyMinutesUsed,
    };
  };

  /**
   * The core engine. Evaluates state and constraints, and initiates calls if allowed.
   */
  private tryDispatch(): void {
    if (this.state !== "running") return;

    this.checkAndResetDailyQuota();

    if (this.queue.length === 0 && this.activeCalls === 0 && this.pendingRetries === 0) {
      this.state = "completed";
      return;
    }
    if (this.activeCalls >= this.config.maxConcurrentCalls) return;

    if (this.dailyMinutesUsed >= this.config.maxDailyMinutes) {
      this.scheduleWakeUp(this.getMsUntilNextMidnight());
      return;
    }

    if (!this.isWithinWorkingHours()) {
      this.scheduleWakeUp(this.getMsUntilNextStartWindow());
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    this.executeCall(task);

    this.tryDispatch();
  }

  private async executeCall(task: QueueItem): Promise<void> {
    this.activeCalls++;

    try {
      const result = await this.callHandler(task.phoneNumber);
      this.activeCalls--;
      
      // Convert ms to minutes for daily tracking
      const callMinutes = result.durationMs / 60000;
      this.dailyMinutesUsed += callMinutes;

      if (result.answered) {
        this.totalProcessed++;
      } else {
        this.handleFailure(task);
      }
    } catch (error) {
      // If the handler throws an unexpected error, treat it as a failed call
      this.activeCalls--;
      this.handleFailure(task);
    }

    // The state changed, trigger the pump
    this.tryDispatch();
  }

  private handleFailure(task: QueueItem): void {
    const maxRetries = this.config.maxRetries ?? 2;
    const retryDelayMs = this.config.retryDelayMs ?? 3600000;

    if (task.attempts < maxRetries) {
      this.pendingRetries++;
      task.attempts++;

      const executeAt = this.clock.now() + retryDelayMs;
      const retryRecord = { task, executeAt, timerId: null as number | null };
      
      retryRecord.timerId = this.clock.setTimeout(() => {
        const idx = this.scheduledRetries.indexOf(retryRecord);
        if (idx !== -1) this.scheduledRetries.splice(idx, 1);
        this.enqueueRetry(retryRecord.task);
      }, retryDelayMs);
      
      this.scheduledRetries.push(retryRecord);
    } else {
      this.totalFailed++;
    }
  }

  // --- Time & Timezone Utilities ---

  private getTimezone(): string {
    return this.config.timezone || "UTC";
  }

  private getNowInZone(): DateTime {
    return DateTime.fromMillis(this.clock.now()).setZone(this.getTimezone());
  }

  private checkAndResetDailyQuota(): void {
    const now = this.getNowInZone();
    const todayString = now.toFormat("yyyy-MM-dd");

    if (this.currentDayString !== todayString) {
      this.dailyMinutesUsed = 0;
      this.currentDayString = todayString;
    }
  }

  private isWithinWorkingHours(): boolean {
    const now = this.getNowInZone();
    
    const startObj = DateTime.fromFormat(this.config.startTime, "HH:mm", { zone: this.getTimezone() });
    const endObj = DateTime.fromFormat(this.config.endTime, "HH:mm", { zone: this.getTimezone() });

    // Compare minutes from midnight to handle edge cases simply
    const currentMinutes = now.hour * 60 + now.minute;
    const startMinutes = startObj.hour * 60 + startObj.minute;
    const endMinutes = endObj.hour * 60 + endObj.minute;

    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  private getMsUntilNextStartWindow(): number {
    const now = this.getNowInZone();
    let nextStart = DateTime.fromFormat(this.config.startTime, "HH:mm", { zone: this.getTimezone() })
      .set({ year: now.year, month: now.month, day: now.day });

    // If the start time has already passed today, the next window is tomorrow
    if (now > nextStart) {
      nextStart = nextStart.plus({ days: 1 });
    }

    return nextStart.toMillis() - now.toMillis();
  }

  private getMsUntilNextMidnight(): number {
    const now = this.getNowInZone();
    const nextMidnight = now.startOf("day").plus({ days: 1 });
    return nextMidnight.toMillis() - now.toMillis();
  }

  private scheduleWakeUp(delayMs: number): void {
    if (this.wakeupTimerId !== null) return; 

    this.wakeupTimerId = this.clock.setTimeout(() => {
      this.wakeupTimerId = null;
      this.tryDispatch();
    }, delayMs);
  }
}