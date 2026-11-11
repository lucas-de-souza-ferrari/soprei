import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  HANDOFF_DEFAULT_REPLY,
  type LlmGenerateInput,
} from '../../../application/ports/llm-provider.js';
import { ExternalServiceError } from '../../../shared/errors/index.js';
import { FakeAnthropicApi, textMessage } from '../../../test-support/fake-anthropic-api.js';
import {
  AnthropicLlmProvider,
  HANDOFF_SYSTEM_INSTRUCTION,
  HANDOFF_TOOL_NAME,
} from './anthropic-llm.provider.js';

// Spec 030: a ferramenta de sinal "atendimento humano" no provedor Anthropic.

const fake = new FakeAnthropicApi();
before(async () => {
  await fake.start();
});
after(async () => {
  await fake.stop();
});
afterEach(() => {
  fake.reset();
});

function makeProvider(): AnthropicLlmProvider {
  return new AnthropicLlmProvider({
    apiKey: 'chave-de-mentira-ANTHROPIC-0123456789',
    baseUrl: fake.baseUrl,
    model: 'claude-haiku-5-5',
    effort: 'low',
    maxOutputTokens: 1024,
    maxRetries: 0,
    timeoutMs: 5_000,
  });
}

const input = (overrides: Partial<LlmGenerateInput> = {}): LlmGenerateInput => ({
  systemPrompt: 'Persona X.\n\nResponda curto.',
  history: [{ role: 'user', content: 'oi' }],
  userMessage: 'Quero falar com uma pessoa',
  ...overrides,
});

function body(index = 0): Record<string, unknown> {
  const request = fake.requests[index];
  assert.ok(request?.body, 'havia um pedido com corpo JSON');
  return request.body;
}

const toolUse = (motivo: unknown, name = HANDOFF_TOOL_NAME) =>
  ({
    type: 'tool_use',
    id: 'toolu_01',
    name,
    input: motivo === undefined ? {} : { motivo },
  }) as const;

