import './phone/styles.css'
import { Controller } from './glasses/controller'
import { Api } from './lib/api'
import { Glasses } from './lib/glasses'
import { mountPhoneUi } from './phone/ui'

const KEY_URL = 'tape.serverUrl'
const KEY_TOKEN = 'tape.token'

async function main() {
  const glasses = await Glasses.connect()
  const baseUrl = (await glasses.storageGet(KEY_URL)) || (import.meta.env.VITE_SERVER_URL as string | undefined) || ''
  const token = (await glasses.storageGet(KEY_TOKEN)) || (import.meta.env.VITE_APP_TOKEN as string | undefined) || ''
  const api = new Api({ baseUrl: baseUrl.replace(/\/+$/, ''), token })
  const controller = new Controller(glasses, api)

  mountPhoneUi(document.querySelector<HTMLElement>('#app')!, {
    glasses,
    controller,
    api,
    saveConfig: async (url, tok) => {
      api.setConfig({ baseUrl: url, token: tok })
      await glasses.storageSet(KEY_URL, api.config.baseUrl)
      await glasses.storageSet(KEY_TOKEN, api.config.token)
    },
  })

  await controller.start()
  window.addEventListener('beforeunload', () => {
    controller.dispose()
    glasses.dispose()
  })
}

void main()
