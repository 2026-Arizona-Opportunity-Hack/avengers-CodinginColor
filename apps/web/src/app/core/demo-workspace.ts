/** Explicit, tab-local presentation mode is selected before Clerk or the live API starts. */
export function demoWorkspaceMode(): 'enter' | 'resume' | null {
  const requested = new URLSearchParams(location.search).get('demo');
  let enabled = false;
  try {
    enabled = sessionStorage.getItem('cadence.demo-workspace') === '1';
    if (requested === '1') sessionStorage.setItem('cadence.demo-workspace', '1');
    if (requested === '0') sessionStorage.removeItem('cadence.demo-workspace');
  } catch { /* The URL still permits a demo when browser storage is unavailable. */ }
  if (requested === '0') return null;
  if (requested === '1') return enabled ? 'resume' : 'enter';
  return enabled ? 'resume' : null;
}
