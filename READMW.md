# Call Campaign Simulator

## How to Build and Run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the development server (configured using `tsx`):
   ```bash
   npm run dev
   ```
3. To test the core business logic, you can run tests using your runner of choice or run the built files simply with:
   ```bash
   npm run start
   ```

## Design Architecture

The simulator is designed as an **Event-Driven State Machine**.
Rather than relying on `setInterval` loops or complex Promise chains, the core logic is centralized in a `tryDispatch()` function. This function acts as a "pump." It is triggered whenever the system state changes (a campaign starts, a call finishes, or a retry timer completes). On every invocation, it evaluates all constraints (concurrency, hours, quotas). If all constraints pass, it pops a task and recurses; if blocked by time, it schedules a wakeup timer using the provided `IClock`.

### Edge Cases & Assumptions Handled

1. **The "Risk Exceeding" Daily Quota Paradox**
   The requirements state we cannot start a call if it "risks exceeding" the daily minutes. Because the duration of a call isn't known until the `CallHandler` promise resolves, it is impossible to predict the exact minute count beforehand.
   * **Assumption**: I implemented a standard "soft cap" approach. The dispatcher checks if `current minutes >= max minutes` before starting a call. If we have 119/120 minutes used, the next call is permitted. Once it completes, the total will exceed 120, and all subsequent calls will be blocked until midnight.

2. **Retries vs. Primary Queue Priority**
   * **Assumption**: When a retry timer pops, that number is pushed to the front (`unshift`) of the queue. Retries represent sunk time/effort, so prioritizing them over uncalled numbers ensures they clear out of the system faster.

3. **Unexpected Handler Errors**
   * **Assumption**: If the injected `CallHandler` throws an unhandled Promise rejection, the system catches it and treats it as a standard failed call (`answered: false`) rather than crashing the campaign loop.

4. **Timezone Transitions (Plus Task)**
   * **Assumption**: I utilized `luxon` to interpret `startTime`, `endTime`, and midnight resets dynamically. By converting `IClock.now()` epoch milliseconds into the target timezone on every check, the system inherently survives Daylight Saving Time (DST) transitions. A hardcoded "+X hours" offset would break during DST, but `luxon` handles the IANA rules natively.
