#!/usr/bin/env tsx
/**
 * Dogfooding manual: manifest → OpenRouter tool-calling → invoke.
 * Requiere OPENROUTER_API_KEY, GATEWAY_URL y GATEWAY_API_KEY en el entorno.
 * Para validar el loop sin credenciales reales: DOGFOOD_DRY_RUN=true pnpm dogfood
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

type ToolManifest = {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
};

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free';
const DOGFOOD_DRY_RUN = process.env.DOGFOOD_DRY_RUN === 'true';

const QUESTIONS = [
  '¿Hay variantes rojas disponibles?',
  'Busca SKU que contenga SHOP-SKU-0001',
  '¿Está disponible la variante con SKU SHOP-SKU-0001-1?',
];

async function fetchManifest(): Promise<ToolManifest> {
  if (DOGFOOD_DRY_RUN) {
    return {
      tools: [
        {
          name: 'search_variant',
          description: 'Buscar variantes disponibles',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              color: { type: 'string', enum: ['rojo', 'azul', 'negro'] },
              limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
            },
          },
        },
        {
          name: 'check_availability_variant',
          description: 'Verificar disponibilidad por SKU',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sku: { type: 'string' },
            },
            required: ['sku'],
          },
        },
      ],
    };
  }

  const response = await fetch(`${GATEWAY_URL.replace(/\/$/, '')}/tools`, {
    headers: { Authorization: `Bearer ${GATEWAY_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Manifest failed: ${response.status}`);
  return (await response.json()) as ToolManifest;
}

async function invokeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (DOGFOOD_DRY_RUN) {
    return {
      dryRun: true,
      tool: name,
      args,
      result:
        name === 'check_availability_variant'
          ? { available: true, matches: [{ id: 'dry-run-variant', sku: args.sku }] }
          : { results: [{ id: 'dry-run-variant', color: args.color ?? null }] },
    };
  }

  const response = await fetch(
    `${GATEWAY_URL.replace(/\/$/, '')}/tools/${encodeURIComponent(name)}/invoke`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GATEWAY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ args }),
    },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(body));
  return body;
}

function manifestToolsToOpenRouter(manifest: ToolManifest) {
  return manifest.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

async function askModel(
  question: string,
  tools: ReturnType<typeof manifestToolsToOpenRouter>,
): Promise<{ toolName?: string; toolArgs?: Record<string, unknown>; content?: string }> {
  if (DOGFOOD_DRY_RUN) {
    const availabilityTool = tools.find((tool) => tool.function.name === 'check_availability_variant');
    if (question.toLowerCase().includes('sku') && availabilityTool) {
      return {
        toolName: availabilityTool.function.name,
        toolArgs: { sku: 'SHOP-SKU-0001-1' },
      };
    }

    const searchTool = tools.find((tool) => tool.function.name === 'search_variant');
    if (searchTool) {
      return {
        toolName: searchTool.function.name,
        toolArgs: question.toLowerCase().includes('rojas')
          ? { query: 'variantes disponibles', color: 'rojo', limit: 5 }
          : { query: 'SHOP-SKU-0001', limit: 5 },
      };
    }
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [{ role: 'user', content: question }],
      tools,
      tool_choice: 'auto',
    }),
  });
  const body = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = body.choices?.[0]?.message;
  const toolCall = message?.tool_calls?.[0]?.function;
  if (toolCall?.name) {
    return {
      toolName: toolCall.name,
      toolArgs: JSON.parse(toolCall.arguments ?? '{}') as Record<string, unknown>,
    };
  }
  return { content: message?.content ?? '' };
}

async function main(): Promise<void> {
  if (!DOGFOOD_DRY_RUN && (!GATEWAY_API_KEY || !OPENROUTER_API_KEY)) {
    throw new Error('GATEWAY_API_KEY and OPENROUTER_API_KEY are required');
  }

  const manifest = await fetchManifest();
  const tools = manifestToolsToOpenRouter(manifest);
  const notes: string[] = [
    DOGFOOD_DRY_RUN ? '- Modo: dry-run determinístico' : `- Modo: OpenRouter (${LLM_MODEL})`,
  ];

  for (const question of QUESTIONS) {
    console.log(`\nQ: ${question}`);
    const model = await askModel(question, tools);
    if (!model.toolName) {
      console.log(`A (sin tool): ${model.content ?? '(vacío)'}`);
      notes.push(`- Pregunta sin tool call: "${question}" → ${model.content ?? '(vacío)'}`);
      continue;
    }

    console.log(`Tool: ${model.toolName}(${JSON.stringify(model.toolArgs)})`);
    const result = await invokeTool(model.toolName, model.toolArgs ?? {});
    console.log(`Resultado: ${JSON.stringify(result).slice(0, 500)}`);
    notes.push(`- OK: "${question}" → ${model.toolName}`);
  }

  const docsDir = path.resolve('docs');
  if (!existsSync(docsDir)) mkdirSync(docsDir);
  const notesPath = path.join(docsDir, 'DOGFOODING_NOTES.md');
  const header = existsSync(notesPath) ? readFileSync(notesPath, 'utf8') + '\n\n' : '';
  writeFileSync(notesPath, `${header}## Run ${new Date().toISOString()}\n\n${notes.join('\n')}\n`);
  console.log(`\nNotas escritas en ${notesPath}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
