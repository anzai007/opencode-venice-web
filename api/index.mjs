import { createServer } from '../src/lib/server.mjs'

export const config = {
  api: {
    bodyParser: false,
  },
}

const handler = createServer()

export default async function (req, res) {
  return await handler(req, res)
}
