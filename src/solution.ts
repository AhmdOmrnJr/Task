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
