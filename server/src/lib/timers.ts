/** Let Node exit even if this timer is pending. No-op in browsers, where the web demo runs this code. */
export function unref<T>(timer: T): T {
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}
