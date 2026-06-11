import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGatewayMcpHttpApp } from './http.js';
import type { ToolManifest } from './client.js';

const manifest: ToolManifest = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  generatedAt: new Date().toISOString(),
  tools: [
    {
      name: 'search_product',
      kind: 'search',
      description: [
        'Busca productos.',
        'When to use: cuando el cliente busca catálogo.',
        'Never use for: modificar datos.',
        'Success criteria: ok=true con resultados.',
        'Fallback: pedir más detalle.',
      ].join('\n'),
      entity: 'product',
      sourceIds: ['22222222-2222-4222-8222-222222222222'],
      mappingVersion: 1,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Texto libre' },
          color: { type: 'string', enum: ['rojo', 'azul'] },
        },
      },
    },
  ],
};

describe('MCP HTTP compatibility', () => {
  it('exposes /health without auth', async () => {
    const app = createGatewayMcpHttpApp({
      GATEWAY_URL: 'http://127.0.0.1:3999',
      MCP_PORT: 3100,
    });
    const response = await request(app).get('/health').expect(200);
    expect(response.body).toEqual({ ok: true, service: 'data-gateway-mcp' });
  });
  let gatewayServer: ReturnType<import('node:http').Server['listen']>;
  let gatewayUrl: string;

  beforeAll(async () => {
    const gateway = express();
    gateway.use(express.json());
    gateway.get('/tools', (req, res) => {
      if (req.header('authorization') !== 'Bearer dgw_test') {
        res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid API key' } });
        return;
      }
      res.json(manifest);
    });
    gateway.post('/tools/:name/invoke', (req, res) => {
      res.json({
        kind: 'search',
        results: [{ id: 'record_1', data: { sku: 'SKU-001', color: req.body.args.color } }],
      });
    });

    await new Promise<void>((resolve) => {
      gatewayServer = gateway.listen(0, () => resolve());
    });
    const address = gatewayServer.address();
    if (!address || typeof address === 'string') throw new Error('Gateway test server did not bind');
    gatewayUrl = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      gatewayServer.close((error?: Error) => (error ? reject(error) : resolve()));
    });
  });

  it('handles initialize, tools/list, tools/call and DELETE like Whaapy', async () => {
    const app = createGatewayMcpHttpApp({ GATEWAY_URL: gatewayUrl, MCP_PORT: 3100 });

    const initResponse = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer dgw_test')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('MCP-Protocol-Version', '2025-06-18')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'whaapy-mcp-client', version: '1.0.0' },
        },
      })
      .expect(200);

    const sessionId = initResponse.header['mcp-session-id'] as string | undefined;
    expect(sessionId).toBeTruthy();
    expect(initResponse.body.result.protocolVersion).toBe('2025-06-18');
    expect(initResponse.body.result.capabilities.tools).toMatchObject({});

    await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer dgw_test')
      .set('Mcp-Session-Id', sessionId!)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      .expect(202);

    const listResponse = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer dgw_test')
      .set('Mcp-Session-Id', sessionId!)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);
    expect(listResponse.body.result.tools[0]).toMatchObject({
      name: 'search_product',
      inputSchema: { type: 'object', additionalProperties: false },
    });

    const callResponse = await request(app)
      .post('/mcp')
      .set('Authorization', 'Bearer dgw_test')
      .set('Mcp-Session-Id', sessionId!)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_product', arguments: { query: 'camiseta', color: 'rojo' } },
      })
      .expect(200);
    const envelope = JSON.parse(callResponse.body.result.content[0].text) as { ok: boolean; data: unknown };
    expect(envelope).toMatchObject({
      ok: true,
      status: 'success',
      toolName: 'search_product',
      safety: 'read_only',
    });

    await request(app)
      .delete('/mcp')
      .set('Authorization', 'Bearer dgw_test')
      .set('Mcp-Session-Id', sessionId!)
      .expect(200);
  });
});
