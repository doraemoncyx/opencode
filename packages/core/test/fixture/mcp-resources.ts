import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListResourcesRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "resources", version: "1.0.0" }, { capabilities: { resources: {} } })

server.setRequestHandler(ListResourcesRequestSchema, () =>
  Promise.resolve({
    resources: [{ uri: "docs://readme", name: "readme", mimeType: "text/plain" }],
  }),
)

await server.connect(new StdioServerTransport())
