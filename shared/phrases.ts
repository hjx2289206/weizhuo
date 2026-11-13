// Fixed quick phrases: the only in-room communication channel. There is deliberately no free
// text field, so the server can validate an exact whitelist instead of moderating user content.
export interface QuickPhrase {
  id: string
  emoji: string
  text: string
}

export const QUICK_PHRASES: readonly QuickPhrase[] = [
  { id: 'hello', emoji: '👋', text: '大家好' },
  { id: 'ready', emoji: '👌', text: '准备好了' },
  { id: 'hurry', emoji: '⏳', text: '快点吧' },
  { id: 'nice', emoji: '👍', text: '好牌' },
  { id: 'clever', emoji: '✨', text: '妙啊' },
  { id: 'cannot_beat', emoji: '🙅', text: '要不起' },
  { id: 'steady', emoji: '🧘', text: '稳住' },
  { id: 'cheer', emoji: '🔥', text: '加油' },
  { id: 'good_game', emoji: '🤝', text: '合作愉快' },
  { id: 'again', emoji: '🔁', text: '再来一局' },
  { id: 'thanks', emoji: '🙏', text: '承让了' },
  { id: 'laugh', emoji: '😄', text: '哈哈' },
]

export function quickPhrase(id: unknown): QuickPhrase | null {
  return typeof id === 'string' ? QUICK_PHRASES.find((phrase) => phrase.id === id) ?? null : null
}
