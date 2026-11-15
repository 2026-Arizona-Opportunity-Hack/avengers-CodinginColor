import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmToasterImports } from '@spartan-ng/helm/sonner';

/** Root: sign-in renders on its own; every other screen renders inside the Shell. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, HlmToasterImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet /><hlm-toaster position="bottom-right" />`,
})
export class App {}
