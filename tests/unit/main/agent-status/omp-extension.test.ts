import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

const servers: Server[] = [];
afterEach(() => { for (const server of servers) server.close(); servers.length = 0; });

describe('app-owned OMP extension', () => {
  it('reports root lifecycle without sending prompt, tool args or Herdr data', async () => {
    const reports: Array<Record<string, unknown>> = [];
    let complete: () => void = () => {};
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    const server = createServer((socket) => {
      let message = '';
      socket.on('data', (part: Buffer) => { message += part.toString(); });
      socket.on('end', () => {
        const parsed: unknown = JSON.parse(message);
        if (typeof parsed === 'object' && parsed !== null && 'report' in parsed && typeof parsed.report === 'object' && parsed.report !== null) {
          reports.push({ ...parsed.report });
          if (reports.length === 6) complete();
        }
        socket.end('ok\n');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('listener missing');
    const old = [process.env.METAIDE_OMP_STATUS_PORT, process.env.METAIDE_OMP_STATUS_SPAWN, process.env.METAIDE_OMP_STATUS_TOKEN, process.env.OMPCODE];
    process.env.METAIDE_OMP_STATUS_PORT = String(address.port);
    process.env.METAIDE_OMP_STATUS_SPAWN = 'owned-spawn';
    process.env.METAIDE_OMP_STATUS_TOKEN = 'owned-token';
    delete process.env.OMPCODE;
    try {
      const location = new URL('../../../../resources/omp-status-extension.js', import.meta.url).href;
      const extension: unknown = await import(location);
      if (typeof extension !== 'object' || extension === null || !('default' in extension) || typeof extension.default !== 'function') throw new Error('extension factory missing');
      const handlers = new Map<string, (event: Record<string, unknown>, context: Record<string, unknown>) => void>();
      extension.default({ on: (name: string, handler: (event: Record<string, unknown>, context: Record<string, unknown>) => void) => { handlers.set(name, handler); } });
      const context = { hasUI: true, sessionManager: { getSessionId: () => 'session-1' }, isIdle: () => true };
      handlers.get('session_start')?.({}, context);
      handlers.get('agent_start')?.({}, context);
      handlers.get('tool_approval_requested')?.({ reason: 'secret', args: { token: 'do-not-send' } }, context);
      handlers.get('tool_approval_resolved')?.({}, context);
      handlers.get('agent_end')?.({}, context);
      await completed;
      expect(reports.map((report) => report.event)).toEqual(['session_start', 'session_start', 'agent_start', 'approval_requested', 'approval_resolved', 'agent_end']);
      expect(JSON.stringify(reports)).not.toContain('do-not-send');
      expect(JSON.stringify(reports)).not.toContain('secret');
      process.env.OMPCODE = '1';
      const nestedHandlers: string[] = [];
      extension.default({ on: (name: string) => { nestedHandlers.push(name); } });
      expect(nestedHandlers).toEqual([]);
    } finally {
      for (const [name, value] of [['METAIDE_OMP_STATUS_PORT', old[0]], ['METAIDE_OMP_STATUS_SPAWN', old[1]], ['METAIDE_OMP_STATUS_TOKEN', old[2]], ['OMPCODE', old[3]]] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name); else process.env[name] = value;
      }
    }
  });
});
