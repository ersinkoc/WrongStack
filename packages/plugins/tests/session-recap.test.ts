/**
 * @wrongstack/plugins — session-recap plugin tests
 *
 * Covers:
 *  - Event subscription accumulation (provider.response, tool.*, tool.result)
 *  - Stop hook payload shape and mailbox broadcast
 *  - Graceful no-op when api.mailbox is undefined
 *  - Transcript tail reading (with and without a transcript path)
 *  - H1 audit pattern (teardown + health + idempotent re-init)
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sessionRecapPlugin from '../src/session-recap/index.js';

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

interface PluginAPI {
  tools: { register: ReturnType<typeof vi.fn> };
  slashCommands: { register: ReturnType<typeof vi.fn> };
  pipelines: Record<string, { use: (h: unknown) => void }>;
  config: { extensions?: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  session: { append: ReturnType<typeof vi.fn>; transcriptPath?: string };
  extensions: { register: ReturnType<typeof vi.fn> };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  onConfigChange: ReturnType<typeof vi.fn>;
  mailbox?: {
    send: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  };
  llm?: { complete: ReturnType<typeof vi.fn> };
}

function createMockAPI(
  opts: {
    withMailbox?: boolean;
    withTranscript?: boolean;
    extensions?: Record<string, unknown>;
    llm?: { complete: ReturnType<typeof vi.fn> };
  } = {},
): PluginAPI {
  return {
    tools: { register: vi.fn() },
    slashCommands: { register: vi.fn() },
    pipelines: {},
    config: { extensions: opts.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    session: {
      append: vi.fn().mockResolvedValue(undefined),
      ...(opts.withTranscript ? { transcriptPath: '/tmp/test-transcript.jsonl' } : {}),
    },
    extensions: { register: vi.fn(() => ({ unregister: vi.fn() })) },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onPattern: vi.fn(() => () => {}),
    emitCustom: vi.fn(),
    onConfigChange: vi.fn(() => () => {}),
    ...(opts.withMailbox
      ? { mailbox: { send: vi.fn().mockResolvedValue({ id: 'msg-1' }), query: vi.fn() } }
      : {}),
    ...(opts.llm ? { llm: opts.llm } : {}),
  };
}

/** Capture the hook function registered for a given event name. */
function getHook(api: PluginAPI, eventName: string) {
  const call = vi.mocked(api.registerHook).mock.calls.find((c) => c?.[0] === eventName);
  if (!call?.[2]) throw new Error(`hook not registered for event ${eventName}`);
  return call[2] as (input: { cwd?: string; sessionId?: string }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session-recap plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-recap-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('plugin contract', () => {
    it('has name, apiVersion, and setup function', () => {
      expect(sessionRecapPlugin.name).toBe('session-recap');
      expect(typeof sessionRecapPlugin.apiVersion).toBe('string');
      expect(typeof sessionRecapPlugin.setup).toBe('function');
    });

    it('registers one tool and one Stop hook on setup', () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      expect(api.tools.register).toHaveBeenCalledTimes(1);
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { name: string };
      expect(tool.name).toBe('session_recap_status');
      expect(api.registerHook).toHaveBeenCalled();
      const call = vi.mocked(api.registerHook).mock.calls.find((c) => c?.[0] === 'Stop');
      expect(call).toBeDefined();
    });

    it('subscribes to provider.response + tool.* + tool.result events', () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      // onEvent is called for 'provider.response'.
      const onEventCalls = vi.mocked(api.onEvent).mock.calls.map((c) => c[0]);
      expect(onEventCalls).toContain('provider.response');
      // onPattern is called for 'tool.*' and 'tool.result'.
      const onPatternCalls = vi.mocked(api.onPattern).mock.calls.map((c) => c[0]);
      expect(onPatternCalls).toContain('tool.*');
      expect(onPatternCalls).toContain('tool.result');
    });

    it('resolves tool names from Tool objects and legacy event payloads', async () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      const toolHandler = vi
        .mocked(api.onPattern)
        .mock.calls.find((c) => c?.[0] === 'tool.*')?.[1] as
        | ((eventName: string, payload: unknown) => void)
        | undefined;

      expect(toolHandler).toBeDefined();
      expect(() => toolHandler?.('tool.confirm_needed', { tool: { name: 'write' } })).not.toThrow();
      toolHandler?.('tool.executed', { tool: 'read' });
      toolHandler?.('tool.completed', { name: 'edit' });
      toolHandler?.('tool.fallback', null);

      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        metrics: { toolCalls: { total: number; top: Array<[string, number]> } };
      };
      expect(status.metrics.toolCalls.total).toBe(4);
      expect(Object.fromEntries(status.metrics.toolCalls.top)).toEqual({
        write: 1,
        read: 1,
        edit: 1,
        'tool.fallback': 1,
      });
    });

    it('configSchema defines enabled, subjectPrefix, includeTranscriptTail, maxBodyChars', () => {
      const schema = sessionRecapPlugin.configSchema as Record<
        string,
        { properties?: Record<string, unknown> }
      >;
      const props = schema.properties;
      expect(props?.enabled).toBeDefined();
      expect(props?.subjectPrefix).toBeDefined();
      expect(props?.includeTranscriptTail).toBeDefined();
      expect(props?.maxBodyChars).toBeDefined();
    });

    it('defaultConfig has safe defaults', () => {
      const defaults = sessionRecapPlugin.defaultConfig as Record<string, unknown>;
      expect(defaults.enabled).toBe(true);
      expect(defaults.subjectPrefix).toBe('session recap: ');
      expect(defaults.includeTranscriptTail).toBe(3);
      expect(defaults.maxBodyChars).toBe(8_000);
    });
  });

  // -------------------------------------------------------------------------
  describe('H1 audit pattern', () => {
    it('teardown clears state and logs the unload line', () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      sessionRecapPlugin.teardown!(api as never);
      expect(api.log.info).toHaveBeenCalledWith(
        expect.stringContaining('session-recap: teardown complete'),
        expect.anything(),
      );
    });

    it('health() returns ok with counter info', async () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      const health = await sessionRecapPlugin.health!();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('0 stop(s)');
    });

    it('setup is idempotent: counters and event listeners reset on re-init', async () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      // Fire a provider.response event through the registered handler.
      const handler = vi
        .mocked(api.onEvent)
        .mock.calls.find((c) => c?.[0] === 'provider.response')?.[1] as
        | ((p: unknown) => void)
        | undefined;
      handler?.({ model: 'gpt-4o', usage: { input_tokens: 100, output_tokens: 50 } });

      sessionRecapPlugin.teardown!(api as never);
      sessionRecapPlugin.setup(api as never);
      const health = await sessionRecapPlugin.health!();
      expect(health.message).toContain('0 token');
    });
  });

  // -------------------------------------------------------------------------
  describe('Stop hook behavior', () => {
    it('gracefully no-ops when api.mailbox is undefined', async () => {
      const api = createMockAPI({ withMailbox: false });
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-1' });
      // Status tool should report mailboxAvailable=false and recapsSkipped=1.
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        mailboxAvailable: boolean;
        counters: { recapsSkipped: number; recapsPublished: number };
      };
      expect(status.mailboxAvailable).toBe(false);
      expect(status.counters.recapsSkipped).toBe(1);
      expect(status.counters.recapsPublished).toBe(0);
    });

    it('publishes a status broadcast with metrics on Stop', async () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      // Simulate activity before Stop: provider response with tokens,
      // and a tool result for git_autocommit success.
      const usageHandler = vi
        .mocked(api.onEvent)
        .mock.calls.find((c) => c?.[0] === 'provider.response')?.[1] as
        | ((p: unknown) => void)
        | undefined;
      usageHandler?.({ model: 'gpt-4o', usage: { input: 100, output: 50 } });
      const toolResultHandler = vi
        .mocked(api.onPattern)
        .mock.calls.find((c) => c?.[0] === 'tool.result')?.[1] as
        | ((_e: string, p: unknown) => void)
        | undefined;
      toolResultHandler?.('tool.result', { tool: 'git_autocommit', isError: false });

      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-42' });

      expect(api.mailbox?.send).toHaveBeenCalledTimes(1);
      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as {
        from: string;
        to: string;
        type: string;
        subject: string;
        body: string;
        priority: string;
      };
      expect(sendArg.from).toBe('plugin:session-recap');
      expect(sendArg.to).toBe('*');
      expect(sendArg.type).toBe('status');
      expect(sendArg.priority).toBe('low');
      expect(sendArg.subject).toContain('sess-42');
      const body = JSON.parse(sendArg.body);
      expect(body.session.id).toBe('sess-42');
      expect(body.tokens.total.input).toBe(100);
      expect(body.tokens.total.output).toBe(50);
      expect(body.commits).toBe(1);
    });

    it('records an error when mailbox.send throws', async () => {
      const api = createMockAPI({ withMailbox: true });
      api.mailbox!.send.mockRejectedValue(new Error('mailbox down'));
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-x' });
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as {
        counters: { recapsErrored: number; recapsPublished: number };
      };
      expect(status.counters.recapsErrored).toBe(1);
      expect(status.counters.recapsPublished).toBe(0);
    });

    it('does not fire when enabled=false', async () => {
      const api = createMockAPI({ withMailbox: true });
      api.config.extensions = { 'session-recap': { enabled: false } };
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-disabled' });
      expect(api.mailbox?.send).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('transcript tail', () => {
    it('reads the last N events from the JSONL transcript', async () => {
      const transcriptPath = path.join(tmpDir, 'session.jsonl');
      const events = [
        { type: 'user', ts: '2026-06-30T10:00:00Z', content: 'first prompt' },
        { type: 'assistant', ts: '2026-06-30T10:00:05Z', content: 'first reply' },
        { type: 'tool_call', ts: '2026-06-30T10:00:06Z', tool: 'read' },
        { type: 'assistant', ts: '2026-06-30T10:00:08Z', content: 'final reply' },
      ];
      await fs.writeFile(
        transcriptPath,
        events.map((e) => JSON.stringify(e)).join('\n') + '\n',
        'utf-8',
      );

      const api = createMockAPI({ withMailbox: true });
      api.session.transcriptPath = transcriptPath;
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-tail' });

      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      const body = JSON.parse(sendArg.body);
      expect(body.transcriptTail).toHaveLength(3);
      expect(body.transcriptTail[2].type).toBe('assistant');
      expect(body.transcriptTail[2].preview).toBe('final reply');
    });

    it('drops an oversized head fragment and returns the trailing JSONL events', async () => {
      const transcriptPath = path.join(tmpDir, 'oversized-session.jsonl');
      const trailingEvents = [
        { type: 'user', ts: '2026-06-30T10:00:00Z', content: 'tail prompt' },
        { type: 'tool_call', ts: '2026-06-30T10:00:01Z', tool: 'read' },
        { type: 'assistant', ts: '2026-06-30T10:00:02Z', content: 'tail reply' },
      ];
      const oversizedEvent = JSON.stringify({
        type: 'assistant',
        content: 'x'.repeat(1024 * 1024 + 1),
      });
      await fs.writeFile(
        transcriptPath,
        `${oversizedEvent}\n${trailingEvents.map((event) => JSON.stringify(event)).join('\n')}\n`,
        'utf-8',
      );

      const api = createMockAPI({ withMailbox: true });
      api.session.transcriptPath = transcriptPath;
      sessionRecapPlugin.setup(api as never);
      await getHook(api, 'Stop')({ cwd: '/tmp', sessionId: 'sess-oversized-tail' });

      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      const body = JSON.parse(sendArg.body);
      expect(body.transcriptTail).toEqual([
        expect.objectContaining({ type: 'user', preview: 'tail prompt' }),
        expect.objectContaining({ type: 'tool_call' }),
        expect.objectContaining({ type: 'assistant', preview: 'tail reply' }),
      ]);
    });

    it('skips transcript tail when transcriptPath is missing', async () => {
      const api = createMockAPI({ withMailbox: true, withTranscript: false });
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-no-tx' });
      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      const body = JSON.parse(sendArg.body);
      expect(body.transcriptTail).toEqual([]);
    });

    it('returns the last n events from a 2 MiB transcript that exceeds the byte budget', async () => {
      const transcriptPath = path.join(tmpDir, 'huge-session.jsonl');
      // Each event ~96 bytes, so ~22_000 events land at ~2 MiB.
      const totalEvents = 22_000;
      const padTo = (i: number) => `event-${i}-${'x'.repeat(50)}`;
      const lines: string[] = [];
      for (let i = 0; i < totalEvents; i++) {
        lines.push(
          JSON.stringify({
            type: i === totalEvents - 1 ? 'assistant' : 'user',
            ts: `2026-06-30T10:${(i % 60).toString().padStart(2, '0')}:00Z`,
            seq: i,
            content: padTo(i),
          }),
        );
      }
      await fs.writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf-8');
      const stat = await fs.stat(transcriptPath);
      // Sanity: the synthetic file is large enough to saturate the 1 MiB
      // read budget so the byte-vs-event alignment heuristic actually
      // has work to do.
      expect(stat.size).toBeGreaterThan(1024 * 1024);

      const api = createMockAPI({ withMailbox: true });
      api.session.transcriptPath = transcriptPath;
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-huge' });

      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      const body = JSON.parse(sendArg.body);
      expect(body.transcriptTail).toHaveLength(3);
      // The most recent event must be preserved — a tail reader whose
      // budget saturates between two events would drop it silently.
      expect(body.transcriptTail[2].type).toBe('assistant');
      expect(body.transcriptTail[2].preview).toContain(`event-${totalEvents - 1}-`);
      expect(body.transcriptTail[1].preview).toContain(`event-${totalEvents - 2}-`);
      expect(body.transcriptTail[0].preview).toContain(`event-${totalEvents - 3}-`);
    });

    it('returns no events from an empty transcript file', async () => {
      const transcriptPath = path.join(tmpDir, 'empty-session.jsonl');
      await fs.writeFile(transcriptPath, '', 'utf-8');

      const api = createMockAPI({ withMailbox: true });
      api.session.transcriptPath = transcriptPath;
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-empty' });

      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      const body = JSON.parse(sendArg.body);
      expect(body.transcriptTail).toEqual([]);
    });

    it('returns no events from a single-byte transcript (trailing newline only)', async () => {
      const transcriptPath = path.join(tmpDir, 'onebyte-session.jsonl');
      await fs.writeFile(transcriptPath, '\n', 'utf-8');

      const api = createMockAPI({ withMailbox: true });
      api.session.transcriptPath = transcriptPath;
      sessionRecapPlugin.setup(api as never);
      const hook = getHook(api, 'Stop');
      await hook({ cwd: '/tmp', sessionId: 'sess-onebyte' });

      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      const body = JSON.parse(sendArg.body);
      expect(body.transcriptTail).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe('status tool', () => {
    function getStatusTool(api: PluginAPI): { execute: () => Promise<unknown> } {
      const call = vi.mocked(api.tools.register).mock.calls[0];
      if (!call?.[0]) throw new Error('status tool not registered');
      return call[0] as { execute: () => Promise<unknown> };
    }

    it('reports config + accumulated metrics', async () => {
      const api = createMockAPI({ withMailbox: true });
      sessionRecapPlugin.setup(api as never);
      const usageHandler = vi
        .mocked(api.onEvent)
        .mock.calls.find((c) => c?.[0] === 'provider.response')?.[1] as
        | ((p: unknown) => void)
        | undefined;
      usageHandler?.({ model: 'gpt-4o', usage: { input: 10, output: 5 } });
      usageHandler?.({ model: 'gpt-4o-mini', usage: { input: 20, output: 8 } });

      const tool = getStatusTool(api);
      const status = (await tool.execute()) as {
        enabled: boolean;
        subjectPrefix: string;
        mailboxAvailable: boolean;
        metrics: { totalInputTokens: number; perModel: Array<{ model: string }> };
      };
      expect(status.enabled).toBe(true);
      expect(status.subjectPrefix).toBe('session recap: ');
      expect(status.mailboxAvailable).toBe(true);
      expect(status.metrics.totalInputTokens).toBe(30);
      expect(status.metrics.perModel).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('AI summary (api.llm)', () => {
    const llmReply = (text: string) => ({
      text,
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      usage: { input: 50, output: 30 },
      stopReason: 'end_turn',
    });

    it('prepends an LLM summary to the recap body when aiSummary is on', async () => {
      const complete = vi
        .fn()
        .mockResolvedValue(llmReply('Refactored the auth module and added tests.'));
      const api = createMockAPI({
        withMailbox: true,
        extensions: { 'session-recap': { aiSummary: true } },
        llm: { complete },
      });
      sessionRecapPlugin.setup(api as never);
      await getHook(api, 'Stop')({ sessionId: 's1', cwd: '/w' });
      expect(complete).toHaveBeenCalledTimes(1);
      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      expect(sendArg.body.startsWith('Refactored the auth module')).toBe(true);
      expect(sendArg.body).toContain('"summary"');
    });

    it('posts the metrics-only recap when the LLM call fails', async () => {
      const complete = vi.fn().mockRejectedValue(new Error('provider down'));
      const api = createMockAPI({
        withMailbox: true,
        extensions: { 'session-recap': { aiSummary: true } },
        llm: { complete },
      });
      sessionRecapPlugin.setup(api as never);
      await getHook(api, 'Stop')({ sessionId: 's1' });
      expect(api.mailbox!.send).toHaveBeenCalledTimes(1);
      const sendArg = vi.mocked(api.mailbox!.send).mock.calls[0]?.[0] as { body: string };
      expect(sendArg.body).not.toContain('Refactored');
    });

    it('does not call the LLM when aiSummary is off', async () => {
      const complete = vi.fn();
      const api = createMockAPI({ withMailbox: true, llm: { complete } });
      sessionRecapPlugin.setup(api as never);
      await getHook(api, 'Stop')({ sessionId: 's1' });
      expect(complete).not.toHaveBeenCalled();
    });

    it('status tool reports aiSummary + llmAvailable', async () => {
      const api = createMockAPI({
        withMailbox: true,
        extensions: { 'session-recap': { aiSummary: true } },
        llm: { complete: vi.fn() },
      });
      sessionRecapPlugin.setup(api as never);
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as {
        execute: () => Promise<unknown>;
      };
      const status = (await tool.execute()) as { aiSummary: boolean; llmAvailable: boolean };
      expect(status.aiSummary).toBe(true);
      expect(status.llmAvailable).toBe(true);
    });
  });
});
