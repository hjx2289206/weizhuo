import { ref } from 'vue'
/** Keeps live room dialogs from taking focus while the independent teaching view is on top. */
export const teachingVisible = ref(false)
