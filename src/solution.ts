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
