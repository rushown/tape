/**
 * fetch with one retry when the connection drops before a response arrives.
 * Local model servers (uvicorn, Ollama) close idle keep-alive sockets after a
 * few seconds; Node may reuse such a socket and get ECONNRESET. Only network
 * failures are retried, never HTTP errors, and only once.
 */
export async function fetchRetry(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError' || (err as Error).name === 'TimeoutError' || init.signal?.aborted
    if (aborted || !(err instanceof TypeError)) throw err
    return fetch(url, init)
  }
}