describe('AnthropicLlmProvider: pedido com e sem allowHandoff', () => {
  it('sem allowHandoff o corpo é idêntico ao de allowHandoff: false e não tem tools', async () => {
    const provider = makeProvider();
    await provider.generate(input());
    await provider.generate(input({ allowHandoff: false }));
    assert.deepEqual(body(0), body(1));
    assert.ok(!('tools' in body(0)));
    assert.equal(body(0)['system'], 'Persona X.\n\nResponda curto.');
  });

  it('com allowHandoff envia só a ferramenta de sinal, strict, sem tool_choice, e a linha fixa no fim do system', async () => {
    await makeProvider().generate(input({ allowHandoff: true }));
    const sent = body();
    assert.ok(!('tool_choice' in sent), 'não deve forçar a ferramenta');
    const tools = sent['tools'] as Record<string, unknown>[];
    assert.equal(tools.length, 1);
    const [tool] = tools;
    assert.ok(tool);
    assert.equal(tool['name'], HANDOFF_TOOL_NAME);
    assert.equal(tool['strict'], true);
    const schema = tool['input_schema'] as {
      type: string;
      properties: Record<string, { type: string; enum: string[] }>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.equal(schema.type, 'object');
    assert.deepEqual(Object.keys(schema.properties), ['motivo']);
    const motivo = schema.properties['motivo'];
    assert.ok(motivo);
    assert.equal(motivo.type, 'string');
    assert.deepEqual(motivo.enum, [
      'CONTACT_REQUESTED',
      'CANNOT_HELP',
      'COMPLAINT',
      'SENSITIVE',
      'OTHER',
    ]);
    assert.deepEqual(schema.required, ['motivo']);
    assert.equal(schema.additionalProperties, false);
    assert.equal(sent['system'], `Persona X.\n\nResponda curto.\n\n${HANDOFF_SYSTEM_INSTRUCTION}`);
    // O texto do contato continua só no turno `user`.
    assert.ok(!sent['system'].includes('Quero falar com uma pessoa'));
    const messages = sent['messages'] as { role: string; content: string }[];
    assert.deepEqual(messages.at(-1), { role: 'user', content: 'Quero falar com uma pessoa' });
  });
});

describe('AnthropicLlmProvider: resposta com a ferramenta', () => {
  it('texto e tool_use: devolve o texto e o motivo', async () => {
    fake.script(
      textMessage('', {
        content: [{ type: 'text', text: 'Já avisei a equipe.' }, toolUse('CONTACT_REQUESTED')],
        stopReason: 'tool_use',
      }),
    );
    const result = await makeProvider().generate(input({ allowHandoff: true }));
    assert.ok(result.ok);
    assert.equal(result.value.text, 'Já avisei a equipe.');
    assert.deepEqual(result.value.handoff, { reason: 'CONTACT_REQUESTED' });
    assert.ok(result.value.usage);
  });

  it('só tool_use, sem texto: devolve o texto constante', async () => {
    fake.script(textMessage('', { content: [toolUse('COMPLAINT')], stopReason: 'tool_use' }));
    const result = await makeProvider().generate(input({ allowHandoff: true }));
    assert.ok(result.ok);
    assert.equal(result.value.text, HANDOFF_DEFAULT_REPLY);
    assert.deepEqual(result.value.handoff, { reason: 'COMPLAINT' });
  });

  for (const [label, motivo] of [
    ['fora da lista', 'URGENTE_DEMAIS'],
    ['ausente', undefined],
    ['de outro tipo', 7],
  ] as const) {
    it(`motivo ${label} vira OTHER`, async () => {
      fake.script(
        textMessage('', {
          content: [{ type: 'text', text: 'Ok.' }, toolUse(motivo)],
          stopReason: 'tool_use',
        }),
      );
      const result = await makeProvider().generate(input({ allowHandoff: true }));
      assert.ok(result.ok);
      assert.deepEqual(result.value.handoff, { reason: 'OTHER' });
    });
  }

  it('duas chamadas da ferramenta contam como uma, com o primeiro motivo válido', async () => {
    fake.script(
      textMessage('', {
        content: [
          { type: 'text', text: 'Ok.' },
          toolUse('???'),
          { ...toolUse('SENSITIVE'), id: 'toolu_02' },
        ],
        stopReason: 'tool_use',
      }),
    );
    const result = await makeProvider().generate(input({ allowHandoff: true }));
    assert.ok(result.ok);
    assert.deepEqual(result.value.handoff, { reason: 'SENSITIVE' });
  });

  it('end_turn sem ferramenta: resposta normal, sem handoff', async () => {
    fake.script(textMessage('Atendo sim.'));
    const result = await makeProvider().generate(input({ allowHandoff: true }));
    assert.ok(result.ok);
    assert.equal(result.value.text, 'Atendo sim.');
    assert.equal(result.value.handoff, undefined);
  });

  it('ferramenta de outro nome vira erro (unexpected_tool_use)', async () => {
    fake.script(
      textMessage('', {
        content: [{ type: 'text', text: 'x' }, toolUse('OTHER', 'apagar_tudo')],
        stopReason: 'tool_use',
      }),
    );
    const result = await makeProvider().generate(input({ allowHandoff: true }));
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof ExternalServiceError);
    assert.equal(result.error.context['errorType'], 'unexpected_tool_use');
  });

  it('tool_use sem allowHandoff vira erro (o provedor não ofereceu ferramenta)', async () => {
    fake.script(
      textMessage('', {
        content: [{ type: 'text', text: 'x' }, toolUse('OTHER')],
        stopReason: 'tool_use',
      }),
    );
    const result = await makeProvider().generate(input());
    assert.equal(result.ok, false);
    assert.equal(result.error.context['errorType'], 'unexpected_tool_use');
  });

  it('o erro não carrega o input da ferramenta nem o texto do contato', async () => {
    fake.script(
      textMessage('', {
        content: [toolUse('SEGREDO-DO-MOTIVO', 'outra_ferramenta')],
        stopReason: 'tool_use',
      }),
    );
    const result = await makeProvider().generate(input({ allowHandoff: true }));
    assert.equal(result.ok, false);
    const dump = JSON.stringify({ message: result.error.message, context: result.error.context });
    assert.ok(!dump.includes('SEGREDO-DO-MOTIVO'));
    assert.ok(!dump.includes('Quero falar com uma pessoa'));
  });
});
