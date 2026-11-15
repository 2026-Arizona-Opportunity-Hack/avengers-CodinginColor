/** The public app stays synthetic before configuration or authentication can start. */
export function demoWorkspaceMode(): 'enter' | 'sign-in' | 'resume' {
  const requested = new URLSearchParams(location.search).get('demo');
  let enabled = false;
  try {
    enabled = sessionStorage.getItem('cadence.demo-workspace') === '1';
    sessionStorage.setItem('cadence.demo-workspace', '1');
  } catch { /* The URL still permits a demo when browser storage is unavailable. */ }
  if (requested === '0') history.replaceState(history.state, '', '/sign-in');
  if (requested === '1') {
    history.replaceState(history.state, '', '/');
    return enabled ? 'sign-in' : 'enter';
  }
  return 'resume';
}
