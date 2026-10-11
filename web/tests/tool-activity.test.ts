import { describe, expect, it } from 'vitest';
import { updateTools, toolPresentation } from '../src/chat/toolActivity';
describe('tool activity', () => {
  it('tracks overlapping calls and ignores replayed starts after completion', () => {
    let state = updateTools(undefined, { type: 'tool.start', tool_id: 'a', turn_id: 't', name: 'web_search' });
    state = updateTools(state, { type: 'tool.start', tool_id: 'b', turn_id: 't', name: 'read_file' });
    state = updateTools(state, { type: 'tool.end', tool_id: 'a', turn_id: 't', name: 'web_search' });
    state = updateTools(state, { type: 'tool.start', tool_id: 'a', turn_id: 't', name: 'web_search' });
    expect(state.active.map(t => t.name)).toEqual(['read_file']);
  });
  it('does not expose raw arguments in unknown tool descriptions', () => {
    expect(toolPresentation('terminal').label).toBe('Running a command');
    expect(toolPresentation('read_file').label).toBe('Reading a file');
    expect(toolPresentation('/private/secret?token=abc').label).toBe('Using a tool');
  });
});
