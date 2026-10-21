# Deploying CareCircle

CareCircle's MCP endpoint is **stateless Streamable HTTP**: every `POST /mcp` builds a fresh server for the caller,
so any number of instances can run behind a load balancer with no session affinity.

## Docker

```bash
docker build -t carecircle .
docker run -p 8000:8000 --env-file .env carecircle
```

The image listens on `0.0.0.0:8000` and serves the MCP endpoint at `/mcp`. Set `ALLOWED_HOSTS` to the public host
name(s) so Host-header validation stays on, and `ALLOW_ANONYMOUS=false` so every caller needs a CareCircle token.

## Amazon Bedrock AgentCore Runtime

AgentCore Runtime can host MCP servers. It expects a container serving stateless Streamable HTTP on
`0.0.0.0:8000/mcp`, which is what the Dockerfile produces. Outline:

1. Build an ARM64 image and push it to Amazon ECR:
   `docker buildx build --platform linux/arm64 -t <account>.dkr.ecr.<region>.amazonaws.com/carecircle:latest --push .`
2. Create an AgentCore Runtime with the **MCP** server protocol, pointing at the image.
3. Configure inbound auth (for example a Cognito JWT authorizer) and pass CareCircle settings as environment variables.
4. Give the runtime's IAM role `bedrock:InvokeModel` (for Claude) and `sns:Publish` (for alerts) if you use them.

Check the current AgentCore Runtime documentation for exact console and CLI steps. The demo data store is a JSON file;
for a hosted deployment, swap `src/store.js` for DynamoDB (one item per circle) so state survives restarts.

## Production checklist

```bash
ALLOW_ANONYMOUS=false   # every /mcp and /api call needs a token
DEMO_TOKENS=false       # no fixed demo tokens
PUBLIC_URL=https://carecircle.example.com
ALLOWED_HOSTS=carecircle.example.com
RING_WEBHOOK_SECRET=<your Ring app's HMAC key>
```

Change the demo PINs in the data file (or replace the consent page's PIN check with your identity provider).

## Exposing the endpoint to Alexa+ or another MCP client

1. Serve it over HTTPS (AgentCore, an AWS load balancer, or a tunnel for testing) and set `PUBLIC_URL` to that address.
2. Register `https://<host>/mcp` as a Streamable HTTP MCP server.
3. The client discovers OAuth from the `401` response (`WWW-Authenticate: Bearer resource_metadata=…`), registers
   itself, and sends the user to CareCircle's consent page. There, they choose who the assistant is for and enter that
   person's PIN, and the assistant receives a token bound to that person and role.

## Ring webhooks

Register `https://<host>/webhooks/ring` as the Webhook URL in the Ring Developer Portal and set `RING_WEBHOOK_SECRET`
to your app's HMAC signing key. Map your device IDs to names in the `ringDevices` list of the store.
