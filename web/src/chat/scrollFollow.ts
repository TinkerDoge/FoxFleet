// Whether a chat sticks to the newest message, and what the "go to bottom" control says. Pure logic: the web ChatView and Android's ScrollFollow.kt
// implement the same rules, and contract/scroll-follow.vectors.json is run against both.
export const PIN = 80; // within this many px of the bottom the view is pinned: new content keeps it at the bottom
export const FAR = 120; // further than this the "go to bottom" button shows; in between the previous state holds (no flicker)

export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type FollowEvent =
  | { e: 'scroll'; distance: number }
  | { e: 'content'; count: number; streaming: boolean; lastRole?: Role | null; prepending?: boolean; loading?: boolean }
  | { e: 'jump' }
  | { e: 'reset' };
export type Follow = { pinned: boolean; far: boolean; unread: number; action: 'none' | 'scroll' };

export function createFollow() {
  let pinned = true, far = false, unread = 0, count = 0, streaming = false, ready = false, counted = false; // counted: the reply now streaming already added to `unread`
  const snap = (action: Follow['action']): Follow => ({ pinned, far, unread, action });
  const api = {
    /** The user scrolled (or the layout moved them): distance = px between the viewport's bottom and the end of the content. */
    scroll(distance: number): Follow {
      if (distance <= PIN) { pinned = true; far = false; unread = 0; } else { pinned = false; if (distance > FAR) far = true; }
      return snap('none');
    },
    /** The message list or the streaming reply changed. `prepending` = older history was added at the top; `loading` = history is still loading. */
    content(o: { count: number; streaming: boolean; lastRole?: Role | null; prepending?: boolean; loading?: boolean }): Follow {
      if (o.loading) { count = o.count; streaming = o.streaming; return snap('none'); }
      if (!ready) { ready = true; pinned = true; far = false; unread = 0; count = o.count; streaming = o.streaming; return snap('scroll'); } // a chat just opened: start at the bottom
      if (o.prepending) { count = o.count; streaming = o.streaming; return snap('none'); } // older messages above: the caller keeps the scroll position
      const added = Math.max(0, o.count - count), startedStreaming = o.streaming && !streaming, committed = streaming && !o.streaming && added > 0;
      if (added > 0 && o.lastRole === 'user') { pinned = true; far = false; unread = 0; } // your own message always takes you to the bottom
      else if (!pinned) {
        const fromStream = committed && counted ? 1 : 0; // a streamed reply counts once: when it starts, or when it is committed if you scrolled away meanwhile
        unread += Math.max(0, added - fromStream) + (startedStreaming && added === 0 ? 1 : 0);
        if (startedStreaming && added === 0) counted = true;
      }
      if (!o.streaming || startedStreaming && pinned) counted = false;
      count = o.count; streaming = o.streaming;
      return snap(pinned ? 'scroll' : 'none');
    },
    /** The button was tapped. */
    jump(): Follow { pinned = true; far = false; unread = 0; return snap('scroll'); },
    /** Another chat was opened. */
    reset(): Follow { pinned = true; far = false; unread = 0; count = 0; streaming = false; ready = false; counted = false; return snap('none'); },
  };
  return api;
}
/** What the control shows: nothing, the round arrow, or the "New message" pill (with a count when there are several). */
export const control = (f: Pick<Follow, 'far' | 'unread' | 'pinned'>): 'none' | 'arrow' | 'pill' => (f.pinned ? 'none' : f.unread > 0 ? 'pill' : f.far ? 'arrow' : 'none');

/** Apply one vector event to a follow controller. */
export function step(f: ReturnType<typeof createFollow>, ev: FollowEvent): Follow {
  switch (ev.e) {
    case 'scroll': return f.scroll(ev.distance);
    case 'content': return f.content(ev);
    case 'jump': return f.jump();
    default: return f.reset();
  }
}
