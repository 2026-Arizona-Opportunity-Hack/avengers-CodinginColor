import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Shown in live mode for screens whose server routes have not landed yet (issue #59). */
@Component({
  selector: 'app-not-connected',
  imports: [RouterLink],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <p class="label eyebrow">Not connected yet</p>
          <h1>This screen still runs on demo data</h1>
          <p class="lede">Its server routes are still in review, so it is hidden while you are signed in to live data.
            Nothing here would be saved.</p>
        </div>
      </header>
      <p><a class="btn primary" routerLink="/donors">Go to donors</a></p>
    </div>
  `,
})
export class NotConnectedPage {}
