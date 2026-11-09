import { describe, expect, test } from 'bun:test';
import type { Part, ToolState } from '@/lib/opencode/model';
import { createAgentActivity, toolSoundOf } from './agentActivity';

const setup = (wanted = true) => {
  const heard: string[] = [];
  const activity = createAgentActivity({
    signals: {
      turnStartsWanted: () => wanted,
      agentStarted: (sessionId, messageId) => { heard.push(`agent:${sessionId}:${messageId}`); },
      subagentStarted: (sessionId) => { heard.push(`subagent:${sessionId}`); },
    },
  });
  return { activity, heard };
};

const main = { isSubagent: () => false };
const child = { isSubagent: () => true };

describe('agent start sounds', () => {
  test('a main session announces itself with its first output, once', () => {
    const { activity, heard } = setup();
    activity.turnStarted('ses_a', main);
    expect(heard).toEqual([]);
    activity.outputSeen('ses_a', 'msg_1');
    activity.outputSeen('ses_a', 'msg_1');
    expect(heard).toEqual(['agent:ses_a:msg_1']);
  });

  test('the turn is named by the message its first output belongs to', () => {
    const { activity, heard } = setup();
    activity.turnStarted('ses_a', main);
    activity.outputSeen('ses_a', 'msg_1');
    activity.turnStarted('ses_a', main);
    activity.outputSeen('ses_a', 'msg_2');
    expect(heard).toEqual(['agent:ses_a:msg_1', 'agent:ses_a:msg_2']);
  });

  test('output of a session that did not begin a turn here plays nothing', () => {
    const { activity, heard } = setup();
    activity.outputSeen('ses_a', 'msg_1');
    activity.turnStarted('ses_a', main);
    activity.outputSeen('ses_other', 'msg_1');
    expect(heard).toEqual([]);
  });

  test('a subagent announces itself at once and never again with its output', () => {
    const { activity, heard } = setup();
    activity.turnStarted('ses_child', child);
    activity.outputSeen('ses_child', 'msg_1');
    expect(heard).toEqual(['subagent:ses_child']);
  });

  test('a turn that ends before any output plays nothing, and the next turn starts clean', () => {
    const { activity, heard } = setup();
    activity.turnStarted('ses_a', main);
    activity.turnEnded('ses_a');
    activity.outputSeen('ses_a', 'msg_1');
    expect(heard).toEqual([]);
    activity.turnStarted('ses_a', main);
    activity.outputSeen('ses_a', 'msg_1');
    expect(heard).toEqual(['agent:ses_a:msg_1']);
  });

  test('keeps nothing and never asks about subagents while no start sound is wanted', () => {
    const { activity, heard } = setup(false);
    let asked = 0;
    activity.turnStarted('ses_a', { isSubagent: () => { asked += 1; return false; } });
    activity.outputSeen('ses_a', 'msg_1');
    expect(asked).toBe(0);
    expect(heard).toEqual([]);
  });

  test('a runtime switch forgets the turns that waited', () => {
    const { activity, heard } = setup();
    activity.turnStarted('ses_a', main);
    activity.reset();
    activity.outputSeen('ses_a', 'msg_1');
    expect(heard).toEqual([]);
  });

  test('turns that never produce output stay bounded', () => {
    const { activity, heard } = setup();
    for (let index = 0; index < 150; index += 1) activity.turnStarted(`ses_${index}`, main);
    activity.outputSeen('ses_0', 'msg_1');
    activity.outputSeen('ses_149', 'msg_1');
    expect(heard).toEqual(['agent:ses_149:msg_1']);
  });
});

const stateOf = (status: ToolState['status']): ToolState => {
  switch (status) {
    case 'pending': return { status, input: {}, raw: '' };
    case 'running': return { status, input: {}, time: { start: 1 } };
    case 'completed': return { status, input: {}, output: '', time: { start: 1, end: 2 } };
    case 'error': return { status, input: {}, error: 'failed', time: { start: 1, end: 2 } };
  }
};

const toolPart = (tool: string, status: ToolState['status']): Part => (
  { id: 'part_1', messageID: 'msg_1', sessionID: 'ses_a', type: 'tool', tool, callID: 'call_1', state: stateOf(status) }
);

describe('toolSoundOf', () => {
  test('a call that begins running ticks, whether or not it was seen pending', () => {
    expect(toolSoundOf(undefined, toolPart('read', 'running'))).toBe('toolTick');
    expect(toolSoundOf(toolPart('read', 'pending'), toolPart('read', 'running'))).toBe('toolTick');
  });

  test('a call that finishes changing a file makes the edit sound', () => {
    for (const tool of ['edit', 'write', 'patch', 'opencode.edit']) {
      expect(toolSoundOf(toolPart(tool, 'running'), toolPart(tool, 'completed'))).toBe('fileEdit');
    }
  });

  test('a call that reads, searches or fails is silent when it finishes', () => {
    expect(toolSoundOf(toolPart('read', 'running'), toolPart('read', 'completed'))).toBeNull();
    expect(toolSoundOf(toolPart('shell', 'running'), toolPart('shell', 'completed'))).toBeNull();
    expect(toolSoundOf(toolPart('edit', 'running'), toolPart('edit', 'error'))).toBeNull();
  });

  test('a state the part already had, and parts that are no tool call, are silent', () => {
    expect(toolSoundOf(toolPart('edit', 'running'), toolPart('edit', 'running'))).toBeNull();
    expect(toolSoundOf(toolPart('edit', 'completed'), toolPart('edit', 'completed'))).toBeNull();
    const text: Part = { id: 'p', messageID: 'm', sessionID: 's', type: 'text', text: 'hi' };
    expect(toolSoundOf(undefined, text)).toBeNull();
  });
});
