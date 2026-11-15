import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';

@Component({
  selector: 'app-board-guide',
  imports: [RouterLink, HlmButtonImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mx-4 mt-4 rounded-xl border bg-card p-4" aria-label="Board member guide">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">Your workspace guide</h2>
        <button #toggle hlmBtn variant="ghost" size="sm" type="button" [attr.aria-expanded]="open()"
          aria-controls="board-guide-content" (click)="open.set(!open())">{{ open() ? 'Dismiss guide' : 'Open guide' }}</button>
      </div>
      @if (open()) {
        <div id="board-guide-content" class="mt-3 text-sm" aria-live="polite">
          <p class="text-muted-foreground">Step {{ step() + 1 }} of 3</p>
          @switch (step()) {
            @case (0) {
              <p class="mt-2"><a class="underline" routerLink="/donors">Your donors</a> shows the donors assigned to you. Select a name to open their record and giving history.</p>
            }
            @case (1) {
              <p class="mt-2">In a donor record, use <strong>Log call</strong> or <strong>Log text</strong> to record a conversation. Under Next steps, enter an action and due date, then select <strong>Add</strong>.</p>
            }
            @case (2) {
              <p class="mt-2">Open <a class="underline" routerLink="/outreach">Follow-ups</a> for upcoming actions and drafts. Review the exact text before approval. After composing a message in your email or text app, confirm it was sent to record it.</p>
            }
          }
          <div class="mt-3 flex gap-2">
            <button hlmBtn variant="outline" size="sm" type="button" [disabled]="step() === 0" (click)="step.set(step() - 1)">Back</button>
            <button hlmBtn size="sm" type="button" (click)="advance(toggle)">{{ step() < 2 ? 'Next' : 'Finish guide' }}</button>
          </div>
        </div>
      }
    </section>
  `,
})
export class BoardGuide {
  protected readonly open = signal(true);
  protected readonly step = signal(0);
  protected advance(toggle: HTMLButtonElement) {
    if (this.step() < 2) this.step.update(step => step + 1);
    else { this.open.set(false); this.step.set(0); toggle.focus(); }
  }
}
