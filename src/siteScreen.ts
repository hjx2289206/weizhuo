import { inject, provide, type InjectionKey, type Ref } from 'vue'
import { usePhoneScreen, type PhoneScreenApi } from './usePhoneScreen'
export const SITE_SCREEN: InjectionKey<PhoneScreenApi> = Symbol('site-screen')
export function provideSiteScreen(preferred?: Readonly<Ref<'landscape' | 'portrait'>>): PhoneScreenApi {
  const screen = usePhoneScreen(preferred)
  provide(SITE_SCREEN, screen)
  return screen
}
export function useGameScreen(): PhoneScreenApi { return inject(SITE_SCREEN) ?? usePhoneScreen() }
