/** Reports root interactive OMP lifecycle to MetaLogixIDE without sending prompts or tool arguments. */
import { createConnection } from 'node:net';
const transmission = { queued: 0, previous: Promise.resolve(), sequence: 0 };

/** Registers root-only OMP lifecycle hooks; invalid child environment leaves OMP unchanged. */
export default function installStatusExtension(pi) {
  const port = Number(process.env.METAIDE_OMP_STATUS_PORT);
  const spawn = process.env.METAIDE_OMP_STATUS_SPAWN;
  const token = process.env.METAIDE_OMP_STATUS_TOKEN;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !spawn || !token || process.env.OMPCODE === '1') return;

  let root = false;
  let activeSession = '';

  function transmit(report) {
    if (transmission.queued >= 64) return;
    transmission.queued++;
    const line = JSON.stringify({ spawn, token, report }) + '\n';
    transmission.previous = transmission.previous.then(() => new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      const done = () => { socket.destroy(); resolve(); };
      socket.setTimeout(300, done);
      socket.once('connect', () => socket.end(line));
      socket.once('error', done);
      socket.once('close', done);
    })).then(() => { transmission.queued--; });
  }

  function report(event, extra = {}) {
    if (!root || !activeSession) return;
    transmit({ version: 1, session: activeSession, seq: ++transmission.sequence, event, ...extra });
  }

  function activate(ctx, event) {
    if (ctx?.hasUI !== true) return false;
    const session = ctx.sessionManager?.getSessionId?.();
    if (typeof session !== 'string' || session.length === 0) return false;
    root = true;
    activeSession = session;
    report(event === 'session_start' && transmission.sequence > 0 ? 'session_switch' : event, { active: ctx.isIdle?.() === false });
    return true;
  }

  pi.on('session_start', (_event, ctx) => { activate(ctx, 'session_start'); });
  pi.on('session_switch', (_event, ctx) => { activate(ctx, 'session_switch'); });
  pi.on('agent_start', (_event, ctx) => {
    if (!root && !activate(ctx, 'session_start')) return;
    report('session_start', { active: true });
    report('agent_start');
  });
  pi.on('agent_end', (event) => { report('agent_end', { willContinue: event?.willContinue === true }); });
  pi.on('tool_approval_requested', () => { report('approval_requested'); });
  pi.on('tool_approval_resolved', () => { report('approval_resolved'); });
  pi.on('tool_execution_start', (event) => { if (event?.toolName === 'ask') report('ask_start'); });
  pi.on('tool_execution_end', (event) => { if (event?.toolName === 'ask') report('ask_end'); });
}
