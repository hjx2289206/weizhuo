import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { phonePlayLayout, type PhonePlayPosition } from './phonePlayLayout';

export function usePhonePlayLayout(board: Ref<HTMLElement | null>, seatCount: Readonly<Ref<number>>) {
  const size = ref({ width: 640, height: 140 });
  let observer: ResizeObserver | null = null;
  watch(board, element => {
    observer?.disconnect();
    if (!element) return;
    const measure = () => { size.value = { width: element.clientWidth, height: element.clientHeight }; };
    measure();
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }, { flush: 'post' });
  onScopeDispose(() => observer?.disconnect());
  return (position: PhonePlayPosition, count: number) => phonePlayLayout(size.value, position, count, seatCount.value);
}
